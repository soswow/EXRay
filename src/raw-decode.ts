/**
 * Camera RAW decoding via LibRaw (WebAssembly).
 *
 * LibRaw only unpacks the file. Black subtraction, normalization, white balance, demosaicing and
 * the camera → Rec.709 matrix are done here, so every step is known and the original integer
 * sensor values stay available for the pixel probe and the mosaic view.
 */
import wasmUrl from '@colorhythm/libraw-wasm/libraw.wasm?url';
import type { LibRaw as LibRawClass } from '@colorhythm/libraw-wasm';
import { demosaic, lcm, maskedNoise, minimalPeriod, orientCell, orientPixels, patternName, photositeHist, type MaskedNoise } from './raw-process';
import type { ChannelHistogram, ExrAttribute, RawImage, RawModeId } from './types';

type LibRawModule = typeof import('@colorhythm/libraw-wasm');
let libPromise: Promise<LibRawModule> | null = null;

/** Loads LibRaw on first use, so opening EXR files never downloads it. */
function loadLibRaw(): Promise<LibRawModule> {
  return (libPromise ??= import('@colorhythm/libraw-wasm').then(async (m) => {
    await m.LibRaw.initialize(fetch(wasmUrl));
    return m;
  }));
}

/** Everything read from the file, kept so switching modes doesn't unpack again. */
interface Unpacked {
  key: string;
  width: number;
  height: number;
  kind: 'cfa' | 'linear';
  channels: 1 | 3;
  dn: Uint16Array;
  cellW: number;
  cellH: number;
  /** 0 R, 1 G, 2 B, 3 second G (cfa); [0, 1, 2] for linear. */
  cellColor: number[];
  cellBlack: number[];
  white: number;
  linearMax: number;
  /** White balance multipliers for R, G, B, normalized to G = 1. */
  wb: [number, number, number];
  /** Camera RGB (white balanced) → linear sRGB/Rec.709, row-major 3×3. */
  rgbCam: number[];
  pattern: string;
  make: string;
  model: string;
  attributes: ExrAttribute[];
  notes: string[];
  noise: MaskedNoise | null;
}

let cache: Unpacked | null = null;

export interface RawDecoded {
  width: number;
  height: number;
  /** RGBA float32, rows bottom-up. */
  data: Float32Array;
  raw: RawImage;
  lumaWeights: [number, number, number];
  /** R/G/B histograms of the photosites themselves (before interpolation), when they apply. */
  photositeHistograms?: { R: ChannelHistogram; G: ChannelHistogram; B: ChannelHistogram };
}

const REC709: [number, number, number] = [0.2126, 0.7152, 0.0722];

/** True for files that start like an OpenEXR file. */
export function isExr(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  return new DataView(buffer).getUint32(0, true) === 20000630;
}

export async function decodeRaw(buffer: ArrayBuffer, name: string, mode: RawModeId): Promise<RawDecoded> {
  const key = `${name}:${buffer.byteLength}`;
  let unpackMs = 0;
  if (cache?.key !== key) {
    cache = null; // free the previous file before unpacking the next
    const t0 = performance.now();
    cache = await unpack(buffer, key);
    unpackMs = performance.now() - t0;
  }
  const t1 = performance.now();
  const r = develop(cache, mode);
  r.raw.timings = { unpackMs, developMs: performance.now() - t1 };
  return r;
}

// ---------- unpacking ----------

async function unpack(buffer: ArrayBuffer, key: string): Promise<Unpacked> {
  const { LibRaw } = await loadLibRaw();
  const lr = new LibRaw();
  await lr.waitUntilReady();
  try {
    lr.open(buffer);
    lr.unpack();
    return read(lr, key);
  } finally {
    lr.dispose();
  }
}

function read(lr: LibRawClass, key: string): Unpacked {
  const ip = lr.getIParams();
  const other = lr.getImgOther();
  const rawW = lr.getRawWidth(), rawH = lr.getRawHeight();
  const width = lr.getIWidth(), height = lr.getIHeight();
  const left = lr.getLeftMargin(), top = lr.getTopMargin();
  const maximum = lr.getColorMaximum();
  const black = lr.getBlack();
  const cblack = Array.from({ length: 6 }, (_, i) => lr.getCblack(i));
  const notes: string[] = [];

  // White balance: as-shot multipliers, else daylight; normalized to green.
  let mul = [0, 1, 2].map((i) => lr.getCamMul(i));
  if (!(mul[0] > 0 && mul[1] > 0 && mul[2] > 0)) mul = [0, 1, 2].map((i) => lr.getPreMul(i));
  if (!(mul[0] > 0 && mul[1] > 0 && mul[2] > 0)) mul = [1, 1, 1];
  const wb: [number, number, number] = [mul[0] / mul[1], 1, mul[2] / mul[1]];
  const rgbCam: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rgbCam.push(lr.getRgbCam(i, j));

  const linearMax = Math.max(0, ...[0, 1, 2, 3].map((i) => lr.getLinearMax(i)));
  const filters = ip.filters >>> 0;
  const make = ip.make.trim(), model = ip.model.trim();

  const attributes: ExrAttribute[] = [];
  const attr = (n: string, v: string | number) => attributes.push({ name: n, type: '', display: String(v) });
  attr('Camera', `${make} ${model}`.trim());
  if (other.iso_speed) attr('ISO', Math.round(other.iso_speed));
  if (other.shutter) attr('Shutter', other.shutter >= 1 ? `${other.shutter} s` : `1/${Math.round(1 / other.shutter)} s`);
  if (other.aperture) attr('Aperture', `f/${other.aperture.toFixed(1)}`);
  if (other.focal_len) attr('Focal length', `${Number(other.focal_len.toFixed(1))} mm`);
  try {
    const lens = lr.getLensInfo().Lens;
    if (lens) attr('Lens', lens);
  } catch { /* lens info is optional */ }
  if (other.timestamp) attr('Taken', new Date(Number(other.timestamp) * 1000).toISOString().replace('T', ' ').slice(0, 19));
  if (ip.dng_version) attr('DNG version', [24, 16, 8, 0].map((s) => (ip.dng_version >>> s) & 255).join('.'));
  if (ip.software) attr('Software', ip.software);
  attr('Unpacker', lr.unpackFunctionName());
  attr('Raw size', `${rawW} × ${rawH}`);
  attr('Visible area', `${width} × ${height} at ${left},${top}`);
  attr('Black', `${black}${cblack.slice(0, 4).some((c) => c) ? ` + per-color ${cblack.slice(0, 4).join('/')}` : ''}${cblack[4] && cblack[5] ? ` + ${cblack[4]}×${cblack[5]} pattern` : ''}`);
  attr('White (maximum)', maximum);
  if (linearMax) attr('Linear max', linearMax);
  attr('As-shot WB', mul.map((m) => m.toFixed(3)).join(' / '));
  attr('rgb_cam', [0, 1, 2].map((i) => rgbCam.slice(i * 3, i * 3 + 3).map((v) => v.toFixed(3)).join(' ')).join('  |  '));
  const flip = lr.getFlip();
  if (flip) attr('Orientation', { 3: 'rotated 180°', 5: 'rotated 90° CCW', 6: 'rotated 90° CW' }[flip] ?? `flip ${flip}`);

  const common = { key, linearMax, wb, rgbCam, make, model, attributes, notes };
  const rotated = flip === 5 || flip === 6;

  const raw = filters && !ip.is_foveon ? lr.getRawImage() : null;
  const oddLayout = width > rawW - left || height > rawH - top || left < 0 || top < 0;
  const fourColor = ip.colors === 4 && ip.cdesc !== 'RGBG';

  if (raw && !oddLayout && !fourColor) {
    // The repeating cell must cover both the color pattern and any black-level pattern.
    const [pw, ph] = filters === 9 ? [6, 6] : filters < 1000 ? [16, 16] : [2, 8];
    const cw = lcm(pw, cblack[4] || 1), ch = lcm(ph, cblack[5] || 1);
    const blackAt = (x: number, y: number) => {
      const c = lr.color(y, x);
      const pat = cblack[4] && cblack[5] ? lr.getCblack(6 + (y % cblack[4]) * cblack[5] + (x % cblack[5])) : 0;
      return black + cblack[Math.min(c, 3)] + pat;
    };
    const { w: cellW, h: cellH } = minimalPeriod(cw, ch, (x, y) => `${lr.color(y, x)}:${blackAt(x, y)}`);
    const cellColor: number[] = [], cellBlack: number[] = [];
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        cellColor.push(lr.color(y, x));
        cellBlack.push(blackAt(x, y));
      }
    }

    // Read noise from the masked border, before it is cropped away.
    const cellIndex = (x: number, y: number) => (((y % cellH) + cellH) % cellH) * cellW + (((x % cellW) + cellW) % cellW);
    const noise = maskedNoise(raw, rawW, rawH, left, top, cellIndex, cellBlack);

    // Crop the visible area out of the full sensor readout, then apply the orientation.
    let dn = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) dn.set(raw.subarray((y + top) * rawW + left, (y + top) * rawW + left + width), y * width);
    dn = orientPixels(dn, width, height, 1, flip);
    const oc = orientCell(cellColor.map((c, i) => [c, cellBlack[i]] as const), cellW, cellH, width, height, flip);
    return {
      ...common,
      width: rotated ? height : width,
      height: rotated ? width : height,
      kind: 'cfa',
      channels: 1,
      dn,
      cellW: oc.cw,
      cellH: oc.ch,
      cellColor: oc.cell.map((c) => c[0]),
      cellBlack: oc.cell.map((c) => c[1]),
      white: maximum,
      pattern: patternName(cellColor, cellW, cellH, filters === 9),
      noise,
    };
  }

  // Already demosaiced in the file (linear DNG, sRAW, Foveon).
  const c4 = lr.getColor4Image(), c3 = c4 ? null : lr.getColor3Image();
  if ((c4 || c3) && !oddLayout) {
    const src = (c4 ?? c3)!, n = c4 ? 4 : 3;
    let dn = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const s = ((y + top) * rawW + x + left) * n, d = (y * width + x) * 3;
        dn[d] = src[s];
        dn[d + 1] = src[s + 1];
        dn[d + 2] = src[s + 2];
      }
    }
    dn = orientPixels(dn, width, height, 3, flip);
    notes.push(ip.is_foveon ? 'Foveon sensor: three values per pixel, no mosaic.' : 'This file stores already demosaiced (linear) RGB, so there is no mosaic to show.');
    return {
      ...common,
      width: rotated ? height : width,
      height: rotated ? width : height,
      kind: 'linear',
      channels: 3,
      dn,
      cellW: 3,
      cellH: 1,
      cellColor: [0, 1, 2],
      cellBlack: [0, 1, 2].map((c) => lr.getBlackLevel(c)),
      white: maximum,
      pattern: ip.is_foveon ? 'Foveon' : 'linear RGB',
      noise: null,
    };
  }

  // Unusual layouts (e.g. Fuji SuperCCD): let LibRaw develop to linear 16-bit camera RGB.
  // LibRaw also applies the orientation here.
  for (let i = 0; i < 4; i++) lr.setUserMul(i, 1);
  lr.setOutputColor(0);
  lr.setOutputBps(16);
  lr.setGamma(0, 1);
  lr.setGamma(1, 1);
  lr.setNoAutoBright(1);
  lr.setHighlight(1); // unclipped
  lr.dcrawProcess();
  const img = lr.dcrawMakeMemImage();
  if (img.colors < 3 || img.bits !== 16) throw new Error(`LibRaw produced an unexpected ${img.colors}-channel, ${img.bits}-bit image`);
  const px = new Uint16Array(img.data.buffer, img.data.byteOffset, img.data.byteLength / 2);
  const dn = new Uint16Array(img.width * img.height * 3);
  for (let i = 0, j = 0; j < dn.length; i += img.colors, j += 3) {
    dn[j] = px[i];
    dn[j + 1] = px[i + 1];
    dn[j + 2] = px[i + 2];
  }
  notes.push('Unusual sensor layout: demosaiced by LibRaw, so values are LibRaw output (black subtracted, scaled to 16 bit), not the file\'s raw integers.');
  return {
    ...common,
    width: img.width,
    height: img.height,
    kind: 'linear',
    channels: 3,
    dn,
    cellW: 3,
    cellH: 1,
    cellColor: [0, 1, 2],
    cellBlack: [0, 0, 0],
    white: 65535,
    linearMax: 0,
    pattern: 'demosaiced by LibRaw',
    noise: null,
  };
}

// ---------- developing ----------

function develop(u: Unpacked, mode: RawModeId): RawDecoded {
  const { width: W, height: H } = u;
  const wb: [number, number, number] = mode === 'cam' ? [1, 1, 1] : u.wb;
  const range = (b: number) => Math.max(1, u.white - b);
  const cellScale = u.cellColor.map((c, i) => wb[c === 3 ? 1 : c] / range(u.cellBlack[i]));

  // Luminance weights: Y of the Rec.709 result, expressed on whatever RGB `data` holds.
  const yCam = [0, 1, 2].map((j) => REC709[0] * u.rgbCam[j] + REC709[1] * u.rgbCam[3 + j] + REC709[2] * u.rgbCam[6 + j]);
  const lumaWeights: [number, number, number] =
    mode === '709' ? REC709 : mode === 'wb' ? [yCam[0], yCam[1], yCam[2]] : [yCam[0] * u.wb[0], yCam[1] * u.wb[1], yCam[2] * u.wb[2]];

  const data = new Float32Array(W * H * 4);
  let photositeHistograms: RawDecoded['photositeHistograms'];

  if (u.kind === 'cfa') {
    // Normalized photosites go into the alpha lane (rows top-down), so no extra plane is needed.
    const { cellW: cw, cellH: ch } = u;
    for (let y = 0; y < H; y++) {
      const row = y * W, cy = (y % ch) * cw;
      for (let x = 0; x < W; x++) {
        const c = cy + (x % cw);
        data[(row + x) * 4 + 3] = (u.dn[row + x] - u.cellBlack[c]) * cellScale[c];
      }
    }
    const site = u.cellColor.map((c) => (c === 3 ? 1 : c));
    if (mode !== '709') photositeHistograms = photositeHist(data, 4, 3, W, H, site, cw, ch);
    demosaic(data, 4, 3, W, H, site, cw, ch, data);
    for (let i = 3; i < data.length; i += 4) data[i] = 1;
  } else {
    for (let y = 0; y < H; y++) {
      const out = (H - 1 - y) * W * 4;
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 3, o = out + x * 4;
        for (let c = 0; c < 3; c++) data[o + c] = (u.dn[s + c] - u.cellBlack[c]) * cellScale[c];
        data[o + 3] = 1;
      }
    }
  }

  if (mode === '709') {
    const m = u.rgbCam;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      data[i] = m[0] * r + m[1] * g + m[2] * b;
      data[i + 1] = m[3] * r + m[4] * g + m[5] * b;
      data[i + 2] = m[6] * r + m[7] * g + m[8] * b;
    }
  }

  const bits = Math.ceil(Math.log2(u.white + 1));
  const notes = [...u.notes];
  if (mode === '709' && u.kind === 'cfa') notes.push('The mosaic view shows white-balanced photosites; the camera matrix needs all three channels, so it only applies to the demosaiced view.');
  return {
    width: W,
    height: H,
    data,
    lumaWeights,
    photositeHistograms,
    raw: {
      mode,
      kind: u.kind,
      dn: u.dn.slice(), // the cached copy stays in the worker for mode switches
      channels: u.channels,
      cellW: u.cellW,
      cellH: u.cellH,
      cellColor: u.cellColor,
      cellBlack: u.cellBlack,
      cellScale,
      white: u.white,
      linearMax: u.linearMax,
      bits,
      pattern: u.pattern,
      make: u.make,
      model: u.model,
      attributes: u.attributes,
      notes,
      noise: u.noise,
      timings: { unpackMs: 0, developMs: 0 },
    },
  };
}

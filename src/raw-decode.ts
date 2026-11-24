/**
 * Camera RAW decoding via LibRaw (WebAssembly).
 *
 * LibRaw only unpacks the file. Black subtraction, normalization, white balance, demosaicing and
 * the camera → Rec.709 matrix are done here, so every step is known and the original integer
 * sensor values stay available for the pixel probe and the mosaic view.
 */
import wasmUrl from '@colorhythm/libraw-wasm/libraw.wasm?url';
import type { LibRaw as LibRawClass } from '@colorhythm/libraw-wasm';
import { HistogramAccumulator } from './histogram';
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
  attr('Flip', lr.getFlip());

  const common = { key, width, height, linearMax, wb, rgbCam, make, model, attributes, notes };

  const raw = filters && !ip.is_foveon ? lr.getRawImage() : null;
  const oddLayout = width > rawW - left || height > rawH - top || left < 0 || top < 0;
  const fourColor = ip.colors === 4 && ip.cdesc !== 'RGBG';

  if (raw && !oddLayout && !fourColor) {
    // Mosaic: crop the visible area out of the full sensor readout.
    const dn = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) dn.set(raw.subarray((y + top) * rawW + left, (y + top) * rawW + left + width), y * width);

    // The repeating cell must cover both the color pattern and any black-level pattern.
    const [pw, ph] = filters === 9 ? [6, 6] : filters < 1000 ? [16, 16] : [2, 8];
    const cw = lcm(pw, cblack[4] || 1), ch = lcm(ph, cblack[5] || 1);
    const blackAt = (x: number, y: number) => {
      const c = lr.color(y, x);
      const pat = cblack[4] && cblack[5] ? lr.getCblack(6 + (y % cblack[4]) * cblack[5] + (x % cblack[5])) : 0;
      return black + cblack[Math.min(c, 3)] + pat;
    };
    const colors: number[] = [];
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) colors.push(lr.color(y, x));
    const { w: cellW, h: cellH } = minimalPeriod(colors, cw, ch, blackAt);
    const cellColor: number[] = [], cellBlack: number[] = [];
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        cellColor.push(lr.color(y, x));
        cellBlack.push(blackAt(x, y));
      }
    }
    return {
      ...common,
      kind: 'cfa',
      channels: 1,
      dn,
      cellW,
      cellH,
      cellColor,
      cellBlack,
      white: maximum,
      pattern: patternName(cellColor, cellW, cellH, filters),
    };
  }

  // Already demosaiced in the file (linear DNG, sRAW, Foveon).
  const c4 = lr.getColor4Image(), c3 = c4 ? null : lr.getColor3Image();
  if ((c4 || c3) && !oddLayout) {
    const src = (c4 ?? c3)!, n = c4 ? 4 : 3;
    const dn = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const s = ((y + top) * rawW + x + left) * n, d = (y * width + x) * 3;
        dn[d] = src[s];
        dn[d + 1] = src[s + 1];
        dn[d + 2] = src[s + 2];
      }
    }
    notes.push(ip.is_foveon ? 'Foveon sensor: three values per pixel, no mosaic.' : 'This file stores already demosaiced (linear) RGB, so there is no mosaic to show.');
    return {
      ...common,
      kind: 'linear',
      channels: 3,
      dn,
      cellW: 3,
      cellH: 1,
      cellColor: [0, 1, 2],
      cellBlack: [0, 1, 2].map((c) => lr.getBlackLevel(c)),
      white: maximum,
      pattern: ip.is_foveon ? 'Foveon' : 'linear RGB',
    };
  }

  // Unusual layouts (e.g. Fuji SuperCCD): let LibRaw develop to linear 16-bit camera RGB.
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
  };
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}
const lcm = (a: number, b: number) => (a / gcd(a, b)) * b;

/** Smallest cell (dividing cw × ch) that repeats both the color pattern and the black pattern. */
function minimalPeriod(
  colors: number[],
  cw: number,
  ch: number,
  blackAt: (x: number, y: number) => number,
): { w: number; h: number } {
  const ok = (w: number, h: number) => {
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        if (colors[y * cw + x] !== colors[(y % h) * cw + (x % w)]) return false;
        if (blackAt(x, y) !== blackAt(x % w, y % h)) return false;
      }
    }
    return true;
  };
  let bw = cw, bh = ch;
  for (let w = 1; w <= cw; w++) {
    if (cw % w) continue;
    for (let h = 1; h <= ch; h++) {
      if (ch % h || w * h >= bw * bh) continue;
      if (ok(w, h)) {
        bw = w;
        bh = h;
      }
    }
  }
  return { w: bw, h: bh };
}

function patternName(colors: number[], w: number, h: number, filters: number): string {
  if (filters === 9) return 'X-Trans';
  if (w === 2 && h === 2) return colors.map((c) => 'RGBG'[c]).join('');
  return `${w}×${h} CFA`;
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
    // Normalized photosite plane, top-down.
    const norm = new Float32Array(W * H);
    const { cellW: cw, cellH: ch } = u;
    for (let y = 0; y < H; y++) {
      const row = y * W, cy = (y % ch) * cw;
      for (let x = 0; x < W; x++) {
        const c = cy + (x % cw);
        norm[row + x] = (u.dn[row + x] - u.cellBlack[c]) * cellScale[c];
      }
    }
    const site = u.cellColor.map((c) => (c === 3 ? 1 : c));
    demosaic(norm, W, H, site, cw, ch, data);
    if (mode !== '709') photositeHistograms = photositeHist(norm, W, H, site, cw, ch);
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
      timings: { unpackMs: 0, developMs: 0 },
    },
  };
}

/**
 * Generic bilinear-style demosaic that works for any CFA: each missing color is the mean of the
 * same-colored photosites in the 3×3 neighborhood (5×5 if there are none). For Bayer this is
 * exactly bilinear interpolation. Output is RGBA, rows bottom-up.
 */
export function demosaic(norm: Float32Array, W: number, H: number, site: number[], cw: number, ch: number, out: Float32Array) {
  // Per cell and color: the neighbor offsets to average.
  const offsets: { dx: number[]; dy: number[]; idx: Int32Array }[] = [];
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      for (let k = 0; k < 3; k++) {
        const dx: number[] = [], dy: number[] = [];
        if (site[cy * cw + cx] === k) {
          dx.push(0);
          dy.push(0);
        } else {
          for (let r = 1; r <= 2 && !dx.length; r++) {
            for (let oy = -r; oy <= r; oy++) {
              for (let ox = -r; ox <= r; ox++) {
                const sx = (((cx + ox) % cw) + cw) % cw, sy = (((cy + oy) % ch) + ch) % ch;
                if (site[sy * cw + sx] === k) {
                  dx.push(ox);
                  dy.push(oy);
                }
              }
            }
          }
        }
        offsets.push({ dx, dy, idx: Int32Array.from(dx.map((x, i) => dy[i] * W + x)) });
      }
    }
  }

  for (let y = 0; y < H; y++) {
    const outRow = (H - 1 - y) * W * 4, cy = (y % ch) * cw;
    const yInner = y >= 2 && y < H - 2;
    for (let x = 0; x < W; x++) {
      const p = y * W + x, o = outRow + x * 4, cell = (cy + (x % cw)) * 3;
      if (yInner && x >= 2 && x < W - 2) {
        for (let k = 0; k < 3; k++) {
          const idx = offsets[cell + k].idx, n = idx.length;
          if (n === 1) {
            out[o + k] = norm[p + idx[0]];
          } else {
            let s = 0;
            for (let j = 0; j < n; j++) s += norm[p + idx[j]];
            out[o + k] = s / n;
          }
        }
      } else {
        for (let k = 0; k < 3; k++) {
          const { dx, dy } = offsets[cell + k];
          let s = 0, n = 0;
          for (let j = 0; j < dx.length; j++) {
            const xx = x + dx[j], yy = y + dy[j];
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            s += norm[yy * W + xx];
            n++;
          }
          out[o + k] = n ? s / n : 0;
        }
      }
      out[o + 3] = 1;
    }
  }
}

/** R/G/B histograms over the photosites of each color, without interpolated values. */
function photositeHist(norm: Float32Array, W: number, H: number, site: number[], cw: number, ch: number) {
  const acc = [new HistogramAccumulator(), new HistogramAccumulator(), new HistogramAccumulator()];
  const CHUNK = 1 << 16;
  const bufs = [0, 1, 2].map(() => new Float32Array(CHUNK));
  const bits = bufs.map((b) => new Uint32Array(b.buffer));
  const fill = [0, 0, 0];
  const flush = (k: number) => {
    acc[k].add(bufs[k], bits[k], 0, 1, fill[k]);
    fill[k] = 0;
  };
  for (let y = 0; y < H; y++) {
    const row = y * W, cy = (y % ch) * cw;
    for (let x = 0; x < W; x++) {
      const k = site[cy + (x % cw)];
      bufs[k][fill[k]++] = norm[row + x];
      if (fill[k] === CHUNK) flush(k);
    }
  }
  for (let k = 0; k < 3; k++) flush(k);
  return { R: acc[0].result(), G: acc[1].result(), B: acc[2].result() };
}

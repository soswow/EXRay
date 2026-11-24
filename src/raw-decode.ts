/**
 * Camera RAW decoding via LibRaw (WebAssembly).
 *
 * LibRaw only unpacks the file. Black subtraction, normalization, white balance, demosaicing and
 * the camera → Rec.709 matrix are done here, so every step is known and the original integer
 * sensor values stay available for the pixel probe and the mosaic view.
 *
 * Every level that could be used for normalization is collected with where it came from (the
 * camera's makernote, LibRaw, or measured here), so the info panel can show them side by side and
 * the user can pick which ones are applied.
 */
import wasmUrl from '@colorhythm/libraw-wasm/libraw.wasm?url';
import type { LibRaw as LibRawClass } from '@colorhythm/libraw-wasm';
import { exactHistogram } from './histogram';
import { demosaic, lcm, maskedNoise, maskedRegions, minimalPeriod, orientCell, orientPixels, patternName, shiftCell, type MaskedNoise } from './raw-process';
import type {
  BlackSource,
  ChannelHistogram,
  CropId,
  ExrAttribute,
  LevelCandidate,
  RawArea,
  RawImage,
  RawModeId,
  RawOptions,
  WhiteSource,
} from './types';

type LibRawModule = typeof import('@colorhythm/libraw-wasm');
let libPromise: Promise<LibRawModule> | null = null;
let libModule: LibRawModule | null = null;

/** Loads LibRaw on first use, so opening EXR files never downloads it. */
function loadLibRaw(): Promise<LibRawModule> {
  return (libPromise ??= import('@colorhythm/libraw-wasm').then(async (m) => {
    await m.LibRaw.initialize(fetch(wasmUrl));
    libModule = m;
    return m;
  }));
}

/** Everything read from the file, kept so switching modes, levels or crops doesn't unpack again. */
interface Unpacked {
  key: string;
  kind: 'cfa' | 'linear';
  channels: 1 | 3;
  /** 'cfa': the full sensor readout. 'linear': the visible image, 3 values per pixel. */
  src: Uint16Array;
  srcW: number;
  srcH: number;
  /** Areas of `src` that can be shown; the first one is the default. */
  areas: RawArea[];
  /** LibRaw orientation to apply after cropping (0 when the data is already upright). */
  flip: number;
  /** Repeating CFA cell anchored at src (0, 0): color 0 R, 1 G, 2 B, 3 second G. */
  cellW: number;
  cellH: number;
  cellColor: number[];
  /** Black level per cell (anchored like cellColor) for each available source. */
  cellBlacks: Partial<Record<BlackSource, number[]>>;
  /** White level per CFA color (R, G, B, G2) for each available source other than 'data'. */
  whiteByColor: Partial<Record<WhiteSource, number[]>>;
  blacks: LevelCandidate<BlackSource>[];
  whites: LevelCandidate<WhiteSource>[];
  /** White balance multipliers for R, G, B, normalized to G = 1. */
  wb: [number, number, number];
  wbSource: string;
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
  /** Exact R/G/B histograms of the photosites themselves (before interpolation), when they apply. */
  photositeHistograms?: { R: ChannelHistogram; G: ChannelHistogram; B: ChannelHistogram };
}

const REC709: [number, number, number] = [0.2126, 0.7152, 0.0722];

/** True for files that start like an OpenEXR file. */
export function isExr(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  return new DataView(buffer).getUint32(0, true) === 20000630;
}

export async function decodeRaw(buffer: ArrayBuffer, name: string, mode: RawModeId, options: Partial<RawOptions> = {}): Promise<RawDecoded> {
  const key = `${name}:${buffer.byteLength}`;
  let unpackMs = 0;
  if (cache?.key !== key) {
    cache = null; // free the previous file before unpacking the next
    const t0 = performance.now();
    cache = await unpack(buffer, key);
    unpackMs = performance.now() - t0;
  }
  const t1 = performance.now();
  const r = develop(cache, mode, options);
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

/** Inclusive Canon rectangle {t, l, b, r} → area, if it lies on the sensor. */
type Rect = { x: number; y: number; w: number; h: number };

/**
 * Canon makernote values. Levels come from the binding; the sensor areas are read from LibRaw's
 * struct directly, because the binding (libraw-wasm 1.1.1) decodes fields after
 * `AverageBlackLevel` at the wrong offsets. The offsets below match LibRaw 0.22's
 * libraw_canon_makernotes_t and are only trusted when the sensor size stored next to them
 * equals the raw buffer size.
 */
function readCanon(lr: LibRawClass, rawW: number, rawH: number) {
  const mk = lr.getMakernotes().canon;
  const levels = {
    specular: mk.SpecularWhiteLevel,
    normal: mk.NormalWhiteLevel,
    /** LibRaw stores these in its color order R, G, B, G2. */
    channelBlack: [...mk.ChannelBlackLevel].slice(0, 4),
    averageBlack: mk.AverageBlackLevel,
  };
  const areas: { crop?: Rect; active?: Rect; leftOB?: Rect; topOB?: Rect } = {};
  try {
    const mod = (libModule!.LibRaw as unknown as { module: { HEAPU8: Uint8Array; _libraw_get_makernotes(h: number): number } }).module;
    const ptr = mod._libraw_get_makernotes((lr as unknown as { lr: number }).lr);
    const dv = new DataView(mod.HEAPU8.buffer, ptr, 172);
    if (dv.getUint16(80, true) === rawW && dv.getUint16(82, true) === rawH) {
      const rect = (o: number): Rect | undefined => {
        const t = dv.getInt16(o, true), l = dv.getInt16(o + 2, true), b = dv.getInt16(o + 4, true), r = dv.getInt16(o + 6, true);
        if (!(l >= 0 && t >= 0 && r > l && b > t && r < rawW && b < rawH)) return undefined;
        return { x: l, y: t, w: r - l + 1, h: b - t + 1 };
      };
      areas.crop = rect(124);
      areas.leftOB = rect(140);
      areas.topOB = rect(148);
      areas.active = rect(156);
    }
  } catch {
    /* areas are optional */
  }
  return { levels, areas };
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
  const make = ip.make.trim(), model = ip.model.trim();
  const canon = make === 'Canon' ? readCanon(lr, rawW, rawH) : null;

  // White balance: as-shot multipliers, else daylight; normalized to green.
  let mul = [0, 1, 2].map((i) => lr.getCamMul(i));
  let wbSource = 'as shot (LibRaw cam_mul)';
  if (!(mul[0] > 0 && mul[1] > 0 && mul[2] > 0)) {
    mul = [0, 1, 2].map((i) => lr.getPreMul(i));
    wbSource = 'daylight (LibRaw pre_mul)';
  }
  if (!(mul[0] > 0 && mul[1] > 0 && mul[2] > 0)) {
    mul = [1, 1, 1];
    wbSource = 'none in file (unity)';
  }
  const wb: [number, number, number] = [mul[0] / mul[1], 1, mul[2] / mul[1]];
  const rgbCam: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rgbCam.push(lr.getRgbCam(i, j));

  const linearMax = [0, 1, 2, 3].map((i) => lr.getLinearMax(i));
  const filters = ip.filters >>> 0;

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
  attr('Unpacker', `LibRaw ${lr.unpackFunctionName()}`);
  const flip = lr.getFlip();
  if (flip) attr('Orientation', { 3: 'rotated 180°', 5: 'rotated 90° CCW', 6: 'rotated 90° CW' }[flip] ?? `flip ${flip}`);

  // White candidates shared by both layouts. Values are per LibRaw color R, G, B, G2.
  const four = (v: number) => [v, v, v, v];
  const whites: LevelCandidate<WhiteSource>[] = [
    { id: 'libraw', label: 'LibRaw maximum', source: 'LibRaw color.maximum: its own per-camera value (camera table or bit depth), not a single file tag', values: four(maximum) },
  ];
  const whiteByColor: Unpacked['whiteByColor'] = { libraw: four(maximum) };
  if (linearMax.some((v) => v > 0)) {
    const isSpec = !!canon && canon.levels.specular > 0 && linearMax.every((v) => v === canon.levels.specular);
    whites.push({
      id: 'linear',
      label: isSpec ? 'Canon specular' : 'LibRaw linear_max',
      source: isSpec ? 'Canon makernote SpecularWhiteLevel (LibRaw copies it to linear_max)' : 'LibRaw color.linear_max, read from the file\'s maker data',
      values: linearMax.map((v) => v || null),
    });
    whiteByColor.linear = linearMax.map((v) => v || maximum);
  }
  if (canon && canon.levels.normal > 0) {
    whites.push({ id: 'normal', label: 'Canon normal', source: 'Canon makernote NormalWhiteLevel', values: four(canon.levels.normal) });
    whiteByColor.normal = four(canon.levels.normal);
  }

  const common = { key, wb, wbSource, rgbCam, make, model, attributes, notes, whites, whiteByColor };

  const raw = filters && !ip.is_foveon ? lr.getRawImage() : null;
  const oddLayout = width > rawW - left || height > rawH - top || left < 0 || top < 0;
  const fourColor = ip.colors === 4 && ip.cdesc !== 'RGBG';

  if (raw && !oddLayout && !fourColor) {
    // The repeating cell must cover both the color pattern and any black-level pattern.
    // lr.color() and the black pattern are in visible-area coordinates.
    const [pw, ph] = filters === 9 ? [6, 6] : filters < 1000 ? [16, 16] : [2, 8];
    const cw = lcm(pw, cblack[4] || 1), ch = lcm(ph, cblack[5] || 1);
    const blackAt = (x: number, y: number) => {
      const c = lr.color(y, x);
      const pat = cblack[4] && cblack[5] ? lr.getCblack(6 + (y % cblack[4]) * cblack[5] + (x % cblack[5])) : 0;
      return black + cblack[Math.min(c, 3)] + pat;
    };
    const { w: cellW, h: cellH } = minimalPeriod(cw, ch, (x, y) => `${lr.color(y, x)}:${blackAt(x, y)}`);
    const visColor: number[] = [], visBlack: number[] = [];
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        visColor.push(lr.color(y, x));
        visBlack.push(blackAt(x, y));
      }
    }
    // Re-anchor the cell at the top-left of the full readout.
    const cellColor = shiftCell(visColor, cellW, cellH, -left, -top);
    const cellIndex = (x: number, y: number) => (y % cellH) * cellW + (x % cellW);
    const cellBlacks: Unpacked['cellBlacks'] = { libraw: shiftCell(visBlack, cellW, cellH, -left, -top) };

    // The full readout, kept so any area (including the masked border) can be shown.
    const src = raw.slice(0, rawW * rawH);

    // Sensor areas, in raw coordinates.
    const areas: RawArea[] = [];
    const a = canon?.areas;
    if (a?.crop) areas.push({ id: 'maker', label: 'Canon default crop', source: 'Canon makernote (SensorInfo crop, inclusive borders)', ...a.crop });
    if (a?.active) areas.push({ id: 'active', label: 'Canon active area', source: 'Canon makernote ActiveArea', ...a.active });
    areas.push({ id: 'libraw', label: 'LibRaw visible area', source: 'LibRaw raw size minus its margins', x: left, y: top, w: width, h: height });
    areas.push({ id: 'full', label: 'Full readout', source: 'Everything in the file, including the masked border', x: 0, y: 0, w: rawW, h: rawH });

    // Read noise and measured black from the masked border.
    const known = [
      a?.leftOB && { ...a.leftOB, name: `Canon left optical black ${a.leftOB.w} px` },
      a?.topOB && { ...a.topOB, name: `Canon top optical black ${a.topOB.h} px` },
    ].filter((r): r is Rect & { name: string } => !!r);
    const noise = maskedNoise(src, rawW, maskedRegions(rawW, rawH, left, top, known), cellIndex, cellW * cellH);

    // Black candidates per color.
    const perColor = (cellValues: number[], weights?: number[]) =>
      [0, 1, 2, 3].map((c) => {
        let s = 0, n = 0;
        cellColor.forEach((k, i) => {
          if (k !== c || !Number.isFinite(cellValues[i])) return;
          const w = weights ? weights[i] : 1;
          s += cellValues[i] * w;
          n += w;
        });
        return n ? s / n : null;
      });
    const hasG2 = cellColor.includes(3);
    const blacks: LevelCandidate<BlackSource>[] = [];
    if (canon && canon.levels.channelBlack.some((v) => v > 0)) {
      const cb = canon.levels.channelBlack;
      blacks.push({ id: 'maker', label: 'Canon', source: 'Canon makernote ChannelBlackLevel (per channel)', values: [cb[0], cb[1], cb[2], hasG2 ? cb[3] : null] });
      cellBlacks.maker = cellColor.map((c) => cb[c]);
    }
    blacks.push({
      id: 'libraw',
      label: 'LibRaw',
      source: `LibRaw black + cblack[] = ${black} + ${cblack.slice(0, 4).join('/')}${cblack[4] && cblack[5] ? ` + ${cblack[4]}×${cblack[5]} pattern` : ''}. For many cameras (Canon included) LibRaw computes this from the masked border and rounds it to integers.`,
      values: perColor(cellBlacks.libraw!),
    });
    if (noise) {
      cellBlacks.masked = noise.cellMean.map((m, i) => (Number.isFinite(m) ? m : cellBlacks.libraw![i]));
      blacks.push({
        id: 'masked',
        label: 'Masked mean',
        source: `Measured here: mean DN of the masked border (${noise.region}, ${noise.pixels.toLocaleString()} px)`,
        values: perColor(noise.cellMean, noise.cellCount),
      });
    }

    return {
      ...common,
      kind: 'cfa',
      channels: 1,
      src,
      srcW: rawW,
      srcH: rawH,
      areas,
      flip,
      cellW,
      cellH,
      cellColor,
      cellBlacks,
      blacks,
      pattern: patternName(visColor, cellW, cellH, filters === 9),
      noise,
    };
  }

  // Already demosaiced in the file (linear DNG, sRAW, Foveon).
  const c4 = lr.getColor4Image(), c3 = c4 ? null : lr.getColor3Image();
  if ((c4 || c3) && !oddLayout) {
    const s = (c4 ?? c3)!, n = c4 ? 4 : 3;
    const src = new Uint16Array(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = ((y + top) * rawW + x + left) * n, d = (y * width + x) * 3;
        src[d] = s[i];
        src[d + 1] = s[i + 1];
        src[d + 2] = s[i + 2];
      }
    }
    notes.push(ip.is_foveon ? 'Foveon sensor: three values per pixel, no mosaic.' : 'This file stores already demosaiced (linear) RGB, so there is no mosaic to show.');
    const bl = [0, 1, 2].map((c) => lr.getBlackLevel(c));
    return {
      ...common,
      kind: 'linear',
      channels: 3,
      src,
      srcW: width,
      srcH: height,
      areas: [{ id: 'libraw', label: 'LibRaw visible area', source: 'LibRaw raw size minus its margins', x: 0, y: 0, w: width, h: height }],
      flip,
      cellW: 3,
      cellH: 1,
      cellColor: [0, 1, 2],
      cellBlacks: { libraw: bl },
      blacks: [{ id: 'libraw', label: 'LibRaw', source: 'LibRaw black level per channel', values: [bl[0], bl[1], bl[2], null] }],
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
  const src = new Uint16Array(img.width * img.height * 3);
  for (let i = 0, j = 0; j < src.length; i += img.colors, j += 3) {
    src[j] = px[i];
    src[j + 1] = px[i + 1];
    src[j + 2] = px[i + 2];
  }
  notes.push('Unusual sensor layout: demosaiced by LibRaw, so values are LibRaw output (black subtracted, scaled to 16 bit), not the file\'s raw integers.');
  return {
    ...common,
    whites: [{ id: 'libraw', label: 'LibRaw output', source: 'LibRaw scales its output to 16 bit', values: four(65535) }],
    whiteByColor: { libraw: four(65535) },
    kind: 'linear',
    channels: 3,
    src,
    srcW: img.width,
    srcH: img.height,
    areas: [{ id: 'libraw', label: 'LibRaw output', source: 'Developed by LibRaw', x: 0, y: 0, w: img.width, h: img.height }],
    flip: 0,
    cellW: 3,
    cellH: 1,
    cellColor: [0, 1, 2],
    cellBlacks: { libraw: [0, 0, 0] },
    blacks: [{ id: 'libraw', label: 'LibRaw output', source: 'Black already subtracted by LibRaw', values: [0, 0, 0, null] }],
    pattern: 'demosaiced by LibRaw',
    noise: null,
  };
}

// ---------- developing ----------

/** Default area: the camera's own crop when known, else LibRaw's visible area. */
export const defaultCrop = (areas: RawArea[]): CropId => areas[0]?.id ?? 'libraw';

function develop(u: Unpacked, mode: RawModeId, opts: Partial<RawOptions>): RawDecoded {
  // Options fall back to LibRaw's choices when a source isn't available for this file.
  const area = u.areas.find((a) => a.id === opts.crop) ?? u.areas.find((a) => a.id === defaultCrop(u.areas))!;
  const blackId: BlackSource = opts.black && u.cellBlacks[opts.black] ? opts.black : 'libraw';
  const whiteId: WhiteSource = opts.white && (opts.white === 'data' || u.whiteByColor[opts.white]) ? opts.white : 'libraw';
  const n = u.channels;
  const cfa = u.kind === 'cfa';

  // Crop (unrotated); the cell is re-anchored at the area's top-left.
  let W = area.w, H = area.h;
  let dn: Uint16Array<ArrayBuffer>;
  if (area.x === 0 && area.y === 0 && area.w === u.srcW && area.h === u.srcH) dn = u.src.slice();
  else {
    dn = new Uint16Array(W * H * n);
    for (let y = 0; y < H; y++) dn.set(u.src.subarray(((y + area.y) * u.srcW + area.x) * n, ((y + area.y) * u.srcW + area.x + W) * n), y * W * n);
  }
  const shift = <T>(cell: T[]) => (cfa ? shiftCell(cell, u.cellW, u.cellH, area.x, area.y) : cell);
  const cellColor = shift(u.cellColor);
  const cellBlack = shift(u.cellBlacks[blackId]!);
  const cells = cellColor.length;

  // Exact DN counts per cell, before any processing.
  const counts = Array.from({ length: cells }, () => new Uint32Array(65536));
  if (cfa) {
    for (let y = 0; y < H; y++) {
      const row = y * W, cy = (y % u.cellH) * u.cellW;
      for (let x = 0; x < W; x++) counts[cy + (x % u.cellW)][dn[row + x]]++;
    }
  } else {
    for (let i = 0; i < W * H * 3; i += 3) {
      counts[0][dn[i]]++;
      counts[1][dn[i + 1]]++;
      counts[2][dn[i + 2]]++;
    }
  }

  // Data maximum per color (the 'data' white candidate) and per-channel integer stats.
  const dataMax = [0, 0, 0, 0], atMax = [0, 0, 0, 0];
  counts.forEach((h, i) => {
    const c = cellColor[i];
    let m = 65535;
    while (m > 0 && !h[m]) m--;
    if (m > dataMax[c]) [dataMax[c], atMax[c]] = [m, h[m]];
    else if (m === dataMax[c]) atMax[c] += h[m];
  });
  const present = [0, 1, 2, 3].map((c) => cellColor.includes(c));
  const whites: LevelCandidate<WhiteSource>[] = [
    ...u.whites,
    {
      id: 'data',
      label: 'Data max',
      source: `Measured here: the highest DN in the shown area (${area.label}), and how many photosites have it`,
      values: dataMax.map((v, c) => (present[c] ? v : null)),
      detail: atMax.map((k, c) => (present[c] ? `${k.toLocaleString()} at max` : '')),
    },
  ];
  const whiteByColor = whiteId === 'data' ? dataMax.map((v) => v || 1) : u.whiteByColor[whiteId]!;
  const cellWhite = cellColor.map((c) => whiteByColor[c]);

  const wb: [number, number, number] = mode === 'cam' ? [1, 1, 1] : u.wb;
  const chOf = (c: number) => (c === 3 ? 1 : c);
  const cellScale = cellColor.map((c, i) => wb[chOf(c)] / Math.max(1e-9, cellWhite[i] - cellBlack[i]));

  const dnStats = [0, 1, 2].map((k) => {
    let max = -1, atMaxK = 0, min = 65536, low = 0, count = 0;
    counts.forEach((h, i) => {
      if (chOf(cellColor[i]) !== k) return;
      for (let v = 0; v < 65536; v++) {
        const m = h[v];
        if (!m) continue;
        count += m;
        if (v < min) min = v;
        if (v > max) [max, atMaxK] = [v, m];
        else if (v === max) atMaxK += m;
        if (v <= cellBlack[i]) low += m;
      }
    });
    return { max, atMax: atMaxK, min, atOrBelowBlack: low, count };
  });

  // Exact photosite histograms of the values shown (not in Rec.709 mode, where R/G/B are mixed).
  let photositeHistograms: RawDecoded['photositeHistograms'];
  if (mode !== '709') {
    const per = [0, 1, 2].map((k) => {
      const vals: number[] = [], cnt: number[] = [];
      counts.forEach((h, i) => {
        if (chOf(cellColor[i]) !== k) return;
        for (let v = 0; v < 65536; v++) {
          if (!h[v]) continue;
          vals.push((v - cellBlack[i]) * cellScale[i]);
          cnt.push(h[v]);
        }
      });
      return exactHistogram(Float64Array.from(vals), Float64Array.from(cnt));
    });
    photositeHistograms = { R: per[0], G: per[1], B: per[2] };
  }

  // Orientation.
  const rotated = u.flip === 5 || u.flip === 6;
  dn = orientPixels(dn, W, H, n, u.flip);
  let cellW = u.cellW, cellH = u.cellH;
  let oc: [number, number, number, number][] = cellColor.map((c, i) => [c, cellBlack[i], cellScale[i], cellWhite[i]]);
  if (cfa) ({ cell: oc, cw: cellW, ch: cellH } = orientCell(oc, cellW, cellH, W, H, u.flip));
  if (rotated) [W, H] = [H, W];
  const oColor = oc.map((c) => c[0]), oBlack = oc.map((c) => c[1]), oScale = oc.map((c) => c[2]), oWhite = oc.map((c) => c[3]);

  // Luminance weights: Y of the Rec.709 result, expressed on whatever RGB `data` holds.
  const yCam = [0, 1, 2].map((j) => REC709[0] * u.rgbCam[j] + REC709[1] * u.rgbCam[3 + j] + REC709[2] * u.rgbCam[6 + j]);
  const lumaWeights: [number, number, number] =
    mode === '709' ? REC709 : mode === 'wb' ? [yCam[0], yCam[1], yCam[2]] : [yCam[0] * u.wb[0], yCam[1] * u.wb[1], yCam[2] * u.wb[2]];

  const data = new Float32Array(W * H * 4);
  if (cfa) {
    // Normalized photosites go into the alpha lane (rows top-down), so no extra plane is needed.
    for (let y = 0; y < H; y++) {
      const row = y * W, cy = (y % cellH) * cellW;
      for (let x = 0; x < W; x++) {
        const c = cy + (x % cellW);
        data[(row + x) * 4 + 3] = (dn[row + x] - oBlack[c]) * oScale[c];
      }
    }
    demosaic(data, 4, 3, W, H, oColor.map(chOf), cellW, cellH, data);
    for (let i = 3; i < data.length; i += 4) data[i] = 1;
  } else {
    for (let y = 0; y < H; y++) {
      const out = (H - 1 - y) * W * 4;
      for (let x = 0; x < W; x++) {
        const s = (y * W + x) * 3, o = out + x * 4;
        for (let c = 0; c < 3; c++) data[o + c] = (dn[s + c] - oBlack[c]) * oScale[c];
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

  const notes = [...u.notes];
  if (mode === '709' && cfa) notes.push('The mosaic view shows white-balanced photosites; the camera matrix needs all three channels, so it only applies to the demosaiced view.');
  return {
    width: W,
    height: H,
    data,
    lumaWeights,
    photositeHistograms,
    raw: {
      mode,
      kind: u.kind,
      dn,
      channels: u.channels,
      cellW,
      cellH,
      cellColor: oColor,
      cellBlack: oBlack,
      cellScale: oScale,
      cellWhite: oWhite,
      options: { black: blackId, white: whiteId, crop: area.id },
      blacks: u.blacks,
      whites,
      areas: u.areas,
      rawSize: [u.srcW, u.srcH],
      dnStats,
      pattern: u.pattern,
      make: u.make,
      model: u.model,
      attributes: u.attributes,
      notes,
      noise: u.noise && { sigma: u.noise.sigma, pixels: u.noise.pixels, region: u.noise.region },
      wb: u.wb,
      wbSource: u.wbSource,
      rgbCam: u.rgbCam,
      timings: { unpackMs: 0, developMs: 0 },
    },
  };
}


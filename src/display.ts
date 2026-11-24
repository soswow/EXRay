import type { ColormapId } from './colormaps';
import { gridFloor } from './format';

/**
 * How float values become display colors. The window [lo, hi] is in log2 of the value
 * (see SHOW_STOPS in format.ts for how the UI presents it).
 *  - log:    t = (log2(v) - lo) / (hi - lo), sent to the display as is: every stop in the window
 *            gets the same width. A plain log2, not a camera log curve (LogC, S-Log, ...).
 *  - linear: t = (v - 2^lo) / (2^hi - 2^lo), then encoded with `transfer`. Like an exposure + black point.
 *  - false:  log t of the selected channel (luminance for RGB) through a colormap.
 * The canvas is treated as an sRGB display; there is no color management beyond that.
 */
export type DisplayMode = 'log' | 'linear' | 'false';

/**
 * Encoding for linear mode, i.e. the inverse of the display's EOTF.
 *  - srgb:   IEC 61966-2-1 piecewise curve
 *  - bt1886: 1 / 2.4 power (inverse of the BT.1886 EOTF with zero black)
 *  - g22:    1 / 2.2 power
 *  - none:   linear values written straight to the display
 */
export type Transfer = 'srgb' | 'bt1886' | 'g22' | 'none';
export const TRANSFERS: { id: Transfer; label: string; title: string }[] = [
  { id: 'srgb', label: 'sRGB', title: 'IEC 61966-2-1 piecewise sRGB encoding' },
  { id: 'bt1886', label: 'BT.1886 (γ 2.4)', title: 'Inverse of the BT.1886 display EOTF: a 1/2.4 power' },
  { id: 'g22', label: 'γ 2.2', title: 'A pure 1/2.2 power' },
  { id: 'none', label: 'None (linear)', title: 'Linear values written to the display unencoded' },
];
export type ViewChannel = 'rgb' | 'r' | 'g' | 'b' | 'l' | 'a';

export interface DisplayParams {
  mode: DisplayMode;
  channel: ViewChannel;
  lo: number;
  hi: number;
  colormap: ColormapId;
  /** Encoding applied in linear mode. */
  transfer: Transfer;
  /** Quantize false color into one band per power of two, aligned to the grid origin (format.ts). */
  bands: boolean;
  /** Mark out-of-window and special values with solid colors. */
  clip: boolean;
  /** Dim everything outside the window. */
  isolate: boolean;
}

export const CLIP_COLORS = {
  under: [0.1, 0.25, 1.0],
  over: [1.0, 0.1, 0.1],
  nan: [1.0, 0.0, 1.0],
  negative: [0.0, 0.75, 0.7],
  hover: [1.0, 0.95, 0.0],
} as const;

/** Narrowest display window, in log2 units. */
export const MIN_WINDOW = 1 / 64;

/**
 * Keeps a window [lo, hi] (log2) inside the image's data range [min, max] (log2 of the
 * smallest and largest positive value in any channel). keepSpan shifts the window instead
 * of shrinking it, for moves. A null range (no positive values) leaves it alone.
 */
export function clampWindow(lo: number, hi: number, range: [number, number] | null, keepSpan = false): [number, number] {
  if (!range) return [lo, hi];
  const a = range[0], b = Math.max(range[1], range[0] + MIN_WINDOW);
  if (keepSpan) {
    const span = Math.min(hi - lo, b - a);
    lo = Math.min(Math.max(lo, a), b - span);
    return [lo, lo + span];
  }
  lo = Math.min(Math.max(lo, a), b - MIN_WINDOW);
  hi = Math.max(Math.min(hi, b), lo + MIN_WINDOW);
  return [lo, hi];
}

export const srgbEncode = (x: number) =>
  x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;

export function encode(x: number, t: Transfer): number {
  switch (t) {
    case 'srgb': return srgbEncode(x);
    case 'bt1886': return Math.pow(x, 1 / 2.4);
    case 'g22': return Math.pow(x, 1 / 2.2);
    case 'none': return x;
  }
}

/** Display intensity (0..1, may fall outside) for a value with the given log2. */
export function evToDisplayT(ev: number, p: DisplayParams): number {
  if (p.mode === 'linear') {
    const a = 2 ** p.lo, b = 2 ** p.hi;
    const t = (2 ** ev - a) / (b - a);
    return t < 0 || t > 1 ? t : encode(t, p.transfer);
  }
  const e = p.mode === 'false' && p.bands ? gridFloor(ev) + 0.5 : ev;
  return (e - p.lo) / (p.hi - p.lo);
}

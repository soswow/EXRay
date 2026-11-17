import type { ColormapId } from './colormaps';

/**
 * How float values become display colors. The window [lo, hi] is in EV (log2 of the value).
 *  - log:    t = (log2(v) - lo) / (hi - lo), shown directly. Compresses any range to the screen.
 *  - linear: t = (v - 2^lo) / (2^hi - 2^lo), then sRGB-encoded. Like an exposure + black point.
 *  - false:  log t of the selected channel (luminance for RGB) through a colormap.
 */
export type DisplayMode = 'log' | 'linear' | 'false';
export type ViewChannel = 'rgb' | 'r' | 'g' | 'b' | 'l' | 'a';

export interface DisplayParams {
  mode: DisplayMode;
  channel: ViewChannel;
  lo: number;
  hi: number;
  colormap: ColormapId;
  /** Quantize false color into one band per stop. */
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

export const srgbEncode = (x: number) =>
  x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;

/** Display intensity (0..1, may fall outside) for a value at the given EV. */
export function evToDisplayT(ev: number, p: DisplayParams): number {
  if (p.mode === 'linear') {
    const a = 2 ** p.lo, b = 2 ** p.hi;
    const t = (2 ** ev - a) / (b - a);
    return t < 0 || t > 1 ? t : srgbEncode(t);
  }
  const e = p.mode === 'false' && p.bands ? Math.floor(ev) + 0.5 : ev;
  return (e - p.lo) / (p.hi - p.lo);
}

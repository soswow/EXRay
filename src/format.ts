/** Compact display of a linear float value. */
export function fmtValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e-3 && a < 1e5) return Number(v.toPrecision(4)).toString();
  return v.toExponential(2).replace('e+', 'e');
}

/**
 * Readout toggle. Internally everything is plain log2(value) either way.
 *  - true:  levels are shown as stops relative to 0.18 middle grey (0 is 0.18, +1 is 0.36).
 *  - false: only linear values are shown; the word "stops" never appears.
 */
export const SHOW_STOPS = false;

/** Scene-linear middle grey. */
export const MID_GREY = 0.18;
export const GREY_LOG2 = Math.log2(MID_GREY);
/**
 * log2 where the whole-power-of-two grid starts: axis ticks, false-color bands and window
 * snapping. Middle grey with stops shown, 1.0 without (so ticks read 0.5, 1, 2, …).
 */
export const GRID_ORIGIN = SHOW_STOPS ? GREY_LOG2 : 0;
/** Rounds a log2 level down/up to the grid, in steps of 1/perStop. */
export const gridFloor = (log2v: number, perStop = 1) => GRID_ORIGIN + Math.floor((log2v - GRID_ORIGIN) * perStop) / perStop;
export const gridCeil = (log2v: number, perStop = 1) => GRID_ORIGIN + Math.ceil((log2v - GRID_ORIGIN) * perStop) / perStop;
/** log2(value) → stops relative to middle grey. */
export const toStops = (log2v: number) => log2v - GREY_LOG2;
/** Stops relative to middle grey → log2(value). */
export const fromStops = (stops: number) => stops + GREY_LOG2;

/** Signed number with a fixed number of decimals, using a real minus sign. */
function fmtSigned(x: number, decimals: number): string {
  const s = Math.abs(x) < 0.5 * 10 ** -decimals ? (0).toFixed(decimals) : x.toFixed(decimals);
  if (s.startsWith('-')) return '−' + s.slice(1);
  return (x > 0 && parseFloat(s) !== 0 ? '+' : '') + s;
}

/** Formats log2(value) as signed stops relative to middle grey. */
export function fmtStops(log2v: number, decimals = 2): string {
  return fmtSigned(toStops(log2v), decimals);
}

/** A level given as log2(value), shown per SHOW_STOPS: "+1.25 stops" or "0.428". */
export function fmtLevel(log2v: number, decimals = 2): string {
  return SHOW_STOPS ? `${fmtStops(log2v, decimals)} stops` : fmtValue(2 ** log2v);
}

/** A log2 range per SHOW_STOPS: "−4.00 … +4.00 (8.00 stops)" or "0.0113 … 2.88". */
export function fmtRange(lo: number, hi: number): string {
  return SHOW_STOPS
    ? `${fmtStops(lo)} … ${fmtStops(hi)}  (${(hi - lo).toFixed(2)} stops)`
    : `${fmtValue(2 ** lo)} … ${fmtValue(2 ** hi)}`;
}

/** Window input text for a log2 level, and back (NaN when the text is not usable). */
export const levelToInput = (log2v: number) =>
  SHOW_STOPS ? toStops(log2v).toFixed(2) : String(Number((2 ** log2v).toPrecision(4)));
export const inputToLevel = (x: number) => (SHOW_STOPS ? fromStops(x) : x > 0 ? Math.log2(x) : NaN);

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

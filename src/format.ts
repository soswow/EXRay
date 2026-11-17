/** Compact display of a linear float value. */
export function fmtValue(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '+Inf' : '-Inf';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e-3 && a < 1e5) return Number(v.toPrecision(4)).toString();
  return v.toExponential(2).replace('e+', 'e');
}

/** Signed EV with a fixed number of decimals, using a real minus sign. */
export function fmtEv(ev: number, decimals = 2): string {
  const s = Math.abs(ev) < 0.5 * 10 ** -decimals ? (0).toFixed(decimals) : ev.toFixed(decimals);
  if (s.startsWith('-')) return '−' + s.slice(1);
  return (ev > 0 && parseFloat(s) !== 0 ? '+' : '') + s;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

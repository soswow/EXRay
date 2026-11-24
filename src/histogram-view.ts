import { colormapLut } from './colormaps';
import { CLIP_COLORS, evToDisplayT, type DisplayParams } from './display';
import { BINS_PER_STOP, cumAt, cumulative, EV_END, EV_ORIGIN, evToBin, percentileEv } from './histogram';
import { fmtEv, fmtValue } from './format';
import type { ChannelKey, ChannelStats, DecodedImage } from './types';

export type YScale = 'linear' | 'sqrt' | 'log';

interface Callbacks {
  /** The user changed the display window. */
  onWindow(lo: number, hi: number): void;
  /** Hovered EV range (for highlighting pixels), or null. */
  onHover(range: [number, number] | null): void;
}

const LANE = 20; // window bar at the top of the main histogram, CSS px
const AXIS = 32; // tick labels at the bottom
const EDGE_GRAB = 6;
const MIN_SPAN = 1 / 8;
const MAX_SPAN = EV_END - EV_ORIGIN;

const CHANNEL_STYLE: Record<ChannelKey, { stroke: string; fill: string }> = {
  L: { stroke: 'rgba(235,235,235,0.9)', fill: 'rgba(235,235,235,0.22)' },
  R: { stroke: 'rgba(255,90,90,0.95)', fill: 'rgba(255,90,90,0.2)' },
  G: { stroke: 'rgba(90,230,110,0.95)', fill: 'rgba(90,230,110,0.2)' },
  B: { stroke: 'rgba(100,150,255,0.95)', fill: 'rgba(100,150,255,0.2)' },
};

/** A labeled vertical line on the histogram, e.g. a RAW white level or noise floor. */
export interface HistMarker {
  /** log2 of the value. */
  ev: number;
  label: string;
  color: string;
  /** Longer explanation for the tooltip. */
  title?: string;
}

type Drag =
  | { kind: 'pan'; startX: number; v0: number; v1: number }
  | { kind: 'lo' | 'hi' }
  | { kind: 'move'; startEv: number; lo: number; hi: number }
  | { kind: 'select'; anchor: number }
  | { kind: 'ov-pan'; startX: number; v0: number; v1: number }
  | { kind: 'ov-lo' | 'ov-hi' };

/**
 * The interactive histogram: a log2 (EV) x-axis that pans and zooms like a timeline,
 * an overview strip of the whole data range, and a draggable display window.
 */
export class HistogramView {
  private cum: Partial<Record<ChannelKey, Float64Array>> = {};
  private stats: Partial<Record<ChannelKey, ChannelStats>> = {};
  private total = 0;
  /** Values per channel; RAW photosite channels have fewer values than pixels. */
  private totals: Partial<Record<ChannelKey, number>> = {};
  markers: HistMarker[] = [];
  private extent: [number, number] = [-10, 10];

  /** Visible EV range of the main histogram. */
  v0 = -10;
  v1 = 10;
  yScale: YScale = 'sqrt';
  channels = new Set<ChannelKey>(['L']);
  display!: DisplayParams;

  private probe: Partial<Record<ChannelKey, number>> | null = null;
  private hoverX: number | null = null;
  private drag: Drag | null = null;
  private frame = 0;

  constructor(
    private main: HTMLCanvasElement,
    private overview: HTMLCanvasElement,
    private tooltip: HTMLElement,
    private cb: Callbacks,
  ) {
    this.bindMain();
    this.bindOverview();
    new ResizeObserver(() => this.redraw()).observe(main);
    new ResizeObserver(() => this.redraw()).observe(overview);
  }

  setImage(img: DecodedImage) {
    this.total = img.width * img.height;
    let lo = Infinity, hi = -Infinity;
    for (const k of ['L', 'R', 'G', 'B'] as ChannelKey[]) {
      const h = img.histograms[k];
      this.cum[k] = cumulative(h.bins);
      this.stats[k] = h.stats;
      const t = h.stats.pos + h.stats.zero + h.stats.neg + h.stats.nan + h.stats.inf;
      this.totals[k] = t || this.total;
      if (h.stats.pos) {
        lo = Math.min(lo, Math.log2(h.stats.minPos));
        hi = Math.max(hi, Math.log2(h.stats.maxPos));
      }
    }
    if (!Number.isFinite(lo)) [lo, hi] = [-10, 10];
    // Pad and keep a minimum span so tiny ranges are still readable.
    lo = Math.floor(lo) - 1;
    hi = Math.ceil(hi) + 1;
    if (hi - lo < 8) {
      const c = (lo + hi) / 2;
      lo = c - 4;
      hi = c + 4;
    }
    this.extent = [Math.max(EV_ORIGIN, lo), Math.min(EV_END, hi)];

    // The default view focuses on where the data is (ignoring a few far outliers such as
    // denormals); the overview strip always shows the full extent.
    const cumL = this.cum.L!;
    if (img.histograms.L.stats.pos) {
      let f0 = Math.floor(percentileEv(cumL, 0.005)) - 3;
      let f1 = Math.ceil(percentileEv(cumL, 0.9995)) + 2;
      f0 = Math.min(f0, Math.log2(img.histograms.L.stats.maxPos) - 8);
      f1 = Math.max(f1, Math.log2(img.histograms.L.stats.maxPos) + 1);
      this.focus = [Math.max(this.extent[0], f0), Math.min(this.extent[1], f1)];
    } else {
      this.focus = this.extent;
    }
    this.fitView();
  }

  private focus: [number, number] = [-10, 10];

  cumFor(k: ChannelKey) {
    return this.cum[k];
  }

  /** Zoom to the bulk of the data. Calling it again while already there shows everything. */
  fitView() {
    const atFocus = Math.abs(this.v0 - this.focus[0]) < 1e-6 && Math.abs(this.v1 - this.focus[1]) < 1e-6;
    [this.v0, this.v1] = atFocus ? this.extent : this.focus;
    this.redraw();
  }

  setProbe(p: Partial<Record<ChannelKey, number>> | null) {
    this.probe = p;
    this.redraw();
  }

  redraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.drawMain();
      this.drawOverview();
    });
  }

  // ---------- geometry ----------

  private get width() {
    return this.main.clientWidth;
  }
  private evAt(x: number) {
    return this.v0 + (x / this.width) * (this.v1 - this.v0);
  }
  private xAt(ev: number) {
    return ((ev - this.v0) / (this.v1 - this.v0)) * this.width;
  }

  private setView(v0: number, v1: number) {
    let span = Math.min(MAX_SPAN, Math.max(MIN_SPAN, v1 - v0));
    const c = (v0 + v1) / 2;
    v0 = c - span / 2;
    v1 = c + span / 2;
    if (v0 < EV_ORIGIN) [v0, v1] = [EV_ORIGIN, EV_ORIGIN + span];
    if (v1 > EV_END) [v0, v1] = [EV_END - span, EV_END];
    this.v0 = v0;
    this.v1 = v1;
    this.redraw();
    this.emitHover();
  }

  private setWindow(lo: number, hi: number) {
    if (hi < lo) [lo, hi] = [hi, lo];
    if (hi - lo < 1 / 64) hi = lo + 1 / 64;
    this.cb.onWindow(lo, hi);
  }

  // ---------- interaction: main ----------

  private bindMain() {
    const el = this.main;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const hitTest = (x: number, y: number, shift: boolean): Drag['kind'] => {
      const loX = this.xAt(this.display.lo), hiX = this.xAt(this.display.hi);
      if (shift) return 'select';
      if (Math.abs(x - loX) <= EDGE_GRAB && Math.abs(x - loX) <= Math.abs(x - hiX)) return 'lo';
      if (Math.abs(x - hiX) <= EDGE_GRAB) return 'hi';
      if (y < LANE) return x > loX && x < hiX ? 'move' : 'select';
      return 'pan';
    };
    const cursorFor: Record<string, string> = {
      lo: 'ew-resize', hi: 'ew-resize', move: 'grab', select: 'crosshair', pan: 'grab',
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const { x, y } = local(e);
      const kind = hitTest(x, y, e.shiftKey);
      const ev = this.evAt(x);
      el.setPointerCapture(e.pointerId);
      switch (kind) {
        case 'pan': this.drag = { kind, startX: x, v0: this.v0, v1: this.v1 }; el.style.cursor = 'grabbing'; break;
        case 'move': this.drag = { kind, startEv: ev, lo: this.display.lo, hi: this.display.hi }; el.style.cursor = 'grabbing'; break;
        case 'select': this.drag = { kind, anchor: ev }; break;
        default: this.drag = { kind: kind as 'lo' | 'hi' };
      }
    });

    el.addEventListener('pointermove', (e) => {
      const { x, y } = local(e);
      const d = this.drag;
      if (!d) {
        el.style.cursor = cursorFor[hitTest(x, y, e.shiftKey)];
      } else {
        const ev = this.evAt(x);
        switch (d.kind) {
          case 'pan': {
            const dEv = ((x - d.startX) / this.width) * (d.v1 - d.v0);
            this.setView(d.v0 - dEv, d.v1 - dEv);
            break;
          }
          case 'lo': this.setWindow(Math.min(ev, this.display.hi - 1 / 64), this.display.hi); break;
          case 'hi': this.setWindow(this.display.lo, Math.max(ev, this.display.lo + 1 / 64)); break;
          case 'move': this.setWindow(d.lo + ev - d.startEv, d.hi + ev - d.startEv); break;
          case 'select': this.setWindow(d.anchor, ev); break;
        }
      }
      this.hoverX = d && d.kind !== 'pan' ? null : x;
      this.updateTooltip(x, y);
      this.emitHover();
      this.redraw();
    });

    const end = (e: PointerEvent) => {
      if (!this.drag) return;
      this.drag = null;
      el.releasePointerCapture(e.pointerId);
      el.style.cursor = 'grab';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);

    el.addEventListener('pointerleave', () => {
      if (this.drag) return;
      this.hoverX = null;
      this.tooltip.hidden = true;
      this.emitHover();
      this.redraw();
    });

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x } = local(e);
      const span = this.v1 - this.v0;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const dEv = (e.deltaX / this.width) * span;
        this.setView(this.v0 + dEv, this.v1 + dEv);
      } else {
        const anchor = this.evAt(x);
        const k = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        const newSpan = Math.min(MAX_SPAN, Math.max(MIN_SPAN, span * k));
        const f = x / this.width;
        this.setView(anchor - f * newSpan, anchor + (1 - f) * newSpan);
      }
      this.updateTooltip(x, local(e).y);
    }, { passive: false });

    el.addEventListener('dblclick', () => this.fitView());
  }

  private emitHover() {
    if (this.hoverX === null || !this.cum.L) {
      this.cb.onHover(null);
      return;
    }
    // Highlight what sits under the cursor: ±3 CSS px, at least one bin.
    const half = Math.max(1 / (2 * BINS_PER_STOP), ((this.v1 - this.v0) / this.width) * 3);
    const ev = this.evAt(this.hoverX);
    this.cb.onHover([ev - half, ev + half]);
  }

  // ---------- interaction: overview ----------

  private bindOverview() {
    const el = this.overview;
    const W = () => el.clientWidth;
    const evAt = (x: number) => this.extent[0] + (x / W()) * (this.extent[1] - this.extent[0]);
    const xAt = (ev: number) => ((ev - this.extent[0]) / (this.extent[1] - this.extent[0])) * W();
    const localX = (e: PointerEvent) => e.clientX - el.getBoundingClientRect().left;
    const hit = (x: number) => {
      const a = xAt(this.v0), b = xAt(this.v1);
      if (Math.abs(x - a) <= EDGE_GRAB) return 'ov-lo';
      if (Math.abs(x - b) <= EDGE_GRAB) return 'ov-hi';
      return 'ov-pan';
    };

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const x = localX(e);
      el.setPointerCapture(e.pointerId);
      const kind = hit(x);
      if (kind === 'ov-pan') {
        const a = xAt(this.v0), b = xAt(this.v1);
        if (x < a || x > b) {
          // Jump: center the view where the user clicked.
          const span = this.v1 - this.v0;
          const c = evAt(x);
          this.setView(c - span / 2, c + span / 2);
        }
        this.drag = { kind, startX: x, v0: this.v0, v1: this.v1 };
      } else {
        this.drag = { kind };
      }
    });
    el.addEventListener('pointermove', (e) => {
      const x = localX(e);
      const d = this.drag;
      if (!d) {
        el.style.cursor = hit(x) === 'ov-pan' ? 'grab' : 'ew-resize';
        return;
      }
      const ev = evAt(x);
      if (d.kind === 'ov-pan') {
        const dEv = ((x - d.startX) / W()) * (this.extent[1] - this.extent[0]);
        this.setView(d.v0 + dEv, d.v1 + dEv);
      } else if (d.kind === 'ov-lo') {
        this.setView(Math.min(ev, this.v1 - MIN_SPAN), this.v1);
      } else if (d.kind === 'ov-hi') {
        this.setView(this.v0, Math.max(ev, this.v0 + MIN_SPAN));
      }
    });
    const end = (e: PointerEvent) => {
      this.drag = null;
      el.releasePointerCapture(e.pointerId);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => this.fitView());
  }

  // ---------- density ----------

  /** Counts per bin (1/BINS_PER_STOP stop) averaged over [ev0, ev1). */
  private density(cum: Float64Array, ev0: number, ev1: number) {
    const a = evToBin(ev0), b = evToBin(ev1);
    return (cumAt(cum, b) - cumAt(cum, a)) / Math.max(1e-9, b - a);
  }

  private yMap(d: number, max: number) {
    if (max <= 0) return 0;
    switch (this.yScale) {
      case 'linear': return d / max;
      case 'sqrt': return Math.sqrt(d / max);
      case 'log': return Math.log10(1 + d) / Math.log10(1 + max);
    }
  }

  // ---------- drawing ----------

  private prep(canvas: HTMLCanvasElement) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const g = canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h, dpr };
  }

  private drawMain() {
    const { g, w, h, dpr } = this.prep(this.main);
    const p = this.display;
    const plotTop = LANE, plotBottom = h - AXIS, plotH = plotBottom - plotTop;
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, w, h);
    if (!this.cum.L || !p) return;

    // Window lane: what each EV turns into on screen.
    this.drawLane(g, w, p);

    // Grid + ticks.
    const pxPerStop = w / (this.v1 - this.v0);
    const step = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 5, 10, 20, 50].find((s) => s * pxPerStop >= 64) ?? 50;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let ev = Math.ceil(this.v0 / step) * step; ev <= this.v1; ev += step) {
      const x = Math.round(this.xAt(ev)) + 0.5;
      const isInt = Math.abs(ev - Math.round(ev)) < 1e-9;
      g.strokeStyle = isInt && Math.round(ev) === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.07)';
      g.beginPath();
      g.moveTo(x, plotTop);
      g.lineTo(x, plotBottom);
      g.stroke();
      g.fillStyle = 'rgba(220,220,220,0.85)';
      g.fillText(fmtEv(ev, step < 1 ? 3 : 0), x, plotBottom + 4);
      g.fillStyle = 'rgba(160,160,160,0.75)';
      g.fillText(fmtValue(2 ** ev), x, plotBottom + 17);
    }

    // Histogram curves: compute densities per device pixel column.
    const cols = Math.max(1, Math.round(w * dpr));
    const keys = (['L', 'R', 'G', 'B'] as ChannelKey[]).filter((k) => this.channels.has(k));
    const dens: Record<string, Float64Array> = {};
    let max = 0;
    for (const k of keys) {
      const cum = this.cum[k]!;
      const arr = new Float64Array(cols);
      for (let c = 0; c < cols; c++) {
        const e0 = this.v0 + (c / cols) * (this.v1 - this.v0);
        const e1 = this.v0 + ((c + 1) / cols) * (this.v1 - this.v0);
        // Each channel as a share of its own values, so photosite channels compare fairly.
        arr[c] = this.density(cum, e0, e1) * (this.total / this.totals[k]!);
        if (arr[c] > max) max = arr[c];
      }
      dens[k] = arr;
    }
    for (const k of keys) {
      const arr = dens[k];
      const style = CHANNEL_STYLE[k];
      g.beginPath();
      g.moveTo(0, plotBottom);
      for (let c = 0; c < cols; c++) {
        const y = plotBottom - this.yMap(arr[c], max) * (plotH - 4);
        g.lineTo(c / dpr, y);
        g.lineTo((c + 1) / dpr, y);
      }
      g.lineTo(w, plotBottom);
      g.closePath();
      g.fillStyle = keys.length === 1 || k === 'L' ? style.fill : 'transparent';
      g.fill();
      g.strokeStyle = style.stroke;
      g.lineWidth = 1;
      g.stroke();
    }

    // Shade outside the window.
    const loX = this.xAt(p.lo), hiX = this.xAt(p.hi);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    if (loX > 0) g.fillRect(0, plotTop, Math.min(w, loX), plotH);
    if (hiX < w) g.fillRect(Math.max(0, hiX), plotTop, w - Math.max(0, hiX), plotH);
    g.strokeStyle = '#ffb02e';
    g.lineWidth = 1.5;
    for (const x of [loX, hiX]) {
      if (x < -2 || x > w + 2) continue;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, plotBottom);
      g.stroke();
    }

    // Reference markers (RAW white level, noise floor, ...).
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'top';
    let labelRow = 0;
    for (const m of [...this.markers].sort((a, b) => a.ev - b.ev)) {
      const x = Math.round(this.xAt(m.ev)) + 0.5;
      if (x < 0 || x > w) continue;
      g.strokeStyle = m.color;
      g.lineWidth = 1;
      g.setLineDash([2, 3]);
      g.beginPath();
      g.moveTo(x, plotTop);
      g.lineTo(x, plotBottom);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = m.color;
      const tw = g.measureText(m.label).width;
      const right = x + 3 + tw > w;
      g.textAlign = right ? 'right' : 'left';
      g.fillText(m.label, right ? x - 3 : x + 3, plotTop + 18 + 12 * (labelRow++ % 3));
    }
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

    // Probe markers: where the hovered image pixel sits.
    if (this.probe) {
      for (const k of ['L', 'R', 'G', 'B'] as ChannelKey[]) {
        const v = this.probe[k];
        if (v === undefined || !(v > 0) || !Number.isFinite(v)) continue;
        const x = this.xAt(Math.log2(v));
        if (x < 0 || x > w) continue;
        g.strokeStyle = CHANNEL_STYLE[k].stroke;
        g.lineWidth = k === 'L' ? 2 : 1.5;
        g.setLineDash(k === 'L' ? [] : [3, 3]);
        g.beginPath();
        g.moveTo(x, plotTop);
        g.lineTo(x, plotBottom);
        g.stroke();
        g.setLineDash([]);
      }
    }

    // Hover crosshair.
    if (this.hoverX !== null && !this.drag) {
      g.strokeStyle = 'rgba(255,240,0,0.8)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(this.hoverX + 0.5, plotTop);
      g.lineTo(this.hoverX + 0.5, plotBottom);
      g.stroke();
    }

    // Y-axis label and special-value counters.
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(200,200,200,0.7)';
    const peakPct = (max * BINS_PER_STOP / this.total) * 100;
    g.fillText(`peak ${peakPct < 0.01 ? peakPct.toExponential(1) : peakPct.toPrecision(3)}% / stop · ${this.yScale}`, 6, plotTop + 4);
    const s = this.stats.L!;
    const specials: [string, number, readonly number[]][] = [
      ['zero', s.zero, CLIP_COLORS.under],
      ['neg', s.neg, CLIP_COLORS.negative],
      ['NaN', s.nan, CLIP_COLORS.nan],
      ['Inf', s.inf, CLIP_COLORS.nan],
    ];
    g.textAlign = 'right';
    let tx = w - 6;
    for (let i = specials.length - 1; i >= 0; i--) {
      const [label, n, col] = specials[i];
      if (!n) continue;
      const text = `${label} ${fmtCount(n)}`;
      g.fillStyle = `rgb(${col.map((c) => Math.round(c * 255)).join(',')})`;
      g.fillText(text, tx, plotTop + 4);
      tx -= g.measureText(text).width + 12;
    }
  }

  private drawLane(g: CanvasRenderingContext2D, w: number, p: DisplayParams) {
    const lut = colormapLut(p.mode === 'false' ? p.colormap : 'gray');
    const img = g.createImageData(Math.max(1, Math.round(w)), 1);
    for (let x = 0; x < img.width; x++) {
      const ev = this.evAt(x + 0.5);
      const t = evToDisplayT(ev, p);
      let rgb: readonly number[];
      if (t < 0) rgb = p.clip ? CLIP_COLORS.under.map((c) => c * 0.6) : [0, 0, 0];
      else if (t > 1) rgb = p.clip ? CLIP_COLORS.over.map((c) => c * 0.6) : [1, 1, 1];
      else {
        const i = Math.round(t * 255) * 4;
        rgb = [lut[i] / 255, lut[i + 1] / 255, lut[i + 2] / 255];
      }
      img.data[x * 4] = rgb[0] * 255;
      img.data[x * 4 + 1] = rgb[1] * 255;
      img.data[x * 4 + 2] = rgb[2] * 255;
      img.data[x * 4 + 3] = 255;
    }
    // Draw the 1px strip stretched to the lane height.
    const strip = new OffscreenCanvas(img.width, 1);
    strip.getContext('2d')!.putImageData(img, 0, 0);
    g.imageSmoothingEnabled = false;
    g.drawImage(strip, 0, 0, w, LANE - 2);

    // Window label in the lane.
    const loX = this.xAt(p.lo), hiX = this.xAt(p.hi);
    const label = `${fmtEv(p.lo, 2)} … ${fmtEv(p.hi, 2)} EV  (${(p.hi - p.lo).toFixed(2)} stops)`;
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const tw = g.measureText(label).width + 10;
    const cx = Math.min(w - tw / 2 - 2, Math.max(tw / 2 + 2, (Math.max(0, loX) + Math.min(w, hiX)) / 2));
    g.fillStyle = 'rgba(0,0,0,0.65)';
    g.fillRect(cx - tw / 2, 3, tw, LANE - 8);
    g.fillStyle = '#ffd27a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, cx, LANE / 2 - 1);
  }

  private drawOverview() {
    const { g, w, h } = this.prep(this.overview);
    g.fillStyle = '#101215';
    g.fillRect(0, 0, w, h);
    const cum = this.cum.L;
    if (!cum || !this.display) return;
    const [e0, e1] = this.extent;
    const xAt = (ev: number) => ((ev - e0) / (e1 - e0)) * w;
    const cols = Math.max(1, Math.round(w));
    const arr = new Float64Array(cols);
    let max = 0;
    for (let c = 0; c < cols; c++) {
      arr[c] = this.density(cum, e0 + (c / cols) * (e1 - e0), e0 + ((c + 1) / cols) * (e1 - e0));
      max = Math.max(max, arr[c]);
    }
    g.fillStyle = 'rgba(200,200,200,0.45)';
    for (let c = 0; c < cols; c++) {
      const y = Math.sqrt(arr[c] / (max || 1)) * (h - 4);
      g.fillRect(c, h - y, 1, y);
    }
    // Display window.
    g.fillStyle = 'rgba(255,176,46,0.16)';
    const lx = xAt(this.display.lo), hx = xAt(this.display.hi);
    g.fillRect(lx, 0, hx - lx, h);
    // Visible range.
    const a = xAt(this.v0), b = xAt(this.v1);
    g.fillStyle = 'rgba(0,0,0,0.5)';
    g.fillRect(0, 0, a, h);
    g.fillRect(b, 0, w - b, h);
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.lineWidth = 1;
    g.strokeRect(Math.round(a) + 0.5, 0.5, Math.max(2, Math.round(b - a) - 1), h - 1);
  }

  // ---------- tooltip ----------

  private updateTooltip(x: number, y: number) {
    const tip = this.tooltip;
    if (this.drag || this.hoverX === null || y < LANE || !this.cum.L) {
      tip.hidden = true;
      return;
    }
    const ev = this.evAt(x);
    const half = ((this.v1 - this.v0) / this.width) * 3;
    const lines = [`<b>${fmtEv(ev, 2)} EV</b> · ${fmtValue(2 ** ev)}`];
    for (const k of ['L', 'R', 'G', 'B'] as ChannelKey[]) {
      if (!this.channels.has(k)) continue;
      const cum = this.cum[k]!;
      const total = this.totals[k]!;
      const perStop = (this.density(cum, ev - half, ev + half) * BINS_PER_STOP / total) * 100;
      const below = (cumAt(cum, evToBin(ev)) + this.stats[k]!.zero + this.stats[k]!.neg) / total * 100;
      lines.push(`<span class="k k${k}">${k}</span> ${perStop.toPrecision(3)}%/stop · ${below.toFixed(2)}% below`);
    }
    const near = this.markers.filter((m) => Math.abs(this.xAt(m.ev) - x) <= 4);
    for (const m of near) lines.push(`<span style="color:${m.color}">${m.title ?? m.label}</span>`);
    tip.innerHTML = lines.join('<br>');
    tip.hidden = false;
    const r = this.main.getBoundingClientRect();
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.min(r.width - tw - 4, x + 14)}px`;
    tip.style.top = `${Math.max(0, y - 10)}px`;
  }
}

function fmtCount(n: number) {
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

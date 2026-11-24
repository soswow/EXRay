import { colormapLut } from './colormaps';
import { CLIP_COLORS, clampWindow, evToDisplayT, MIN_WINDOW, type DisplayParams } from './display';
import { BINS_PER_STOP, cumAt, cumulative, EV_END, EV_ORIGIN, evToBin, exactBelow, percentileEv } from './histogram';
import { fmtLevel, fmtLinear, fmtRange, fmtStops, fmtValue, gridOrigin, rawReadout, SHOW_STOPS } from './format';
import type { ChannelHistogram, ChannelKey, ChannelStats, DecodedImage } from './types';

export type YScale = 'linear' | 'sqrt' | 'log';
/**
 * X axis: log2 of the value (equal width per stop), the value itself (equal width per DN for
 * RAW), or its signed square root (shot noise looks about equally wide everywhere).
 */
export type XScale = 'log' | 'linear' | 'sqrt';

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
 * The interactive histogram: an x-axis that pans and zooms like a timeline, an overview strip of
 * the whole data range, and a draggable display window.
 *
 * The view (v0, v1), extent and focus are in axis units u = toU(value), which depend on xScale.
 * The display window, markers and pixel hover stay in log2 of the value ("ev"), as the renderer
 * uses them; uOfEv / evOfU convert.
 */
export class HistogramView {
  private cum: Partial<Record<ChannelKey, Float64Array>> = {};
  /** Exact distributions (RAW photosites), used instead of the log2 bins when present. */
  private exact: Partial<Record<ChannelKey, ChannelHistogram['exact']>> = {};
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
  xScale: XScale = 'log';
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
    this.tooltip.hidden = true; // its readout belonged to the previous image
    this.total = img.width * img.height;
    let lo = Infinity, hi = -Infinity;
    for (const k of ['L', 'R', 'G', 'B'] as ChannelKey[]) {
      const h = img.histograms[k];
      this.cum[k] = cumulative(h.bins);
      this.exact[k] = h.exact;
      this.stats[k] = h.stats;
      const t = h.stats.pos + h.stats.zero + h.stats.neg + h.stats.nan + h.stats.inf;
      this.totals[k] = t || this.total;
      if (h.stats.pos) {
        lo = Math.min(lo, Math.log2(h.stats.minPos));
        hi = Math.max(hi, Math.log2(h.stats.maxPos));
      }
    }
    this.range = Number.isFinite(lo) ? [lo, hi] : null;
    this.computeExtent();
    this.fitView();
  }

  /** Switches the x axis and shows the data's focus range in the new units. */
  setXScale(x: XScale) {
    if (x === this.xScale) return;
    this.xScale = x;
    if (!this.cum.L) return;
    this.computeExtent();
    this.tooltip.hidden = true;
  }

  /** Overview extent and default view, in axis units. */
  private computeExtent() {
    const statsL = this.stats.L!;
    const cumL = this.cum.L!;
    if (this.xScale === 'log') {
      let [lo, hi] = this.range ?? [-10, 10];
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
      if (statsL.pos) {
        let f0 = Math.floor(percentileEv(cumL, 0.005)) - 3;
        let f1 = Math.ceil(percentileEv(cumL, 0.9995)) + 2;
        f0 = Math.min(f0, Math.log2(statsL.maxPos) - 8);
        f1 = Math.max(f1, Math.log2(statsL.maxPos) + 1);
        this.focus = [Math.max(this.extent[0], f0), Math.min(this.extent[1], f1)];
      } else {
        this.focus = this.extent;
      }
    } else {
      // From the lowest exact value (RAW: below black) or 0, to the largest value in any channel.
      let lo = 0, hi = 0;
      for (const k of ['L', 'R', 'G', 'B'] as ChannelKey[]) {
        const ex = this.exact[k];
        if (ex?.values.length) lo = Math.min(lo, ex.values[0]);
        hi = Math.max(hi, this.stats[k]!.maxPos);
      }
      // Reference markers (e.g. the RAW white level) stay reachable even above the data.
      for (const m of this.markers) hi = Math.max(hi, 2 ** m.ev);
      if (!(hi > lo)) hi = lo + 1;
      const e0 = this.toU(lo), e1 = this.toU(hi), pad = (e1 - e0) * 0.02;
      this.extent = [e0 - pad, e1 + pad];
      // Focus: the bulk of the luminance, and every reference marker (e.g. RAW white levels).
      let f1 = statsL.pos ? 2 ** percentileEv(cumL, 0.9995) * 1.25 : hi;
      for (const m of this.markers) f1 = Math.max(f1, 2 ** m.ev * 1.03);
      this.focus = [this.extent[0], Math.min(this.extent[1], this.toU(f1))];
    }
    [this.v0, this.v1] = this.focus;
    this.redraw();
  }

  // ---------- axis units ----------

  /** Value → axis units. */
  private toU(v: number) {
    switch (this.xScale) {
      case 'log': return v > 0 ? Math.log2(v) : -Infinity;
      case 'linear': return v;
      case 'sqrt': return Math.sign(v) * Math.sqrt(Math.abs(v));
    }
  }
  /** Axis units → value. */
  private fromU(u: number) {
    switch (this.xScale) {
      case 'log': return 2 ** u;
      case 'linear': return u;
      case 'sqrt': return Math.sign(u) * u * u;
    }
  }
  private uOfEv(ev: number) {
    return this.xScale === 'log' ? ev : this.toU(2 ** ev);
  }
  /** Axis units → log2 of the value; -Infinity where the value is 0 or negative. */
  private evOfU(u: number) {
    if (this.xScale === 'log') return u;
    const v = this.fromU(u);
    return v > 0 ? Math.log2(v) : -Infinity;
  }
  /** log2 of the value under x, kept finite (for window edits; the window is clamped to the data anyway). */
  private evAtX(x: number) {
    return Math.max(this.evOfU(this.uAt(x)), (this.range?.[0] ?? EV_ORIGIN) - 1);
  }
  /** Smallest/largest view span and how far the view may go, in axis units. */
  private limits() {
    if (this.xScale === 'log') return { min: MIN_SPAN, max: MAX_SPAN, lo: EV_ORIGIN, hi: EV_END };
    const e = this.extent[1] - this.extent[0];
    return { min: e * 1e-6, max: e * 3, lo: this.extent[0] - e, hi: this.extent[1] + e };
  }

  private focus: [number, number] = [-10, 10];
  /** log2 of the smallest and largest positive value in any channel; the window stays inside it. */
  private range: [number, number] | null = null;

  dataRange() {
    return this.range;
  }

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
  /** Axis units at canvas x. */
  private uAt(x: number) {
    return this.v0 + (x / this.width) * (this.v1 - this.v0);
  }
  /** Canvas x of axis units u. */
  private xAt(u: number) {
    return ((u - this.v0) / (this.v1 - this.v0)) * this.width;
  }

  private setView(v0: number, v1: number) {
    const lim = this.limits();
    const span = Math.min(lim.max, Math.max(lim.min, v1 - v0));
    const c = (v0 + v1) / 2;
    v0 = c - span / 2;
    v1 = c + span / 2;
    if (v0 < lim.lo) [v0, v1] = [lim.lo, lim.lo + span];
    if (v1 > lim.hi) [v0, v1] = [lim.hi - span, lim.hi];
    this.v0 = v0;
    this.v1 = v1;
    this.redraw();
    this.emitHover();
  }

  private setWindow(lo: number, hi: number, keepSpan = false) {
    if (hi < lo) [lo, hi] = [hi, lo];
    if (hi - lo < MIN_WINDOW) hi = lo + MIN_WINDOW;
    this.cb.onWindow(...clampWindow(lo, hi, this.range, keepSpan));
  }

  // ---------- interaction: main ----------

  private bindMain() {
    const el = this.main;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    const hitTest = (x: number, y: number, shift: boolean): Drag['kind'] => {
      const loX = this.xAt(this.uOfEv(this.display.lo)), hiX = this.xAt(this.uOfEv(this.display.hi));
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
      const ev = this.evAtX(x);
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
        const ev = this.evAtX(x);
        switch (d.kind) {
          case 'pan': {
            const dEv = ((x - d.startX) / this.width) * (d.v1 - d.v0);
            this.setView(d.v0 - dEv, d.v1 - dEv);
            break;
          }
          case 'lo': this.setWindow(Math.min(ev, this.display.hi - MIN_WINDOW), this.display.hi); break;
          case 'hi': this.setWindow(this.display.lo, Math.max(ev, this.display.lo + MIN_WINDOW)); break;
          case 'move': this.setWindow(d.lo + ev - d.startEv, d.hi + ev - d.startEv, true); break;
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
        const anchor = this.uAt(x);
        const k = Math.exp(e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        const lim = this.limits();
        const newSpan = Math.min(lim.max, Math.max(lim.min, span * k));
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
    // Highlight what sits under the cursor: ±3 CSS px (log axis: at least one bin).
    const halfU = ((this.v1 - this.v0) / this.width) * 3;
    const u = this.uAt(this.hoverX);
    if (this.xScale === 'log') {
      const half = Math.max(1 / (2 * BINS_PER_STOP), halfU);
      this.cb.onHover([u - half, u + half]);
    } else {
      // Values at or below zero have no log2; the renderer treats -1e9 as "all of them".
      const a = this.evOfU(u - halfU), b = this.evOfU(u + halfU);
      this.cb.onHover(b === -Infinity ? null : [Math.max(-1e9, a), b]);
    }
  }

  // ---------- interaction: overview ----------

  private bindOverview() {
    const el = this.overview;
    const W = () => el.clientWidth;
    const uAt = (x: number) => this.extent[0] + (x / W()) * (this.extent[1] - this.extent[0]);
    const xAt = (u: number) => ((u - this.extent[0]) / (this.extent[1] - this.extent[0])) * W();
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
          const c = uAt(x);
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
      const u = uAt(x), minSpan = this.limits().min;
      if (d.kind === 'ov-pan') {
        const dEv = ((x - d.startX) / W()) * (this.extent[1] - this.extent[0]);
        this.setView(d.v0 + dEv, d.v1 + dEv);
      } else if (d.kind === 'ov-lo') {
        this.setView(Math.min(u, this.v1 - minSpan), this.v1);
      } else if (d.kind === 'ov-hi') {
        this.setView(this.v0, Math.max(u, this.v0 + minSpan));
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

  /**
   * Finite values of channel k below the value v. Exact for RAW photosites (zero and negatives
   * included). Binned data only places positive values, interpolating inside a log2 bin;
   * its zeros and negatives count as lying below any positive v.
   */
  private below(k: ChannelKey, v: number) {
    const ex = this.exact[k];
    if (ex) return exactBelow(ex, v);
    const st = this.stats[k]!;
    // Negatives can't be placed, so they sit "at −∞": counted as below, never drawn.
    if (v <= 0) return st.neg;
    return st.neg + st.zero + cumAt(this.cum[k]!, evToBin(Math.log2(v)));
  }

  /** Values of channel k per axis unit over [u0, u1) (per stop on the log axis). */
  private density(k: ChannelKey, u0: number, u1: number) {
    return (this.below(k, this.fromU(u1)) - this.below(k, this.fromU(u0))) / Math.max(1e-300, u1 - u0);
  }

  /**
   * Axis ticks as values. Log: a power-of-two grid from the grid origin (RAW: black + 1, 2, 4 …
   * DN). Linear/sqrt: round numbers in what the label shows (RAW: green DN, else the value).
   */
  private ticks(w: number): { v: number; major: boolean; fine?: boolean }[] {
    if (this.xScale === 'log') {
      const pxPerStop = w / (this.v1 - this.v0);
      const step = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 5, 10, 20, 50].find((s) => s * pxPerStop >= 64) ?? 50;
      const origin = gridOrigin();
      const out = [];
      for (let i = Math.ceil((this.v0 - origin) / step); i * step <= this.v1 - origin; i++) {
        out.push({ v: 2 ** (i * step + origin), major: i === 0, fine: step < 1 });
      }
      return out;
    }
    const raw = rawReadout();
    const toL = (v: number) => (raw ? raw.black + v * raw.range : v);
    const fromL = (l: number) => (raw ? (l - raw.black) / raw.range : l);
    const nice = (x: number) => {
      if (!(x > 0)) return 1;
      const p = 10 ** Math.floor(Math.log10(x));
      return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= x)!;
    };
    const lAtX = (x: number) => toL(this.fromU(this.uAt(x)));
    const GAP = 90;
    const ls: number[] = [];
    if (this.xScale === 'linear') {
      const step = nice(Math.abs(lAtX(GAP) - lAtX(0)));
      for (let i = Math.ceil(lAtX(0) / step); i * step <= lAtX(w); i++) ls.push(i * step);
    } else {
      // Square root: spacing varies, so round closely spaced positions to local round numbers;
      // the overlap pass below thins them out.
      for (let x = 0; x <= w; x += GAP / 3) {
        const step = nice(Math.abs(lAtX(x + GAP) - lAtX(x)) / 2);
        ls.push(Math.round(lAtX(x) / step) * step);
      }
    }
    ls.push(toL(0)); // zero: black for RAW
    const ticks: { v: number; major: boolean; x: number }[] = [];
    for (const l of [...new Set(ls)]) {
      const v = fromL(l), x = this.xAt(this.toU(v));
      if (x >= -1 && x <= w + 1) ticks.push({ v, major: Math.abs(v) < 1e-12, x });
    }
    ticks.sort((a, b) => a.x - b.x);
    // Keep labels apart; zero (black) wins over its neighbors.
    const kept: typeof ticks = [];
    for (const t of ticks) {
      const prev = kept[kept.length - 1];
      if (prev && t.x - prev.x < 60) {
        if (t.major) kept[kept.length - 1] = t;
        continue;
      }
      kept.push(t);
    }
    return kept;
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

    // Grid + ticks; the brighter line marks the origin (log: the grid origin, else zero / black).
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (const t of this.ticks(w)) {
      const x = Math.round(this.xAt(this.toU(t.v))) + 0.5;
      g.strokeStyle = t.major ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.07)';
      g.beginPath();
      g.moveTo(x, plotTop);
      g.lineTo(x, plotBottom);
      g.stroke();
      g.fillStyle = 'rgba(220,220,220,0.85)';
      if (SHOW_STOPS && t.v > 0) {
        g.fillText(fmtStops(Math.log2(t.v), t.fine ? 3 : 0), x, plotBottom + 4);
        g.fillStyle = 'rgba(160,160,160,0.75)';
        g.fillText(fmtLinear(t.v), x, plotBottom + 17);
      } else if (rawReadout()) {
        // RAW: the raw integer (green), and below it the ratio to the white level.
        g.fillText(fmtLinear(t.v), x, plotBottom + 4);
        g.fillStyle = 'rgba(160,160,160,0.75)';
        g.fillText(fmtValue(t.v), x, plotBottom + 17);
      } else {
        g.fillText(fmtValue(t.v), x, plotBottom + 4);
      }
    }

    // Histogram curves: compute densities per device pixel column.
    const cols = Math.max(1, Math.round(w * dpr));
    const keys = (['L', 'R', 'G', 'B'] as ChannelKey[]).filter((k) => this.channels.has(k));
    const dens: Record<string, Float64Array> = {};
    let max = 0;
    for (const k of keys) {
      const arr = new Float64Array(cols);
      for (let c = 0; c < cols; c++) {
        const e0 = this.v0 + (c / cols) * (this.v1 - this.v0);
        const e1 = this.v0 + ((c + 1) / cols) * (this.v1 - this.v0);
        // Each channel as a share of its own values, so photosite channels compare fairly.
        arr[c] = this.density(k, e0, e1) * (this.total / this.totals[k]!);
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
    const loX = this.xAt(this.uOfEv(p.lo)), hiX = this.xAt(this.uOfEv(p.hi));
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
    // Each label goes on the first row where it doesn't overlap the previous label there.
    const rowEnds: number[] = [];
    for (const m of [...this.markers].sort((a, b) => a.ev - b.ev)) {
      const x = Math.round(this.xAt(this.uOfEv(m.ev))) + 0.5;
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
      const x0 = right ? x - 3 - tw : x + 3;
      let row = rowEnds.findIndex((end) => end < x0 - 4);
      if (row < 0) row = rowEnds.length;
      rowEnds[row] = x0 + tw;
      g.textAlign = 'left';
      g.fillText(m.label, x0, plotTop + 18 + 12 * row);
    }
    g.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

    // Probe markers: where the hovered image pixel sits.
    if (this.probe) {
      for (const k of ['L', 'R', 'G', 'B'] as ChannelKey[]) {
        const v = this.probe[k];
        if (v === undefined || !Number.isFinite(v) || (this.xScale === 'log' && !(v > 0))) continue;
        const x = this.xAt(this.toU(v));
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
    const peakPct = (max / this.total) * 100; // per stop on the log axis
    const peak = `peak ${peakPct < 0.01 ? peakPct.toExponential(1) : peakPct.toPrecision(3)}% / stop · `;
    g.fillText(`${SHOW_STOPS ? peak : ''}${this.yScale}`, 6, plotTop + 4);
    const s = this.stats.L!;
    const specials: [string, number, readonly number[]][] = [
      [rawReadout() ? 'at black' : 'zero', s.zero, CLIP_COLORS.under],
      [rawReadout() ? 'below black' : 'neg', s.neg, CLIP_COLORS.negative],
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
      const ev = this.evOfU(this.uAt(x + 0.5));
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
    const loX = this.xAt(this.uOfEv(p.lo)), hiX = this.xAt(this.uOfEv(p.hi));
    const label = fmtRange(p.lo, p.hi);
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
    if (!this.cum.L || !this.display) return;
    const [e0, e1] = this.extent;
    const xAt = (ev: number) => ((ev - e0) / (e1 - e0)) * w;
    const cols = Math.max(1, Math.round(w));
    const arr = new Float64Array(cols);
    let max = 0;
    for (let c = 0; c < cols; c++) {
      arr[c] = this.density('L', e0 + (c / cols) * (e1 - e0), e0 + ((c + 1) / cols) * (e1 - e0));
      max = Math.max(max, arr[c]);
    }
    g.fillStyle = 'rgba(200,200,200,0.45)';
    for (let c = 0; c < cols; c++) {
      const y = Math.sqrt(arr[c] / (max || 1)) * (h - 4);
      g.fillRect(c, h - y, 1, y);
    }
    // Display window.
    g.fillStyle = 'rgba(255,176,46,0.16)';
    const lx = xAt(this.uOfEv(this.display.lo)), hx = xAt(this.uOfEv(this.display.hi));
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
    const u = this.uAt(x), v = this.fromU(u), ev = this.evOfU(u);
    const halfU = ((this.v1 - this.v0) / this.width) * 3;
    // The hovered pixel column covers values [a, b).
    const a = this.fromU(this.uAt(Math.floor(x))), b = this.fromU(this.uAt(Math.floor(x) + 1));
    const raw = rawReadout();
    let head: string;
    if (SHOW_STOPS && v > 0) head = `<b>${fmtLevel(ev)}</b> · ${fmtLinear(v)}`;
    else if (raw) {
      // Position on the axis: the value, and the green DN codes this pixel column spans.
      const d0 = Math.ceil(raw.black + a * raw.range - 1e-9), d1 = Math.ceil(raw.black + b * raw.range - 1e-9) - 1;
      const span = d1 < d0 ? 'between G codes' : d1 === d0 ? `G DN ${d0}` : `G DN ${d0}–${d1}`;
      head = `<b>${fmtValue(v)}</b> × white · ${span}`;
    } else head = `<b>${fmtValue(v)}</b>`;
    const lines = [head];
    for (const k of ['L', 'R', 'G', 'B'] as ChannelKey[]) {
      if (!this.channels.has(k)) continue;
      const st = this.stats[k]!;
      const total = this.totals[k]!;
      const perStop = (this.density(k, u - halfU, u + halfU) / total) * 100;
      const below = (this.below(k, a) / total) * 100;
      const density = SHOW_STOPS && this.xScale === 'log' ? `${perStop.toPrecision(3)}%/stop · ` : '';
      // Exact channels also count what lies in this column and above it, so a single photosite shows.
      let here = '';
      if (this.exact[k]) {
        const at = this.below(k, b) - this.below(k, a);
        const above = st.pos + st.zero + st.neg - this.below(k, b);
        here = ` · ${at.toLocaleString()} here · ${above.toLocaleString()} above`;
      }
      // Binned data can't place its negatives, so left of zero it only knows the share at or below 0.
      const where = !this.exact[k] && a <= 0 ? `${(((st.neg + (a === 0 ? 0 : st.zero)) / total) * 100).toFixed(2)}% ≤ 0 (negatives not placed)` : `${below.toFixed(below > 99.99 && below < 100 ? 4 : 2)}% below`;
      lines.push(`<span class="k k${k}">${k === 'L' ? 'Y' : k}</span> ${density}${where}${here}`);
    }
    const near = this.markers.filter((m) => Math.abs(this.xAt(this.uOfEv(m.ev)) - x) <= 4);
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

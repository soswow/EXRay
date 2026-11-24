import './style.css';
import { colormapLut, type ColormapId } from './colormaps';
import { clampWindow, TRANSFERS, type DisplayMode, type DisplayParams, type Transfer, type ViewChannel } from './display';
import { pixelTypeName } from './exr-header';
import { fmtBytes, fmtLevel, fmtLinear, fmtRange, fmtValue, escapeHtml, fromStops, gridCeil, gridFloor, inputToLevel, levelToInput, setRawReadout, SHOW_STOPS } from './format';
import { percentileEv } from './histogram';
import { HistogramView, type HistMarker, type XScale, type YScale } from './histogram-view';
import { Renderer } from './renderer';
import { RAW_MODES, type ChannelKey, type DecodedImage, type LevelCandidate, type RawImage, type RawOptions, type WorkerRequest, type WorkerResponse } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------

const params: DisplayParams = {
  mode: 'log',
  channel: 'rgb',
  lo: SHOW_STOPS ? fromStops(-6) : -8,
  hi: SHOW_STOPS ? fromStops(6) : 4,
  colormap: 'turbo',
  transfer: 'srgb',
  bands: false,
  clip: true,
  isolate: false,
};

let image: DecodedImage | null = null;
/** Re-reads the current file so another part or layer can be decoded. */
let reload: ((part: number, layer?: string) => Promise<void>) | null = null;
/** RAW: which black/white levels and sensor area to use; empty means the defaults. */
let rawOptions: Partial<RawOptions> = {};
/** CSS px per image px, and CSS px offset of the image's top-left corner. */
const view = { scale: 1, x: 0, y: 0 };
let hover: [number, number] | null = null;
/** RAW sensor view: the mosaic of photosites, the demosaiced image, or the mosaic once zoomed in. */
type SensorView = 'auto' | 'demosaic' | 'mosaic';
let sensorView: SensorView = 'auto';
/** CSS px per photosite at which 'auto' switches to the mosaic. */
const MOSAIC_ZOOM = 4;
const mosaicShown = () => !!image?.raw && image.raw.kind === 'cfa' && (sensorView === 'mosaic' || (sensorView === 'auto' && view.scale >= MOSAIC_ZOOM));

// ---------- components ----------

const viewport = $('viewport');
const canvas = $<HTMLCanvasElement>('image');
let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  showError(e instanceof Error ? e.message : String(e));
  throw e;
}
renderer.setLut(colormapLut(params.colormap));

const hist = new HistogramView($<HTMLCanvasElement>('hist'), $<HTMLCanvasElement>('hist-overview'), $('hist-tip'), {
  onWindow(lo, hi) {
    params.lo = lo;
    params.hi = hi;
    syncControls();
    requestRender();
  },
  onHover(range) {
    hover = range;
    requestRender();
  },
});
hist.display = params;

const makeWorker = () => new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
let worker = makeWorker();

// ---------- rendering ----------

let frame = 0;
function requestRender() {
  hist.redraw();
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    render();
  });
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(viewport.clientWidth * dpr), h = Math.round(viewport.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  if (!image) return;
  renderer.render(
    { scale: view.scale * dpr, offsetX: view.x * dpr, offsetY: view.y * dpr },
    params,
    hover,
    image.lumaWeights,
    mosaicShown(),
  );
  const raw = image.raw?.kind === 'cfa' ? `  ·  ${mosaicShown() ? `mosaic (${image.raw.pattern})` : 'demosaiced'}` : '';
  $('zoom-label').textContent = `${view.scale >= 1 ? Math.round(view.scale * 100) : (view.scale * 100).toFixed(1)}%  ·  ${image.width}×${image.height}${raw}`;
}

new ResizeObserver(() => requestRender()).observe(viewport);

// ---------- loading ----------

function setBusy(text: string | null) {
  $('busy').hidden = text === null;
  if (text) $('busy-text').textContent = text;
}

function showError(msg: string | null) {
  const el = $('error');
  el.hidden = msg === null;
  el.textContent = msg ?? '';
}

function decodeInWorker(req: WorkerRequest, transfer: Transferable[] = []): Promise<DecodedImage> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data.type === 'result') resolve(e.data.image);
      else reject(new Error(e.data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'Worker failed'));
    worker.postMessage(req, transfer);
  });
}

async function load(name: string, getBuffer: () => Promise<ArrayBuffer>, part = 0, layer?: string, keepView = false) {
  showError(null);
  if (!keepView) rawOptions = {};
  if (!keepView && image?.raw && image.byteSize > 80 * 2 ** 20) {
    // LibRaw's WebAssembly memory never shrinks. After a very large file, a fresh worker gives
    // it back (at the cost of compiling LibRaw again, so it isn't done after every file).
    worker.terminate();
    worker = makeWorker();
  }
  setBusy(`Reading ${name}…`);
  try {
    const buffer = await getBuffer();
    setBusy(`Decoding ${name} (${fmtBytes(buffer.byteLength)})…`);
    const img = await decodeInWorker({ type: 'decode', buffer, name, part, layer, rawOptions }, [buffer]);
    reload = (p, l) => load(name, getBuffer, p, l, true);
    setImage(img, keepView);
  } catch (e) {
    showError(`Couldn't open ${name}: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setBusy(null);
  }
}

async function loadDemo() {
  showError(null);
  setBusy('Generating test image…');
  try {
    const img = await decodeInWorker({ type: 'demo' });
    reload = null;
    setImage(img, false);
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  } finally {
    setBusy(null);
  }
}

function loadFile(file: File) {
  load(file.name, () => file.arrayBuffer());
}

function loadUrl(url: string) {
  const name = decodeURIComponent(url.split('/').pop() || url);
  load(name, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.arrayBuffer();
  });
}

function setImage(img: DecodedImage, keepView: boolean) {
  try {
    renderer.setImage(img.width, img.height, img.data);
    renderer.setMosaic(img.raw?.kind === 'cfa' ? mosaicTable(img.width, img.height, img.raw) : null);
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
    return;
  }
  const first = image === null;
  image = img;
  $('empty').hidden = true;
  $('filename').textContent = img.name;
  $('filename').title = img.name;
  document.title = `${img.name} — EXRay`;

  const partSel = $<HTMLSelectElement>('part');
  partSel.hidden = img.parts.length < 2;
  partSel.innerHTML = img.parts
    .map((p) => `<option value="${p.index}">${escapeHtml(p.name ?? `part ${p.index}`)}</option>`)
    .join('');
  partSel.value = String(img.part);

  const layers = img.raw ? RAW_MODES : img.parts[img.part]?.layers ?? [];
  $('sensor').hidden = img.raw?.kind !== 'cfa';
  $('layer-label').hidden = !img.raw;
  if (img.raw) rawOptions = { ...img.raw.options };
  const layerSel = $<HTMLSelectElement>('layer');
  layerSel.hidden = layers.length < 2;
  layerSel.innerHTML = layers.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label)}</option>`).join('');
  layerSel.value = img.layer;
  if (img.luminanceOnly && params.channel !== 'rgb' && params.channel !== 'l') params.channel = 'rgb';

  // RAW axis and window positions read out as green DN, on the green channel's black and white level.
  setRawReadout(img.raw ? greenLevels(img.raw) : null);
  hist.markers = img.raw ? rawMarkers(img.raw) : [];
  $('win-auto').title = `Fit window to the ${img.raw ? '0.001–99.999' : '0.5–99.9'}% luminance percentiles (A)`;
  hist.setImage(img);
  if (!keepView || first) {
    autoWindow();
    fitImage();
  } else {
    setWindow(params.lo, params.hi, true); // the new layer may have a different range
  }
  renderInfo();
  requestRender();
}

// ---------- window ----------

/** Sets the display window, kept inside the image's data range. */
function setWindow(lo: number, hi: number, keepSpan = false) {
  [params.lo, params.hi] = clampWindow(lo, hi, hist.dataRange(), keepSpan);
}

function autoWindow() {
  const cum = hist.cumFor('L');
  if (!image || !cum || !image.histograms.L.stats.pos) return;
  // RAW: the 0.001–99.999% luminance percentiles; otherwise 0.5–99.9%.
  const [pLo, pHi] = image.raw ? [0.00001, 0.99999] : [0.005, 0.999];
  let lo = percentileEv(cum, pLo);
  let hi = percentileEv(cum, pHi);
  if (hi - lo < 1) {
    lo -= 0.5;
    hi += 0.5;
  }
  // RAW windows land exactly on the percentiles; others snap outward to quarter stops.
  if (image.raw) setWindow(lo, hi);
  else setWindow(gridFloor(lo, 4), gridCeil(hi, 4));
  syncControls();
  requestRender();
}

/** Window covers exactly the smallest to the largest positive value in any channel. */
function fullWindow() {
  const range = hist.dataRange();
  if (!image || !range) return;
  setWindow(range[0], range[1]);
  syncControls();
  requestRender();
}

// ---------- image view: pan & zoom ----------

function fitImage() {
  if (!image) return;
  const w = viewport.clientWidth, h = viewport.clientHeight;
  view.scale = Math.min(w / image.width, h / image.height) * 0.96;
  view.x = (w - image.width * view.scale) / 2;
  view.y = (h - image.height * view.scale) / 2;
  requestRender();
}

function zoomAt(cx: number, cy: number, newScale: number) {
  newScale = Math.min(512, Math.max(1 / 64, newScale));
  const ix = (cx - view.x) / view.scale, iy = (cy - view.y) / view.scale;
  view.scale = newScale;
  view.x = cx - ix * newScale;
  view.y = cy - iy * newScale;
  requestRender();
}

viewport.addEventListener('wheel', (e) => {
  if (!image) return;
  e.preventDefault();
  const r = viewport.getBoundingClientRect();
  const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015) * (e.deltaMode === 1 ? 20 : 1));
  zoomAt(e.clientX - r.left, e.clientY - r.top, view.scale * k);
}, { passive: false });

let pan: { x: number; y: number; vx: number; vy: number } | null = null;
viewport.addEventListener('pointerdown', (e) => {
  if (!image || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
  pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  viewport.setPointerCapture(e.pointerId);
  viewport.classList.add('panning');
});
viewport.addEventListener('pointermove', (e) => {
  if (pan) {
    view.x = pan.vx + e.clientX - pan.x;
    view.y = pan.vy + e.clientY - pan.y;
    requestRender();
  }
  updateProbe(e);
});
const endPan = (e: PointerEvent) => {
  if (!pan) return;
  pan = null;
  viewport.releasePointerCapture(e.pointerId);
  viewport.classList.remove('panning');
};
viewport.addEventListener('pointerup', endPan);
viewport.addEventListener('pointercancel', endPan);
viewport.addEventListener('pointerleave', () => {
  $('probe').hidden = true;
  hist.setProbe(null);
});
viewport.addEventListener('dblclick', () => fitImage());

// ---------- pixel probe ----------

function updateProbe(e: PointerEvent) {
  if (!image) return;
  const r = viewport.getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left - view.x) / view.scale);
  const y = Math.floor((e.clientY - r.top - view.y) / view.scale);
  const probe = $('probe');
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    probe.hidden = true;
    hist.setProbe(null);
    return;
  }
  const i = ((image.height - 1 - y) * image.width + x) * 4;
  const d = image.data;
  const [R, G, B, A] = [d[i], d[i + 1], d[i + 2], d[i + 3]];
  const w = image.lumaWeights;
  const L = w[0] * R + w[1] * G + w[2] * B;
  const raw = image.raw;
  if (raw) return rawProbe(probe, raw, x, y, R, G, B, L);
  const row = (k: string, v: number) => `<span class="k${k}">${k}</span> ${fmtValue(v).padStart(10)}`;
  const lines = [coordLine(x, y)];
  if (image.luminanceOnly) lines.push(row('L', R));
  else lines.push(row('R', R), row('G', G), row('B', B), row('L', L));
  if (image.hasAlpha) lines.push(row('A', A));
  probe.innerHTML = lines.join('\n');
  probe.hidden = false;
  hist.setProbe(image.luminanceOnly ? { L: R } : { R, G, B, L });
}

/** "x 12  y 345", padded to the image's widest coordinates so the line never shifts. */
function coordLine(x: number, y: number) {
  const img = image!;
  return `x ${String(x).padStart(String(img.width - 1).length)}  y ${String(y).padStart(String(img.height - 1).length)}`;
}

function rawProbe(probe: HTMLElement, raw: RawImage, x: number, y: number, R: number, G: number, B: number, L: number) {
  const names = ['R', 'G', 'B', 'G2'];
  const chOf = (c: number) => (c === 3 ? 1 : c);
  const { width: w, height: h } = image!;
  const lines = [coordLine(x, y)];
  const val = (v: number) => (Number.isFinite(v) ? v.toFixed(5) : fmtValue(v)).padStart(9);

  if (raw.kind === 'linear') {
    // Three raw integers per pixel, nothing interpolated.
    lines.push(`<span class="ev">   raw DN     value</span>`);
    [R, G, B].forEach((v, c) => lines.push(`<span class="k${names[c]}">${names[c]}</span> ${String(raw.dn[(y * w + x) * 3 + c]).padStart(7)} ${val(v)}`));
    lines.push(`<span class="kL">Y</span> ${''.padStart(7)} ${val(L)} <span class="ev">luminance</span>`);
    probe.innerHTML = lines.join('\n');
    probe.hidden = false;
    hist.setProbe({ R, G, B, L });
    return;
  }

  // The 3×3 photosites around the cursor, as raw integers in their own colors.
  const cellAt = (xx: number, yy: number) => (yy % raw.cellH) * raw.cellW + (xx % raw.cellW);
  lines.push('<span class="ev">photosites (raw DN)</span>');
  for (let dy = -1; dy <= 1; dy++) {
    const row: string[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
        row.push(' '.repeat(8));
        continue;
      }
      const c = raw.cellColor[cellAt(xx, yy)];
      const text = `${names[c].padEnd(2)}${String(raw.dn[yy * w + xx]).padStart(6)}`;
      row.push(`<span class="k${names[chOf(c)]}${dx || dy ? '' : ' here'}">${text}</span>`);
    }
    lines.push(row.join(' '));
  }
  const cell = cellAt(x, y), site = raw.cellColor[cell];
  const dn = raw.dn[y * w + x], black = raw.cellBlack[cell], white = raw.cellWhite[cell];
  const v = (dn - black) * raw.cellScale[cell];
  const wbNote = raw.mode === 'cam' ? '' : ` × WB ${raw.wb[chOf(site)].toFixed(3)}`;
  lines.push(`<span class="ev">${names[site]}: (DN − ${fmtDnLevel(black)}) ÷ (${fmtDnLevel(white)} − ${fmtDnLevel(black)})${wbNote}</span>`);
  lines.push(`<span class="k${names[chOf(site)]}">${names[site].padEnd(2)}</span> ${String(dn).padStart(6)} → ${v.toFixed(5)}`);

  if (mosaicShown()) {
    probe.innerHTML = lines.join('\n');
    probe.hidden = false;
    hist.setProbe({ [names[chOf(site)]]: v });
    return;
  }
  // Demosaiced values: only the photosite's own channel is measured; the others are bilinear means.
  const mixed = raw.mode === '709';
  lines.push(`<span class="ev">demosaiced${mixed ? ', WB + rgb_cam' : ' (bilinear)'}</span>`);
  [R, G, B].forEach((value, c) => {
    const tag = mixed ? 'mixed' : c === chOf(site) ? 'photosite' : 'interpolated';
    lines.push(`<span class="k${names[c]}">${names[c]} </span>${val(value)} <span class="ev">${tag}</span>`);
  });
  lines.push(`<span class="kL">Y </span>${val(L)} <span class="ev">luminance</span>`);
  probe.innerHTML = lines.join('\n');
  probe.hidden = false;
  hist.setProbe({ R, G, B, L });
}

/** A black or white level: integers as is, measured means with two decimals. */
const fmtDnLevel = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

/** Black level and range (white − black) of the green channel, which white balance leaves alone. */
function greenLevels(raw: RawImage) {
  const i = Math.max(0, raw.cellColor.findIndex((c) => c === 1 || c === 3));
  return { black: raw.cellBlack[i], range: raw.cellWhite[i] - raw.cellBlack[i] };
}

/** Read-noise numbers for a RAW file, when the masked border allows an estimate. */
function rawNoise(raw: RawImage) {
  if (!raw.noise) return null;
  const { range } = greenLevels(raw);
  return { sigma: raw.noise.sigma, norm: raw.noise.sigma / range, dr: Math.log2(range / raw.noise.sigma) };
}

const usedLabel = <T extends string>(list: LevelCandidate<T>[], id: T) => list.find((c) => c.id === id)?.label ?? id;

/** Sensor reference levels on the histogram, in the normalized (green) scale. */
function rawMarkers(raw: RawImage): HistMarker[] {
  const { black, range } = greenLevels(raw);
  const whiteLabel = usedLabel(raw.whites, raw.options.white);
  const m: HistMarker[] = [{ ev: 0, label: 'white', color: '#ff6b6b', title: `White level used: ${fmtDnLevel(black + range)} DN (${whiteLabel}) = 1.0` }];
  const colors = ['#ffa94d', '#ffd43b', '#e599f7'];
  raw.whites
    .filter((c) => c.id !== raw.options.white && c.values[1] !== null && c.values[1]! > black && c.values[1] !== black + range)
    .forEach((c, i) => m.push({
      ev: Math.log2((c.values[1]! - black) / range),
      label: c.label,
      color: colors[i % colors.length],
      title: `${c.label}: ${c.values[1]} DN (G). ${c.source}`,
    }));
  if (raw.pattern !== 'demosaiced by LibRaw') {
    m.push({ ev: Math.log2(1 / range), label: '1 DN', color: '#74c0fc', title: 'One raw step above black: below this, values are quantized to single integers' });
  }
  const n = rawNoise(raw);
  if (n) m.push({ ev: Math.log2(n.norm), label: 'read noise σ', color: '#b197fc', title: `Read noise ${n.sigma.toFixed(2)} DN from masked pixels: SNR 1 here, ${n.dr.toFixed(2)} stops below white` });
  return m;
}

/** Per-cell RGBA table for the mosaic shader: color index, black level, scale. */
function mosaicTable(width: number, height: number, raw: RawImage) {
  const cell = new Float32Array(raw.cellW * raw.cellH * 4);
  for (let i = 0; i < raw.cellW * raw.cellH; i++) {
    cell[i * 4] = raw.cellColor[i];
    cell[i * 4 + 1] = raw.cellBlack[i];
    cell[i * 4 + 2] = raw.cellScale[i];
  }
  return { width, height, dn: raw.dn, cellW: raw.cellW, cellH: raw.cellH, cell };
}

// ---------- info panel ----------

function renderInfo() {
  const el = $('info');
  if (!image) {
    el.innerHTML = '';
    return;
  }
  const img = image;
  const part = img.parts[img.part];
  const raw = img.raw;
  const rows: string[] = [];
  const dl = (pairs: [string, string][]) =>
    `<dl>${pairs.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;

  const area = raw?.areas.find((a) => a.id === raw.options.crop);
  const fileInfo: [string, string][] = [
    ['Name', img.name],
    ['Size', fmtBytes(img.byteSize)],
    ['Resolution', `${img.width} × ${img.height}${area ? ` (${area.label})` : ''}`],
  ];
  if (part) {
    fileInfo.push(['Compression', part.compression]);
    fileInfo.push(['Storage', `${part.deep ? 'deep ' : ''}${part.tiled ? 'tiled' : 'scanline'}`]);
    fileInfo.push(['Channels', part.channels.map((c) => `${c.name}:${pixelTypeName(c.pixelType)}`).join(' ')]);
    if (img.parts.length > 1) fileInfo.push(['Parts', String(img.parts.length)]);
    const [x0, y0, x1, y1] = part.dataWindow, [dx0, dy0, dx1, dy1] = part.displayWindow;
    fileInfo.push(['Data window', `${x0},${y0} – ${x1},${y1}`]);
    if (x0 !== dx0 || y0 !== dy0 || x1 !== dx1 || y1 !== dy1) fileInfo.push(['Display window', `${dx0},${dy0} – ${dx1},${dy1}`]);
  }
  fileInfo.push(['Y coefficients', `${img.lumaWeights.map((v) => v.toFixed(4)).join(', ')} — ${lumaSource(img)}`]);
  fileInfo.push(['Decode', `${img.timings.decodeMs.toFixed(0)} ms · histogram ${img.timings.histMs.toFixed(0)} ms`]);
  if (raw) fileInfo.push(['RAW timing', `LibRaw ${raw.timings.unpackMs ? `${raw.timings.unpackMs.toFixed(0)} ms` : 'cached'} · develop ${raw.timings.developMs.toFixed(0)} ms`]);
  rows.push('<h2>Image</h2>', dl(fileInfo));
  if (raw) rows.push(...rawInfo(raw));
  if (part?.chromaticities) {
    rows.push('<p class="note">Primaries are shown as raw RGB — no gamut conversion yet. Luminance uses the file\'s chromaticities.</p>');
  }

  // Dynamic range of luminance. RAW values are ratios to the white level, not DN.
  const L = img.histograms.L.stats;
  const cum = hist.cumFor('L')!;
  const range = (lo: number, hi: number) => (raw ? `${fmtValue(2 ** lo)} … ${fmtValue(2 ** hi)} × white (${(hi - lo).toFixed(2)} stops)` : fmtRange(lo, hi));
  const drPairs: [string, string][] = [];
  if (L.pos) {
    const lo = Math.log2(L.minPos), hi = Math.log2(L.maxPos);
    drPairs.push(['Full', range(lo, hi)]);
    for (const [a, b] of [[0.001, 0.999], [0.01, 0.99]]) {
      const pa = percentileEv(cum, a), pb = percentileEv(cum, b);
      drPairs.push([`${a * 100}–${b * 100}%`, range(pa, pb)]);
    }
    const med = percentileEv(cum, 0.5);
    drPairs.push(['Median', raw ? `${fmtValue(2 ** med)} × white` : fmtLevel(med)]);
  }
  rows.push('<h2>Luminance (Y) dynamic range</h2>', drPairs.length ? dl(drPairs) : '<p class="note">No positive values.</p>');
  if (SHOW_STOPS && drPairs.length) rows.push('<p class="note">Stops are relative to 0.18 middle grey.</p>');

  if (raw) {
    // Photosite statistics in raw integers, straight from the file.
    const names = ['R', 'G', 'B'];
    const cols = raw.dnStats.map((d, k) => ({ k, d })).filter((c) => c.d.count);
    const pct = (n: number, t: number) => (n ? (n / t < 0.0001 ? n.toLocaleString() : `${((n / t) * 100).toFixed(2)}%`) : '·');
    const row = (label: string, f: (d: RawImage['dnStats'][number]) => string, title = '') =>
      `<tr title="${escapeHtml(title)}"><td>${label}</td>${cols.map((c) => `<td>${f(c.d)}</td>`).join('')}</tr>`;
    rows.push(
      `<h2>${raw.kind === 'cfa' ? 'Photosites' : 'Pixels'} (raw DN)</h2>`,
      `<table><tr><th></th>${cols.map((c) => `<th class="k${names[c.k]}">${names[c.k]}</th>`).join('')}</tr>` +
        row('max', (d) => String(d.max)) +
        row('at max', (d) => pct(d.atMax, d.count), 'Share of photosites with exactly the maximum DN') +
        row('min', (d) => String(d.min)) +
        row('≤ black', (d) => pct(d.atOrBelowBlack, d.count), 'At or below the black level in use') +
        row('count', (d) => d.count.toLocaleString()) +
        '</table>',
    );
  } else {
    const keys: ChannelKey[] = img.luminanceOnly ? ['L'] : ['R', 'G', 'B', 'L'];
    const totals = Object.fromEntries(keys.map((k) => {
      const s = img.histograms[k].stats;
      return [k, s.pos + s.zero + s.neg + s.nan + s.inf];
    }));
    let total = img.width * img.height;
    const stat = (f: (s: DecodedImage['histograms']['L']['stats']) => string) =>
      keys.map((k) => {
        total = totals[k] || img.width * img.height;
        return `<td>${f(img.histograms[k].stats)}</td>`;
      }).join('');
    const pct = (n: number) => (n ? (n / total < 0.0001 ? n.toString() : `${((n / total) * 100).toFixed(2)}%`) : '·');
    rows.push(
      '<h2>Channels</h2>',
      `<table><tr><th></th>${keys.map((k) => `<th>${k === 'L' ? 'Y' : k}</th>`).join('')}</tr>` +
        `<tr><td>max</td>${stat((s) => fmtLinear(s.maxPos))}</tr>` +
        `<tr><td>min &gt; 0</td>${stat((s) => fmtLinear(s.minPos))}</tr>` +
        `<tr><td>min</td>${stat((s) => (s.neg ? fmtLinear(s.minNeg) : s.zero ? fmtLinear(0) : fmtLinear(s.minPos)))}</tr>` +
        `<tr><td>zero</td>${stat((s) => pct(s.zero))}</tr>` +
        `<tr><td>negative</td>${stat((s) => pct(s.neg))}</tr>` +
        `<tr><td>NaN</td>${stat((s) => pct(s.nan))}</tr>` +
        `<tr><td>Inf</td>${stat((s) => pct(s.inf))}</tr></table>`,
    );
  }

  if (part) {
    rows.push(
      `<details><summary>All header attributes (${part.attributes.length})</summary>`,
      dl(part.attributes.map((a) => [`${a.name}`, a.display])),
      '</details>',
    );
  }
  if (img.synthetic) {
    rows.push('<p class="note">Synthetic image: a 40-stop log ramp, exact power-of-two patches (2⁻²⁴ … 2¹⁶), a scene with a 2¹⁴ sun, and a strip of 0 / negative / NaN / Inf / denormal values.</p>');
  }
  el.innerHTML = rows.join('');
}

/** What the luminance coefficients are and which RGB they apply to. */
function lumaSource(img: DecodedImage) {
  const raw = img.raw;
  if (raw) {
    if (raw.mode === '709') return 'Rec.709 Y';
    const on = raw.mode === 'cam' ? 'camera RGB without white balance' : 'white-balanced camera RGB';
    return `Rec.709 Y after WB and LibRaw rgb_cam, applied to ${on} (negative weights and a sum ≠ 1 are expected there)`;
  }
  if (img.synthetic) return 'Rec.709 Y';
  return img.parts[img.part]?.chromaticities ? 'Y row of RGB → XYZ from the file\'s chromaticities' : 'Rec.709 Y (the file has no chromaticities)';
}

/** The RAW sections of the info panel: sensor areas, levels with their sources, and processing. */
function rawInfo(raw: RawImage): string[] {
  const out: string[] = [];
  const esc = escapeHtml;
  const opt = (name: keyof RawOptions, items: { id: string; label: string }[], value: string) =>
    items.length < 2
      ? ''
      : `<select data-opt="${name}">${items.map((i) => `<option value="${esc(i.id)}"${i.id === value ? ' selected' : ''}>${esc(i.label)}</option>`).join('')}</select>`;

  // Metadata.
  const meta: [string, string][] = raw.attributes.map((a) => [a.name, a.display]);
  meta.push(['Sensor', `${raw.pattern}${raw.kind === 'cfa' ? ` (${raw.cellW}×${raw.cellH} cell)` : ''}`]);
  out.push('<h2>RAW</h2>', dlHtml(meta.map(([k, v]) => [esc(k), esc(v)])));

  // Sensor areas.
  out.push('<h2>Sensor area</h2>', `<table class="src"><tr><th></th><th>size</th><th>origin</th></tr>${raw.areas
    .map((a) => `<tr class="${a.id === raw.options.crop ? 'used' : ''}" title="${esc(a.source)}"><td>${esc(a.label)}</td><td>${a.w} × ${a.h}</td><td>${a.x}, ${a.y}</td></tr>`)
    .join('')}</table>`);
  const flipNote = raw.attributes.some((a) => a.name === 'Orientation') ? ' Sizes are in sensor orientation, before rotation.' : '';
  out.push(`<p class="note">Full readout ${raw.rawSize[0]} × ${raw.rawSize[1]}. Hover a row for its source.${flipNote}</p>`);
  const crop = opt('crop', raw.areas, raw.options.crop);
  if (crop) out.push(`<label class="pick">Show ${crop}</label>`);

  // Levels: every candidate, per CFA color, with the one in use highlighted.
  const order = raw.cellColor.includes(3) ? [0, 1, 3, 2] : [0, 1, 2];
  const names = ['R', 'G', 'B', 'G2'], cls = ['kR', 'kG', 'kB', 'kG'];
  const lvl = (v: number | null) => (v === null ? '·' : fmtDnLevel(Math.round(v * 100) / 100));
  const candRows = <T extends string>(list: LevelCandidate<T>[], used: T) =>
    list.map((c) => `<tr class="${c.id === used ? 'used' : ''}" title="${esc(c.source)}"><td>${esc(c.label)}</td>${order.map((k) => `<td>${lvl(c.values[k])}</td>`).join('')}</tr>` +
      (c.detail ? `<tr class="detail"><td></td>${order.map((k) => `<td>${esc(c.detail![k] ?? '')}</td>`).join('')}</tr>` : '')).join('');
  out.push('<h2>Levels (DN)</h2>',
    `<table class="src"><tr><th></th>${order.map((k) => `<th class="${cls[k]}">${names[k]}</th>`).join('')}</tr>` +
      `<tr class="group"><td colspan="${order.length + 1}">Black</td></tr>${candRows(raw.blacks, raw.options.black)}` +
      `<tr class="group"><td colspan="${order.length + 1}">White</td></tr>${candRows(raw.whites, raw.options.white)}</table>`);
  const pickB = opt('black', raw.blacks, raw.options.black), pickW = opt('white', raw.whites, raw.options.white);
  if (pickB || pickW) out.push(`<div class="pick">${pickB ? `<label>Black ${pickB}</label>` : ''}${pickW ? `<label>White ${pickW}</label>` : ''}</div>`);
  out.push('<p class="note">Highlighted rows are applied. Hover a row for where the numbers come from.</p>');

  // Processing.
  const proc: [string, string][] = [];
  const steps = ['value = (DN − black) ÷ (white − black)'];
  if (raw.mode !== 'cam') steps.push('× WB');
  if (raw.mode === '709') steps.push('demosaic, then × rgb_cam');
  proc.push(['Readout', steps.join(', ')]);
  const { range } = greenLevels(raw);
  if (raw.pattern !== 'demosaiced by LibRaw') proc.push(['Quantization', `${Math.log2(range).toFixed(2)} stops from 1 DN to white (G)`]);
  const n = rawNoise(raw);
  if (raw.noise && n) {
    proc.push(['Read noise', `σ ${n.sigma.toFixed(2)} DN (MAD of ${raw.noise.region}, ${raw.noise.pixels.toLocaleString()} px)`]);
    proc.push(['Engineering DR', `${n.dr.toFixed(2)} stops (white − black) ÷ σ, G`]);
  } else if (raw.kind === 'cfa') {
    proc.push(['Read noise', 'no masked border in this file']);
  }
  proc.push(['White balance', `R ${raw.wb[0].toFixed(4)} · G 1 · B ${raw.wb[2].toFixed(4)} — ${raw.wbSource}, normalized to G`]);
  proc.push(['rgb_cam', [0, 1, 2].map((i) => raw.rgbCam.slice(i * 3, i * 3 + 3).map((v) => v.toFixed(4)).join(' ')).join('  |  ') + ' — LibRaw: white-balanced camera RGB → linear sRGB/Rec.709 primaries, D65']);
  proc.push(['Demosaic', raw.kind === 'cfa' ? 'bilinear (mean of same-color neighbors)' : 'none']);
  out.push('<h2>Processing</h2>', dl2(proc));
  for (const note of raw.notes) out.push(`<p class="note">${esc(note)}</p>`);
  if (raw.kind === 'cfa' && raw.mode !== '709') out.push('<p class="note">Histogram R/G/B: exact photosite counts, one value per raw integer. Y: luminance of the demosaiced image, in 1/64-stop bins.</p>');
  return out;
}

const dlHtml = (pairs: [string, string][]) => `<dl>${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
const dl2 = (pairs: [string, string][]) => dlHtml(pairs.map(([k, v]) => [escapeHtml(k), escapeHtml(v)]));

// Level and area pickers in the info panel re-develop the RAW file.
$('info').addEventListener('change', (e) => {
  const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('select[data-opt]');
  if (!sel || !image?.raw) return;
  rawOptions = { ...rawOptions, [sel.dataset.opt!]: sel.value };
  reload?.(image.part, image.layer);
});

// ---------- controls ----------

function bindSeg(id: string, get: () => string, set: (v: string) => void) {
  const el = $(id);
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b?.dataset.v) return;
    set(b.dataset.v);
    syncControls();
    requestRender();
  });
  return () => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === get())));
}

const syncMode = bindSeg('mode', () => params.mode, (v) => (params.mode = v as DisplayMode));
const syncY = bindSeg('yscale', () => hist.yScale, (v) => (hist.yScale = v as YScale));
const syncX = bindSeg('xscale', () => hist.xScale, (v) => hist.setXScale(v as XScale));

const histChannels = $('hist-channels');
histChannels.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  const k = b?.dataset.v as ChannelKey | undefined;
  if (!k) return;
  if (hist.channels.has(k) && hist.channels.size > 1) hist.channels.delete(k);
  else hist.channels.add(k);
  syncControls();
  hist.redraw();
});

const transferSel = $<HTMLSelectElement>('transfer');
transferSel.innerHTML = TRANSFERS.map((t) => `<option value="${t.id}" title="${t.title}">${t.label}</option>`).join('');
transferSel.addEventListener('change', () => {
  params.transfer = transferSel.value as Transfer;
  requestRender();
});

const colormapSel = $<HTMLSelectElement>('colormap');
colormapSel.addEventListener('change', () => {
  params.colormap = colormapSel.value as ColormapId;
  renderer.setLut(colormapLut(params.colormap));
  requestRender();
});
const sensorSel = $<HTMLSelectElement>('sensor');
sensorSel.addEventListener('change', () => {
  sensorView = sensorSel.value as SensorView;
  requestRender();
});
const channelSel = $<HTMLSelectElement>('channel');
channelSel.addEventListener('change', () => {
  params.channel = channelSel.value as ViewChannel;
  requestRender();
});
for (const id of ['bands', 'clip', 'isolate'] as const) {
  $<HTMLInputElement>(id).addEventListener('change', (e) => {
    params[id] = (e.target as HTMLInputElement).checked;
    syncControls();
    requestRender();
  });
}

const winLo = $<HTMLInputElement>('win-lo'), winHi = $<HTMLInputElement>('win-hi');
const onWinInput = () => {
  const lo = inputToLevel(parseFloat(winLo.value)), hi = inputToLevel(parseFloat(winHi.value));
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
    setWindow(lo, hi);
    requestRender();
  }
};
if (!SHOW_STOPS) {
  // Window inputs take linear values; bands are per power of two.
  $('win-unit').hidden = true;
  $('win-label').removeAttribute('title');
  for (const el of [winLo, winHi]) {
    el.step = 'any';
    el.classList.add('no-spin');
  }
  $('bands-text').textContent = 'Bands';
  $('bands-text').parentElement!.title = 'One color band per power of two (B)';
}
winLo.addEventListener('input', onWinInput);
winHi.addEventListener('input', onWinInput);
// On commit, show the window as it actually is (typed values may have been clamped).
for (const [el, side] of [[winLo, 'lo'], [winHi, 'hi']] as const) {
  const show = () => (el.value = levelToInput(params[side]));
  el.addEventListener('change', show);
  el.addEventListener('keydown', (e) => e.key === 'Enter' && show());
}
$('win-auto').addEventListener('click', autoWindow);
$('win-full').addEventListener('click', fullWindow);
$('hist-fit').addEventListener('click', () => hist.fitView());

$('part').addEventListener('change', (e) => reload?.(parseInt((e.target as HTMLSelectElement).value, 10)));
$('layer').addEventListener('change', (e) => reload?.(image?.part ?? 0, (e.target as HTMLSelectElement).value));

function syncControls() {
  syncMode();
  syncY();
  syncX();
  histChannels.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(hist.channels.has(b.dataset.v as ChannelKey))),
  );
  colormapSel.disabled = params.mode !== 'false';
  transferSel.disabled = params.mode !== 'linear';
  transferSel.value = params.transfer;
  $<HTMLInputElement>('bands').disabled = params.mode !== 'false';
  $<HTMLInputElement>('bands').checked = params.bands;
  $<HTMLInputElement>('clip').checked = params.clip;
  $<HTMLInputElement>('isolate').checked = params.isolate;
  channelSel.value = params.channel;
  sensorSel.value = sensorView;
  if (document.activeElement !== winLo) winLo.value = levelToInput(params.lo);
  if (document.activeElement !== winHi) winHi.value = levelToInput(params.hi);
  document.querySelector('.legend')!.classList.toggle('off', !params.clip);
}

const toggleInfo = () => {
  $('info').hidden = !$('info').hidden;
  requestRender();
};
$('toggle-info').addEventListener('click', toggleInfo);

// File opening.
const fileInput = $<HTMLInputElement>('file');
const openPicker = () => fileInput.click();
$('open').addEventListener('click', openPicker);
$('empty-open').addEventListener('click', openPicker);
$('demo').addEventListener('click', loadDemo);
$('empty-demo').addEventListener('click', loadDemo);
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = '';
});

// Drag & drop anywhere.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  $('drop').hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop').hidden = true;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const f = e.dataTransfer?.files[0];
  if (f) loadFile(f);
});

// Resizable histogram panel.
$('hist-resize').addEventListener('pointerdown', (e) => {
  const el = e.target as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const startY = e.clientY;
  const startH = $('hist-panel').getBoundingClientRect().height;
  const move = (ev: PointerEvent) => {
    const h = Math.min(window.innerHeight * 0.8, Math.max(140, startH - (ev.clientY - startY)));
    document.body.style.setProperty('--hist-h', `${h}px`);
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
});

// Keyboard shortcuts.
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const actions: Record<string, () => void> = {
    '1': () => (params.mode = 'log'),
    '2': () => (params.mode = 'linear'),
    '3': () => (params.mode = 'false'),
    c: () => (params.clip = !params.clip),
    i: () => (params.isolate = !params.isolate),
    b: () => (params.bands = !params.bands),
    a: autoWindow,
    f: fitImage,
    h: () => hist.fitView(),
    o: openPicker,
    m: () => {
      if (!image?.raw || image.raw.kind !== 'cfa') return;
      const order: SensorView[] = ['auto', 'mosaic', 'demosaic'];
      sensorView = order[(order.indexOf(sensorView) + 1) % order.length];
    },
    '0': () => image && zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, 1 / (window.devicePixelRatio || 1)),
    '[': () => setWindow(params.lo - 0.5, params.hi - 0.5, true),
    ']': () => setWindow(params.lo + 0.5, params.hi + 0.5, true),
  };
  const fn = actions[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
  syncControls();
  requestRender();
});

syncControls();

// ?url=<exr url> or ?demo on startup.
const q = new URLSearchParams(location.search);
if (q.get('url')) loadUrl(q.get('url')!);
else if (q.has('demo')) loadDemo();

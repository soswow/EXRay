import './style.css';
import { colormapLut, type ColormapId } from './colormaps';
import { clampWindow, type DisplayMode, type DisplayParams, type ViewChannel } from './display';
import { pixelTypeName } from './exr-header';
import { fmtBytes, fmtLevel, fmtLinear, fmtRange, fmtValue, escapeHtml, fromStops, gridCeil, gridFloor, inputToLevel, levelToInput, rawReadout, setRawReadout, SHOW_STOPS } from './format';
import { percentileEv } from './histogram';
import { HistogramView, type HistMarker, type YScale } from './histogram-view';
import { Renderer } from './renderer';
import { RAW_MODES, type ChannelKey, type DecodedImage, type RawImage, type WorkerRequest, type WorkerResponse } from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- state ----------

const params: DisplayParams = {
  mode: 'log',
  channel: 'rgb',
  lo: SHOW_STOPS ? fromStops(-6) : -8,
  hi: SHOW_STOPS ? fromStops(6) : 4,
  colormap: 'turbo',
  bands: false,
  clip: true,
  isolate: false,
};

let image: DecodedImage | null = null;
/** Re-reads the current file so another part or layer can be decoded. */
let reload: ((part: number, layer?: string) => Promise<void>) | null = null;
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
    const img = await decodeInWorker({ type: 'decode', buffer, name, part, layer }, [buffer]);
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
  const layerSel = $<HTMLSelectElement>('layer');
  layerSel.hidden = layers.length < 2;
  layerSel.innerHTML = layers.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label)}</option>`).join('');
  layerSel.value = img.layer;
  if (img.luminanceOnly && params.channel !== 'rgb' && params.channel !== 'l') params.channel = 'rgb';

  // RAW files read out as raw integers, on the green channel's black level and range.
  setRawReadout(img.raw ? { black: greenBlack(img.raw), range: img.raw.white - greenBlack(img.raw) } : null);
  hist.markers = img.raw ? rawMarkers(img.raw) : [];
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
  let lo = percentileEv(cum, 0.005);
  let hi = percentileEv(cum, 0.999);
  if (hi - lo < 1) {
    lo -= 0.5;
    hi += 0.5;
  }
  setWindow(gridFloor(lo, 4), gridCeil(hi, 4));
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
  const lines = [`x ${x}  y ${y}`];
  if (image.luminanceOnly) lines.push(row('L', R));
  else lines.push(row('R', R), row('G', G), row('B', B), row('L', L));
  if (image.hasAlpha) lines.push(row('A', A));
  probe.innerHTML = lines.join('\n');
  probe.hidden = false;
  hist.setProbe(image.luminanceOnly ? { L: R } : { R, G, B, L });
}

function rawProbe(probe: HTMLElement, raw: RawImage, x: number, y: number, R: number, G: number, B: number, L: number) {
  const names = ['R', 'G', 'B', 'G2'];
  const w = image!.width;
  // Photosite under the cursor (mosaic files): its color and cell.
  const cell = raw.kind === 'cfa' ? (y % raw.cellH) * raw.cellW + (x % raw.cellW) : -1;
  const site = cell >= 0 ? raw.cellColor[cell] : -1;
  const siteChannel = site === 3 ? 1 : site;

  // Value → raw integer for channel c: DN = black + value / scale (scale includes white balance).
  const cellOf = (c: number) => {
    const i = raw.cellColor.findIndex((k) => k === c || (c === 1 && k === 3));
    return Math.max(0, i);
  };
  const toDn = (c: number, v: number) => raw.cellBlack[cellOf(c)] + v / raw.cellScale[cellOf(c)];
  const approx = raw.mode === '709';
  // Fixed-width columns: label, DN, ratio. The header uses the same widths.
  const cols = (label: string, dn: string, ratio: string) => [label.padEnd(2), dn.padStart(8), ratio.padStart(9)];
  const row = (label: string, cls: string, dn: string, v: number, mark = '') => {
    const [l, d, r] = cols(label, dn, Number.isFinite(v) ? v.toFixed(5) : fmtValue(v));
    return `<span class="k${cls}">${l}</span> ${d} ${r}${mark}`;
  };
  const header = (dnLabel: string) => `<span class="ev">${cols('', dnLabel, 'ratio').join(' ')}</span>`;

  const mosaic = mosaicShown() && cell >= 0;
  const lines = [`x ${x}  y ${y}`];
  if (mosaic) {
    const dn = raw.dn[y * w + x];
    const v = (dn - raw.cellBlack[cell]) * raw.cellScale[cell];
    lines.push(`<span class="ev">${names[site].padEnd(2)} photosite</span>`, header('DN'));
    lines.push(row(names[site], names[siteChannel], String(dn), v));
    probe.innerHTML = lines.join('\n');
    probe.hidden = false;
    hist.setProbe({ [names[siteChannel]]: v });
    return;
  }
  lines.push(`<span class="ev">demosaiced${site >= 0 ? ` · ${names[site].padEnd(2)} photosite •` : ''}</span>`, header(approx ? 'DN≈' : 'DN'));
  [R, G, B].forEach((v, c) => {
    // The photosite's own channel is the exact raw integer; the others are interpolated.
    const exact = c === siteChannel && !approx;
    const dn = exact ? raw.dn[y * w + x] : raw.kind === 'linear' && !approx ? raw.dn[(y * w + x) * 3 + c] : toDn(c, v);
    lines.push(row(names[c], names[c], dn.toFixed(1), v, exact ? ' <span class="ev">•</span>' : ''));
  });
  const scale = rawReadout()!;
  lines.push(row('L', 'L', (scale.black + L * scale.range).toFixed(1), L));
  probe.innerHTML = lines.join('\n');
  probe.hidden = false;
  hist.setProbe({ R, G, B, L });
}

/** Black level of the green channel (the one white balance leaves alone). */
function greenBlack(raw: RawImage) {
  const i = raw.cellColor.findIndex((c) => c === 1 || c === 3);
  return raw.cellBlack[Math.max(0, i)];
}

/** Read-noise numbers for a RAW file, when the masked border allows an estimate. */
function rawNoise(raw: RawImage) {
  if (!raw.noise) return null;
  // Dynamic range runs up to where the sensor stops being linear, when the file says where that is.
  const top = raw.linearMax && raw.linearMax < raw.white ? raw.linearMax : raw.white;
  const range = raw.white - greenBlack(raw);
  return { sigma: raw.noise.sigma, norm: raw.noise.sigma / range, dr: Math.log2((top - greenBlack(raw)) / raw.noise.sigma), top };
}

/** Sensor reference levels on the histogram, in the normalized (green) scale. */
function rawMarkers(raw: RawImage): HistMarker[] {
  const range = raw.white - greenBlack(raw);
  const m: HistMarker[] = [{ ev: 0, label: 'white', color: '#ff6b6b', title: `White level: ${raw.white} DN (${raw.bits}-bit)` }];
  if (raw.linearMax && raw.linearMax < raw.white) {
    m.push({ ev: Math.log2((raw.linearMax - greenBlack(raw)) / range), label: 'linear max', color: '#ffa94d', title: `Linear max: ${raw.linearMax} DN, the highest value the camera calls linear` });
  }
  if (raw.pattern !== 'demosaiced by LibRaw') {
    m.push({ ev: Math.log2(1 / range), label: '1 DN', color: '#74c0fc', title: 'One raw step above black: below this, values are quantized to single integers' });
  }
  const n = rawNoise(raw);
  if (n) m.push({ ev: Math.log2(n.norm), label: 'read noise σ', color: '#b197fc', title: `Read noise ${n.sigma.toFixed(2)} DN from masked pixels: SNR 1 here, ${n.dr.toFixed(2)} stops below ${n.top === raw.white ? 'white' : 'linear max'}` });
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
  const rows: string[] = [];
  const dl = (pairs: [string, string][]) =>
    `<dl>${pairs.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`;

  const fileInfo: [string, string][] = [
    ['Name', img.name],
    ['Size', fmtBytes(img.byteSize)],
    ['Resolution', `${img.width} × ${img.height}`],
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
  fileInfo.push(['Luma weights', img.lumaWeights.map((v) => v.toFixed(4)).join(', ')]);
  fileInfo.push(['Decode', `${img.timings.decodeMs.toFixed(0)} ms · histogram ${img.timings.histMs.toFixed(0)} ms`]);
  if (img.raw) fileInfo.push(['RAW timing', `LibRaw ${img.raw.timings.unpackMs ? `${img.raw.timings.unpackMs.toFixed(0)} ms` : 'cached'} · develop ${img.raw.timings.developMs.toFixed(0)} ms`]);
  rows.push('<h2>Image</h2>', dl(fileInfo));
  const raw = img.raw;
  if (raw) {
    const blacks = [...new Set(raw.cellBlack)].map((b) => fmtValue(b)).join(' / ');
    const rawInfo: [string, string][] = [
      ['Sensor', `${raw.pattern}${raw.kind === 'cfa' ? ` (${raw.cellW}×${raw.cellH} cell)` : ''}`],
      ['Black level', blacks],
      ['White level', `${raw.white} (${raw.bits}-bit)${raw.linearMax && raw.linearMax !== raw.white ? ` · linear max ${raw.linearMax}` : ''}`],
      ['Readouts', 'raw integers (DN); ratio = (DN − black) ÷ (white − black)'],
      ...raw.attributes.map((a): [string, string] => [a.name, a.display]),
    ];
    const n = rawNoise(raw);
    if (raw.noise && n) {
      rawInfo.splice(3, 0,
        ['Read noise', `σ ${n.sigma.toFixed(2)} DN (${raw.noise.region} masked, ${raw.noise.pixels.toLocaleString()} px)`],
        ['Engineering DR', `${n.dr.toFixed(2)} stops (${n.top === raw.white ? 'white' : 'linear max'} ÷ read noise)`],
      );
      if (Math.abs(raw.noise.offset) >= 1) rawInfo.splice(5, 0, ['Masked offset', `${raw.noise.offset > 0 ? '+' : ''}${raw.noise.offset.toFixed(1)} DN vs. declared black`]);
    } else if (raw.kind === 'cfa') {
      rawInfo.splice(3, 0, ['Read noise', 'no masked border in this file']);
    }
    if (raw.pattern !== 'demosaiced by LibRaw') rawInfo.splice(3, 0, ['Quantization', `${Math.log2(raw.white - greenBlack(raw)).toFixed(2)} stops from 1 DN to white`]);
    rows.push('<h2>RAW</h2>', dl(rawInfo));
    for (const n of raw.notes) rows.push(`<p class="note">${escapeHtml(n)}</p>`);
    if (raw.kind === 'cfa' && raw.mode !== '709') rows.push('<p class="note">R/G/B statistics and histograms count photosites only; luminance uses the demosaiced image.</p>');
  }
  if (part?.chromaticities) {
    rows.push('<p class="note">Primaries are shown as raw RGB — no gamut conversion yet. Luminance uses the file\'s chromaticities.</p>');
  }

  // Dynamic range.
  const L = img.histograms.L.stats;
  const cum = hist.cumFor('L')!;
  const drPairs: [string, string][] = [];
  if (L.pos) {
    const lo = Math.log2(L.minPos), hi = Math.log2(L.maxPos);
    drPairs.push(['Full', fmtRange(lo, hi)]);
    for (const [a, b] of [[0.001, 0.999], [0.01, 0.99]]) {
      const pa = percentileEv(cum, a), pb = percentileEv(cum, b);
      drPairs.push([`${a * 100}–${b * 100}%`, fmtRange(pa, pb)]);
    }
    drPairs.push(['Median', fmtLevel(percentileEv(cum, 0.5))]);
  }
  rows.push('<h2>Luminance dynamic range</h2>', drPairs.length ? dl(drPairs) : '<p class="note">No positive values.</p>');
  if (SHOW_STOPS && drPairs.length) rows.push('<p class="note">Stops are relative to 0.18 middle grey.</p>');

  // Per-channel stats.
  const keys: ChannelKey[] = img.luminanceOnly ? ['L'] : ['R', 'G', 'B', 'L'];
  const stat = (f: (s: DecodedImage['histograms']['L']['stats']) => string) =>
    keys.map((k) => {
      total = totals[k] || img.width * img.height;
      return `<td>${f(img.histograms[k].stats)}</td>`;
    }).join('');
  const totals = Object.fromEntries(keys.map((k) => {
    const s = img.histograms[k].stats;
    return [k, s.pos + s.zero + s.neg + s.nan + s.inf];
  }));
  let total = img.width * img.height;
  const pct = (n: number) => (n ? (n / total < 0.0001 ? n.toString() : `${((n / total) * 100).toFixed(2)}%`) : '·');
  rows.push(
    '<h2>Channels</h2>',
    `<table><tr><th></th>${keys.map((k) => `<th>${k}</th>`).join('')}</tr>` +
      `<tr><td>max</td>${stat((s) => fmtLinear(s.maxPos))}</tr>` +
      `<tr><td>min &gt; 0</td>${stat((s) => fmtLinear(s.minPos))}</tr>` +
      `<tr><td>min</td>${stat((s) => (s.neg ? fmtLinear(s.minNeg) : s.zero ? fmtLinear(0) : fmtLinear(s.minPos)))}</tr>` +
      `<tr><td>${raw ? 'at black' : 'zero'}</td>${stat((s) => pct(s.zero))}</tr>` +
      `<tr><td>${raw ? 'below black' : 'negative'}</td>${stat((s) => pct(s.neg))}</tr>` +
      `<tr><td>NaN</td>${stat((s) => pct(s.nan))}</tr>` +
      `<tr><td>Inf</td>${stat((s) => pct(s.inf))}</tr></table>`,
  );

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
  histChannels.querySelectorAll('button').forEach((b) =>
    b.setAttribute('aria-pressed', String(hist.channels.has(b.dataset.v as ChannelKey))),
  );
  colormapSel.disabled = params.mode !== 'false';
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

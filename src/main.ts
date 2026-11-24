import './style.css';
import { colormapLut, type ColormapId } from './colormaps';
import { clampWindow, type DisplayMode, type DisplayParams, type ViewChannel } from './display';
import { pixelTypeName } from './exr-header';
import { fmtBytes, fmtLevel, fmtRange, fmtValue, escapeHtml, fromStops, gridCeil, gridFloor, inputToLevel, levelToInput, SHOW_STOPS } from './format';
import { percentileEv } from './histogram';
import { HistogramView, type YScale } from './histogram-view';
import { Renderer } from './renderer';
import type { ChannelKey, DecodedImage, WorkerRequest, WorkerResponse } from './types';

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

const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });

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
  );
  $('zoom-label').textContent = `${view.scale >= 1 ? Math.round(view.scale * 100) : (view.scale * 100).toFixed(1)}%  ·  ${image.width}×${image.height}`;
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

  const layers = img.parts[img.part]?.layers ?? [];
  const layerSel = $<HTMLSelectElement>('layer');
  layerSel.hidden = layers.length < 2;
  layerSel.innerHTML = layers.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.label)}</option>`).join('');
  layerSel.value = img.layer;
  if (img.luminanceOnly && params.channel !== 'rgb' && params.channel !== 'l') params.channel = 'rgb';

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
  const row = (k: string, v: number) => `<span class="k${k}">${k}</span> ${fmtValue(v).padStart(10)}`;
  const lines = [`x ${x}  y ${y}`];
  if (image.luminanceOnly) lines.push(row('L', R));
  else lines.push(row('R', R), row('G', G), row('B', B), row('L', L));
  if (image.hasAlpha) lines.push(row('A', A));
  probe.innerHTML = lines.join('\n');
  probe.hidden = false;
  hist.setProbe(image.luminanceOnly ? { L: R } : { R, G, B, L });
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
  rows.push('<h2>Image</h2>', dl(fileInfo));
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
    keys.map((k) => `<td>${f(img.histograms[k].stats)}</td>`).join('');
  const total = img.width * img.height;
  const pct = (n: number) => (n ? (n / total < 0.0001 ? n.toString() : `${((n / total) * 100).toFixed(2)}%`) : '·');
  rows.push(
    '<h2>Channels</h2>',
    `<table><tr><th></th>${keys.map((k) => `<th>${k}</th>`).join('')}</tr>` +
      `<tr><td>max</td>${stat((s) => fmtValue(s.maxPos))}</tr>` +
      `<tr><td>min &gt; 0</td>${stat((s) => fmtValue(s.minPos))}</tr>` +
      `<tr><td>min</td>${stat((s) => (s.neg ? fmtValue(s.minNeg) : s.zero ? '0' : fmtValue(s.minPos)))}</tr>` +
      `<tr><td>zero</td>${stat((s) => pct(s.zero))}</tr>` +
      `<tr><td>negative</td>${stat((s) => pct(s.neg))}</tr>` +
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

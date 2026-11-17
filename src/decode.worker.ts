import { FloatType } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { lumaWeights, parseExrLayout, pixelTypeName, remapLayer } from './exr-header';
import { canDecodeNatively, decodeNative } from './exr-decode';
import { HistogramAccumulator } from './histogram';
import { makeDemoImage } from './demo';
import type { ChannelHistogram, ChannelKey, DecodedImage, ExrPart, WorkerRequest, WorkerResponse } from './types';

// Typed view of the worker global, without pulling the WebWorker lib into the DOM build.
const ctx = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

ctx.onmessage = async (e) => {
  try {
    const req = e.data;
    const image = req.type === 'demo' ? demo() : await decode(req.buffer, req.name, req.part, req.layer);
    const transfer: Transferable[] = [image.data.buffer];
    for (const k of Object.keys(image.histograms) as ChannelKey[]) transfer.push(image.histograms[k].bins.buffer);
    ctx.postMessage({ type: 'result', image }, transfer);
  } catch (err) {
    ctx.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

async function decode(buffer: ArrayBuffer, name: string, part: number, layerId?: string): Promise<DecodedImage> {
  const layout = parseExrLayout(buffer);
  const parts = layout.parts;
  const header: ExrPart | undefined = parts[part];
  if (!header) throw new Error(`File has no part ${part}`);
  if (header.compression.startsWith('HTJ2K')) {
    throw new Error(`${header.compression} compression isn't supported by the decoder yet`);
  }
  const subsampled = header.channels.filter((c) => c.xSampling !== 1 || c.ySampling !== 1);
  if (subsampled.length && !header.compression.startsWith('B44')) {
    throw new Error(
      `Subsampled channels (${subsampled.map((c) => `${c.name} ${c.xSampling}×${c.ySampling}`).join(', ')}) ` +
        `with ${header.compression} compression aren't supported by the decoder yet`,
    );
  }
  const layer = header.layers.find((l) => l.id === layerId) ?? header.layers[0];
  if (!layer) throw new Error('This part has no channels');
  const targets = new Set(Object.values(layer.map));
  const hasAlpha = targets.has('A');
  const luminanceOnly = !targets.has('R') && !targets.has('RY');

  const t0 = performance.now();
  let data: Float32Array, width: number, height: number;
  if (canDecodeNatively(header, layer)) {
    ({ data, width, height } = await decodeNative(buffer, layout, part, layer));
  } else {
    // EXRLoader reads every channel with one pixel type and treats UINT as 0 bytes wide.
    const types = new Set(header.channels.map((c) => c.pixelType));
    if (types.size > 1 || types.has(0)) {
      throw new Error(
        `Channels with mixed pixel types (${[...types].map(pixelTypeName).join(', ')}) ` +
          `in ${header.compression} files aren't supported by the decoder yet`,
      );
    }
    const loader = new EXRLoader();
    loader.setDataType(FloatType);
    loader.setPart(part);
    const tex = loader.parse(remapLayer(buffer, layout, part, layer));
    data = tex.data as unknown as Float32Array;
    width = tex.width as number;
    height = tex.height as number;
  }
  const t1 = performance.now();
  const weights = lumaWeights(header.chromaticities);
  const histograms = buildHistograms(data, width * height, weights);
  const t2 = performance.now();

  return {
    name,
    byteSize: buffer.byteLength,
    width,
    height,
    data,
    hasAlpha,
    luminanceOnly,
    part,
    layer: layer.id,
    parts,
    lumaWeights: weights,
    histograms,
    timings: { decodeMs: t1 - t0, histMs: t2 - t1 },
  };
}

function demo(): DecodedImage {
  const width = 1920, height = 1080;
  const t0 = performance.now();
  const data = makeDemoImage(width, height);
  const t1 = performance.now();
  const weights: [number, number, number] = [0.2126, 0.7152, 0.0722];
  const histograms = buildHistograms(data, width * height, weights);
  const t2 = performance.now();
  return {
    name: 'Synthetic test image',
    byteSize: data.byteLength,
    width,
    height,
    data,
    hasAlpha: false,
    luminanceOnly: false,
    part: 0,
    layer: 'rgb:',
    parts: [],
    lumaWeights: weights,
    histograms,
    timings: { decodeMs: t1 - t0, histMs: t2 - t1 },
    synthetic: true,
  };
}

/** Histograms for R, G, B and luminance. Luminance is computed in chunks to bound memory. */
function buildHistograms(
  data: Float32Array,
  pixels: number,
  w: [number, number, number],
): Record<ChannelKey, ChannelHistogram> {
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.length);
  const acc = { R: new HistogramAccumulator(), G: new HistogramAccumulator(), B: new HistogramAccumulator(), L: new HistogramAccumulator() };
  acc.R.add(data, u32, 0, 4, pixels);
  acc.G.add(data, u32, 1, 4, pixels);
  acc.B.add(data, u32, 2, 4, pixels);

  const CHUNK = 1 << 16;
  const lum = new Float32Array(CHUNK);
  const lumBits = new Uint32Array(lum.buffer);
  for (let p = 0; p < pixels; p += CHUNK) {
    const n = Math.min(CHUNK, pixels - p);
    for (let j = 0; j < n; j++) {
      const i = (p + j) * 4;
      lum[j] = w[0] * data[i] + w[1] * data[i + 1] + w[2] * data[i + 2];
    }
    acc.L.add(lum, lumBits, 0, 1, n);
  }
  return { R: acc.R.result(), G: acc.G.result(), B: acc.B.result(), L: acc.L.result() };
}

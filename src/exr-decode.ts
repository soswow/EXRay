import { unzlibSync } from 'fflate';
import type { ExrFileLayout } from './exr-header';
import type { ExrLayer, ExrPart } from './types';

/**
 * Native decoder for the NONE / RLE / ZIPS / ZIP compressions, scanline or tiled (top level only).
 *
 * three.js' EXRLoader assumes every channel shares one pixel type and counts UINT channels as
 * zero bytes wide, so files that mix e.g. FLOAT RGB with UINT or HALF aux channels decode as
 * horizontal garbage. This decoder walks each chunk channel by channel with per-channel sizes,
 * reads only the channels of the chosen layer, and needs no channel renaming.
 */

const PIXEL_BYTES = [4, 2, 4]; // UINT, HALF, FLOAT
const NATIVE: Record<string, number> = { NONE: 1, RLE: 1, ZIPS: 1, ZIP: 16 }; // scanlines per chunk

export function canDecodeNatively(part: ExrPart, layer: ExrLayer): boolean {
  if (!(part.compression in NATIVE) || part.deep) return false;
  if (part.tiled && !part.tiles) return false;
  if (part.channels.some((c) => c.xSampling !== 1 || c.ySampling !== 1)) return false;
  if (part.channels.some((c) => !(c.pixelType in PIXEL_BYTES))) return false;
  // Luminance/chroma needs a YC→RGB conversion; leave that to EXRLoader.
  return !Object.values(layer.map).some((t) => t === 'RY' || t === 'BY');
}

export async function decodeNative(
  buffer: ArrayBuffer,
  layout: ExrFileLayout,
  partIndex: number,
  layer: ExrLayer,
): Promise<{ width: number; height: number; data: Float32Array }> {
  const part = layout.parts[partIndex];
  const [xMin, yMin, xMax, yMax] = part.dataWindow;
  const width = xMax - xMin + 1;
  const height = yMax - yMin + 1;
  if (width <= 0 || height <= 0) throw new Error('Empty data window');

  // Per channel: byte offset within one pixel row group, size, and output slot(s).
  let pixelBytes = 0;
  const channels = part.channels.map((c) => {
    const bytes = PIXEL_BYTES[c.pixelType];
    const ch = { offset: pixelBytes, bytes, type: c.pixelType, slots: slotsFor(layer.map[c.name]) };
    pixelBytes += bytes;
    return ch;
  });
  const wanted = channels.filter((c) => c.slots.length);

  const data = new Float32Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 1;

  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const multi = layout.multiPart;

  // Chunk geometry.
  const tiled = part.tiled && part.tiles;
  const blockW = tiled ? part.tiles!.x : width;
  const blockH = tiled ? part.tiles!.y : NATIVE[part.compression];
  const blocksX = Math.ceil(width / blockW);
  const blocksY = Math.ceil(height / blockH);
  // Level (0,0) tiles come first in a tiled offset table, so this covers mip/ripmaps too.
  const chunks = blocksX * blocksY;

  let table = layout.headersEnd;
  for (let p = 0; p < partIndex; p++) {
    const n = layout.chunkCounts[p];
    if (n === undefined) throw new Error(`Part ${p} has no chunkCount attribute`);
    table += n * 8;
  }

  // Locate every chunk first.
  const jobs: { x0: number; y0: number; cols: number; lines: number; src: Uint8Array; rawSize: number }[] = [];
  let missing = 0;
  for (let i = 0; i < chunks; i++) {
    const at = Number(view.getBigUint64(table + i * 8, true));
    if (at <= 0 || at + 8 > buffer.byteLength) {
      missing++;
      continue;
    }
    let o = at + (multi ? 4 : 0);
    let x0 = 0, y0: number;
    if (tiled) {
      const tx = view.getInt32(o, true), ty = view.getInt32(o + 4, true);
      const lx = view.getInt32(o + 8, true), ly = view.getInt32(o + 12, true);
      o += 16;
      if (lx !== 0 || ly !== 0) continue;
      x0 = tx * blockW;
      y0 = ty * blockH;
    } else {
      y0 = view.getInt32(o, true) - yMin;
      o += 4;
    }
    const size = view.getInt32(o, true);
    o += 4;
    if (size < 0 || o + size > buffer.byteLength) {
      missing++;
      continue;
    }
    const cols = Math.min(blockW, width - x0);
    const lines = Math.min(blockH, height - y0);
    if (cols <= 0 || lines <= 0 || y0 < 0 || x0 < 0) continue;
    jobs.push({ x0, y0, cols, lines, src: bytes.subarray(o, o + size), rawSize: cols * lines * pixelBytes });
  }
  if (missing === chunks) throw new Error('No readable pixel data (truncated file or broken offset table)');

  const half = halfTable();
  const write = (job: (typeof jobs)[number], raw: Uint8Array) => {
    const { x0, y0, cols, lines } = job;
    const rv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let l = 0; l < lines; l++) {
      const lineStart = l * cols * pixelBytes;
      const outRow = height - 1 - (y0 + l); // rows are stored bottom-up
      const outBase = (outRow * width + x0) * 4;
      for (const ch of wanted) {
        let p = lineStart + ch.offset * cols;
        for (let x = 0; x < cols; x++, p += ch.bytes) {
          const v = ch.type === 1 ? half[rv.getUint16(p, true)] : ch.type === 2 ? rv.getFloat32(p, true) : rv.getUint32(p, true);
          const q = outBase + x * 4;
          for (const s of ch.slots) data[q + s] = v;
        }
      }
    }
  };

  // ZIP chunks are inflated by the browser's native zlib, a bounded number at a time so
  // the decompressed chunks never all sit in memory at once.
  const zip = part.compression === 'ZIP' || part.compression === 'ZIPS';
  const native = zip && typeof DecompressionStream !== 'undefined';
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (job.src.length >= job.rawSize) write(job, job.src);
      else if (native) write(job, unpredict(new Uint8Array(await inflateNative(job.src)), job.rawSize));
      else write(job, uncompress(part.compression, job.src, job.rawSize));
    }
  };
  await Promise.all(Array.from({ length: native ? 8 : 1 }, worker));
  return { width, height, data };
}

function inflateNative(src: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([src as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Response(stream).arrayBuffer();
}

function slotsFor(target: string | undefined): number[] {
  switch (target) {
    case 'R': return [0];
    case 'G': return [1];
    case 'B': return [2];
    case 'A': return [3];
    case 'Y': return [0, 1, 2];
    default: return [];
  }
}

function uncompress(compression: string, src: Uint8Array, rawSize: number): Uint8Array {
  let t: Uint8Array;
  if (compression === 'RLE') t = unRle(src, rawSize);
  else if (compression === 'ZIP' || compression === 'ZIPS') t = unzlibSync(src, { out: new Uint8Array(rawSize) });
  else throw new Error(`${compression} chunk is smaller than its raw size`);
  return unpredict(t, rawSize);
}

/** Undoes the byte predictor, then re-interleaves the two half-buffers (RLE and ZIP). */
function unpredict(t: Uint8Array, rawSize: number): Uint8Array {
  if (t.length !== rawSize) throw new Error(`Chunk decompressed to ${t.length} bytes, expected ${rawSize}`);
  for (let i = 1; i < t.length; i++) t[i] = (t[i - 1] + t[i] - 128) & 0xff;
  const out = new Uint8Array(rawSize);
  const mid = (rawSize + 1) >> 1;
  for (let i = 0, j = 0; j < rawSize; i++) {
    out[j++] = t[i];
    if (j < rawSize) out[j++] = t[mid + i];
  }
  return out;
}

function unRle(src: Uint8Array, rawSize: number): Uint8Array {
  const out = new Uint8Array(rawSize);
  let i = 0, o = 0;
  while (i < src.length && o < rawSize) {
    const n = (src[i++] << 24) >> 24; // signed byte
    if (n < 0) {
      const len = Math.min(-n, rawSize - o);
      out.set(src.subarray(i, i + len), o);
      i += -n;
      o += len;
    } else {
      out.fill(src[i++], o, Math.min(o + n + 1, rawSize));
      o += n + 1;
    }
  }
  return out.subarray(0, Math.min(o, rawSize));
}

let HALF: Float32Array | undefined;
function halfTable(): Float32Array {
  if (HALF) return HALF;
  HALF = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    HALF[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return HALF;
}

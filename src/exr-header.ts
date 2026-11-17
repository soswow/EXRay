import type { ExrAttribute, ExrChannel, ExrLayer, ExrPart } from './types';

/**
 * Minimal OpenEXR header reader. It reads every attribute of every part so the UI can
 * show metadata and offer a part picker. Pixel decoding is done elsewhere.
 */

const COMPRESSION = [
  'NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K256', 'HTJ2K32',
];
const LINE_ORDER = ['INCREASING_Y', 'DECREASING_Y', 'RANDOM_Y'];
const PIXEL_TYPE = ['uint', 'half', 'float'];
const LEVEL_MODE = ['ONE_LEVEL', 'MIPMAP_LEVELS', 'RIPMAP_LEVELS'];

export const pixelTypeName = (t: number) => PIXEL_TYPE[t] ?? `type ${t}`;

class Reader {
  offset = 0;
  constructor(readonly view: DataView, readonly bytes: Uint8Array) {}
  u8() { return this.view.getUint8(this.offset++); }
  i32() { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
  u32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
  f32() { const v = this.view.getFloat32(this.offset, true); this.offset += 4; return v; }
  f64() { const v = this.view.getFloat64(this.offset, true); this.offset += 8; return v; }
  cstr(): string {
    const start = this.offset;
    while (this.bytes[this.offset] !== 0) {
      this.offset++;
      if (this.offset >= this.bytes.length) throw new Error('Unexpected end of file in header');
    }
    const s = new TextDecoder().decode(this.bytes.subarray(start, this.offset));
    this.offset++;
    return s;
  }
  str(len: number): string {
    const s = new TextDecoder().decode(this.bytes.subarray(this.offset, this.offset + len));
    this.offset += len;
    return s;
  }
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : Number(n.toPrecision(6)).toString());

interface RawPart {
  attrs: ExrAttribute[];
  values: Map<string, unknown>;
  chlist: [number, number];
}

function readAttributeValue(r: Reader, type: string, size: number): { value: unknown; display: string } {
  const end = r.offset + size;
  let value: unknown;
  let display: string;
  switch (type) {
    case 'box2i': {
      const b = [r.i32(), r.i32(), r.i32(), r.i32()];
      value = b;
      display = `(${b[0]}, ${b[1]}) – (${b[2]}, ${b[3]})`;
      break;
    }
    case 'box2f': {
      const b = [r.f32(), r.f32(), r.f32(), r.f32()];
      value = b;
      display = `(${b.map(fmt).slice(0, 2).join(', ')}) – (${b.map(fmt).slice(2).join(', ')})`;
      break;
    }
    case 'chlist': {
      const chans: ExrChannel[] = [];
      while (r.offset < end - 1) {
        const name = r.cstr();
        const pixelType = r.i32();
        r.offset += 4; // pLinear + 3 reserved bytes
        const xSampling = r.i32();
        const ySampling = r.i32();
        chans.push({ name, pixelType, xSampling, ySampling });
      }
      value = chans;
      display = chans.map((c) => `${c.name} (${pixelTypeName(c.pixelType)})`).join(', ');
      break;
    }
    case 'compression': {
      const c = r.u8();
      value = COMPRESSION[c] ?? `unknown (${c})`;
      display = String(value);
      break;
    }
    case 'lineOrder': {
      const l = r.u8();
      value = LINE_ORDER[l] ?? String(l);
      display = String(value);
      break;
    }
    case 'envmap': {
      const e = r.u8();
      value = e;
      display = e === 0 ? 'latlong' : e === 1 ? 'cube' : String(e);
      break;
    }
    case 'float': value = r.f32(); display = fmt(value as number); break;
    case 'double': value = r.f64(); display = fmt(value as number); break;
    case 'int': value = r.i32(); display = String(value); break;
    case 'string': value = r.str(size); display = String(value); break;
    case 'stringvector': {
      const list: string[] = [];
      while (r.offset < end) list.push(r.str(r.i32()));
      value = list;
      display = list.join(', ');
      break;
    }
    case 'v2i': { const v = [r.i32(), r.i32()]; value = v; display = v.join(', '); break; }
    case 'v2f': { const v = [r.f32(), r.f32()]; value = v; display = v.map(fmt).join(', '); break; }
    case 'v3i': { const v = [r.i32(), r.i32(), r.i32()]; value = v; display = v.join(', '); break; }
    case 'v3f': { const v = [r.f32(), r.f32(), r.f32()]; value = v; display = v.map(fmt).join(', '); break; }
    case 'chromaticities': {
      const c = Array.from({ length: 8 }, () => r.f32());
      value = c;
      display = `R(${fmt(c[0])}, ${fmt(c[1])}) G(${fmt(c[2])}, ${fmt(c[3])}) B(${fmt(c[4])}, ${fmt(c[5])}) W(${fmt(c[6])}, ${fmt(c[7])})`;
      break;
    }
    case 'tiledesc': {
      const x = r.u32(), y = r.u32(), mode = r.u8();
      value = { x, y, mode };
      display = `${x}×${y}, ${LEVEL_MODE[mode & 0x0f] ?? mode}${mode >> 4 ? ', round up' : ''}`;
      break;
    }
    case 'rational': {
      const n = r.i32(), d = r.u32();
      value = [n, d];
      display = `${n}/${d}`;
      break;
    }
    case 'm33f':
    case 'm44f': {
      const n = type === 'm33f' ? 9 : 16;
      const m = Array.from({ length: n }, () => r.f32());
      value = m;
      display = `[${m.map(fmt).join(', ')}]`;
      break;
    }
    case 'timecode': {
      const t = r.u32();
      r.u32();
      const bcd = (v: number) => ((v >> 4) & 0xf) * 10 + (v & 0xf);
      value = t;
      const pad = (n: number) => String(n).padStart(2, '0');
      display = `${pad(bcd((t >> 24) & 0x3f))}:${pad(bcd((t >> 16) & 0x7f))}:${pad(bcd((t >> 8) & 0x7f))}:${pad(bcd(t & 0x3f))}`;
      break;
    }
    case 'preview': {
      const w = r.u32(), h = r.u32();
      value = [w, h];
      display = `${w}×${h} preview`;
      break;
    }
    default:
      value = null;
      display = `<${type}, ${size} bytes>`;
  }
  r.offset = end;
  return { value, display };
}

function readOneHeader(r: Reader): RawPart | null {
  const attrs: ExrAttribute[] = [];
  const values = new Map<string, unknown>();
  let chlist: [number, number] = [0, 0];
  for (;;) {
    const start = r.offset;
    const name = r.cstr();
    if (name === '') break;
    const type = r.cstr();
    const size = r.i32();
    const { value, display } = readAttributeValue(r, type, size);
    attrs.push({ name, type, display });
    values.set(name, value);
    if (name === 'channels') chlist = [start, r.offset];
  }
  return attrs.length ? { attrs, values, chlist } : null;
}

export interface ExrFileLayout {
  parts: ExrPart[];
  multiPart: boolean;
  deep: boolean;
  /** Byte offset just past the last header, where the chunk offset tables begin. */
  headersEnd: number;
  /** Byte range of each part's `channels` attribute (name through value). */
  chlistRanges: [number, number][];
  /** Per part, from the `chunkCount` attribute (required for multi-part and deep files). */
  chunkCounts: (number | undefined)[];
}

export function parseExrHeaders(buffer: ArrayBuffer): ExrPart[] {
  return parseExrLayout(buffer).parts;
}

export function parseExrLayout(buffer: ArrayBuffer): ExrFileLayout {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== 20000630) {
    throw new Error('Not an OpenEXR file (bad magic number)');
  }
  const flags = view.getUint8(5);
  const tiled = !!(flags & 0x02);
  const deep = !!(flags & 0x08);
  const multiPart = !!(flags & 0x10);
  const r = new Reader(view, new Uint8Array(buffer));
  r.offset = 8;

  const raw: RawPart[] = [];
  if (multiPart) {
    for (;;) {
      const part = readOneHeader(r);
      if (!part) break;
      raw.push(part);
    }
  } else {
    const part = readOneHeader(r);
    if (part) raw.push(part);
  }

  const parts = raw.map((p, index): ExrPart => {
    const v = p.values;
    const type = v.get('type') as string | undefined;
    return {
      index,
      name: v.get('name') as string | undefined,
      type,
      compression: (v.get('compression') as string) ?? 'NONE',
      channels: (v.get('channels') as ExrChannel[]) ?? [],
      dataWindow: (v.get('dataWindow') as [number, number, number, number]) ?? [0, 0, 0, 0],
      displayWindow: (v.get('displayWindow') as [number, number, number, number]) ?? [0, 0, 0, 0],
      tiled: type ? type.startsWith('tiled') : tiled && !deep,
      deep: type ? type.startsWith('deep') : deep,
      chromaticities: v.get('chromaticities') as number[] | undefined,
      attributes: p.attrs,
      layers: listLayers((v.get('channels') as ExrChannel[]) ?? []),
    };
  });
  return {
    parts,
    multiPart,
    deep,
    headersEnd: r.offset,
    chlistRanges: raw.map((p) => p.chlist),
    chunkCounts: raw.map((p) => p.values.get('chunkCount') as number | undefined),
  };
}

// ---------- layers ----------

const suffixOf = (name: string) => name.slice(name.lastIndexOf('.') + 1);
const prefixOf = (name: string) => name.slice(0, name.lastIndexOf('.') + 1);

/**
 * Groups channels into viewable layers: RGB(A) sets and luminance/chroma sets sharing a
 * prefix (e.g. "diffuse.R/G/B"), plus every remaining channel on its own.
 */
export function listLayers(channels: ExrChannel[]): ExrLayer[] {
  const names = new Set(channels.map((c) => c.name));
  const used = new Set<string>();
  const layers: ExrLayer[] = [];
  const prefixes = [...new Set(channels.map((c) => prefixOf(c.name)))];
  for (const p of prefixes) {
    const label = p ? p.slice(0, -1) : '';
    if (['R', 'G', 'B'].every((s) => names.has(p + s))) {
      const map: Record<string, string> = { [p + 'R']: 'R', [p + 'G']: 'G', [p + 'B']: 'B' };
      if (names.has(p + 'A')) map[p + 'A'] = 'A';
      const kind = map[p + 'A'] ? 'RGBA' : 'RGB';
      layers.push({ id: `rgb:${p}`, label: label ? `${label} (${kind})` : kind, map });
      Object.keys(map).forEach((n) => used.add(n));
    } else if (['Y', 'RY', 'BY'].every((s) => names.has(p + s))) {
      const map: Record<string, string> = { [p + 'Y']: 'Y', [p + 'RY']: 'RY', [p + 'BY']: 'BY' };
      if (names.has(p + 'A')) map[p + 'A'] = 'A';
      layers.push({ id: `yc:${p}`, label: label ? `${label} (YC)` : 'Y/C', map });
      Object.keys(map).forEach((n) => used.add(n));
    }
  }
  for (const c of channels) {
    if (used.has(c.name)) continue;
    layers.push({ id: `ch:${c.name}`, label: c.name, map: { [c.name]: 'Y' }, single: true });
  }
  // Prefer the un-prefixed RGB layer as the default.
  layers.sort((a, b) => rank(a) - rank(b));
  return layers;
}

const rank = (l: ExrLayer) => (l.id === 'rgb:' ? 0 : l.id === 'yc:' ? 1 : l.single ? 3 : 2);

/**
 * Returns a copy of the file in which the chosen layer's channels are renamed to the
 * plain R/G/B/A (or Y) names the pixel decoder understands. Other channels get names that
 * keep their suffix (DWA compression classifies channels by suffix). Chunk offset tables
 * that the decoder reads are shifted by the change in header size.
 */
export function remapLayer(buffer: ArrayBuffer, layout: ExrFileLayout, partIndex: number, layer: ExrLayer): ArrayBuffer {
  const part = layout.parts[partIndex];
  const identity = part.channels.every((c) => (layer.map[c.name] ?? c.name) === c.name) &&
    part.channels.every((c) => layer.map[c.name] || !['R', 'G', 'B', 'A', 'Y', 'RY', 'BY'].includes(c.name));
  if (identity) return buffer;

  const src = new Uint8Array(buffer);
  const [start, end] = layout.chlistRanges[partIndex];
  const enc = new TextEncoder();

  // Rebuild the chlist value, copying each channel's 16 bytes of type/sampling data.
  const chunks: Uint8Array[] = [];
  let p = start;
  while (src[p] !== 0) p++; // attribute name
  p++;
  while (src[p] !== 0) p++; // attribute type
  p += 1 + 4; // NUL + size
  let i = 0;
  while (src[p] !== 0) {
    let q = p;
    while (src[q] !== 0) q++;
    const name = new TextDecoder().decode(src.subarray(p, q));
    const newName = layer.map[name] ?? `${i}.${suffixOf(name)}`;
    chunks.push(enc.encode(newName), new Uint8Array([0]), src.subarray(q + 1, q + 17));
    p = q + 17;
    i++;
  }
  chunks.push(new Uint8Array([0]));
  const valueLen = chunks.reduce((n, c) => n + c.length, 0);
  const head = enc.encode('channels\0chlist\0');
  const attr = new Uint8Array(head.length + 4 + valueLen);
  attr.set(head, 0);
  new DataView(attr.buffer).setInt32(head.length, valueLen, true);
  let o = head.length + 4;
  for (const c of chunks) {
    attr.set(c, o);
    o += c.length;
  }

  const delta = attr.length - (end - start);
  const out = new Uint8Array(src.length + delta);
  out.set(src.subarray(0, start), 0);
  out.set(attr, start);
  out.set(src.subarray(end), start + attr.length);

  // The decoder reads offset tables for multi-part and deep files; shift them.
  if (layout.multiPart || layout.deep) {
    const view = new DataView(out.buffer);
    const total = layout.chunkCounts.reduce<number>((n, c) => n + (c ?? 0), 0);
    let t = layout.headersEnd + delta;
    for (let k = 0; k < total; k++, t += 8) {
      view.setBigUint64(t, view.getBigUint64(t, true) + BigInt(delta), true);
    }
  }
  return out.buffer;
}

/** Rec.709 / sRGB primaries with D65 white, the OpenEXR default. */
export const REC709_CHROMATICITIES = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329];

/**
 * Luminance weights (the Y row of the RGB→XYZ matrix) for the given chromaticities.
 */
export function lumaWeights(chroma: number[] = REC709_CHROMATICITIES): [number, number, number] {
  const [rx, ry, gx, gy, bx, by, wx, wy] = chroma;
  // CIE XYZ files use degenerate "primaries" (1,0), (0,1), (0,0): G already is Y.
  if (rx === 1 && ry === 0 && gx === 0 && gy === 1 && bx === 0 && by === 0) return [0, 1, 0];
  // Columns: XYZ of each primary with Y = 1.
  const m = [
    [rx / ry, gx / gy, bx / by],
    [1, 1, 1],
    [(1 - rx - ry) / ry, (1 - gx - gy) / gy, (1 - bx - by) / by],
  ];
  const w = [wx / wy, 1, (1 - wx - wy) / wy];
  const inv = invert3(m);
  if (!inv) return [0.2126, 0.7152, 0.0722];
  const s = [0, 1, 2].map((i) => inv[i][0] * w[0] + inv[i][1] * w[1] + inv[i][2] * w[2]);
  // Y row of M * diag(S) is just S, because each primary's Y is 1.
  if (s.some((x) => !Number.isFinite(x))) return [0.2126, 0.7152, 0.0722];
  return [s[0], s[1], s[2]];
}

function invert3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return null;
  const k = 1 / det;
  return [
    [A * k, -(b * i - c * h) * k, (b * f - c * e) * k],
    [B * k, (a * i - c * g) * k, -(a * f - c * d) * k],
    [C * k, -(a * h - b * g) * k, (a * e - b * d) * k],
  ];
}

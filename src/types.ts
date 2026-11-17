/** Channels we build histograms for. L is luminance computed from RGB. */
export type ChannelKey = 'R' | 'G' | 'B' | 'L';
export const CHANNEL_KEYS: ChannelKey[] = ['L', 'R', 'G', 'B'];

export interface ChannelStats {
  /** Exactly zero (+0 or -0). */
  zero: number;
  /** Finite negative values. */
  neg: number;
  nan: number;
  inf: number;
  /** Finite positive values (these are the ones that land in log2 bins). */
  pos: number;
  /** Smallest finite positive value, or 0 if none. */
  minPos: number;
  /** Largest finite positive value, or 0 if none. */
  maxPos: number;
  /** Most negative finite value, or 0 if none. */
  minNeg: number;
}

export interface ChannelHistogram {
  /** Counts of positive finite values in log2 bins (see histogram.ts for layout). */
  bins: Uint32Array;
  stats: ChannelStats;
}

export interface ExrChannel {
  name: string;
  /** 0 = uint, 1 = half, 2 = float */
  pixelType: number;
  xSampling: number;
  ySampling: number;
}

export interface ExrAttribute {
  name: string;
  type: string;
  /** Human readable value. */
  display: string;
}

/** A set of channels viewed together, e.g. "diffuse.R/G/B" or a single "depth.Z". */
export interface ExrLayer {
  id: string;
  label: string;
  /** Source channel name → name the decoder understands (R, G, B, A, Y, RY, BY). */
  map: Record<string, string>;
  /** A single channel shown as luminance. */
  single?: boolean;
}

export interface ExrPart {
  index: number;
  name?: string;
  type?: string;
  compression: string;
  channels: ExrChannel[];
  dataWindow: [number, number, number, number];
  displayWindow: [number, number, number, number];
  tiled: boolean;
  deep: boolean;
  /** [rx, ry, gx, gy, bx, by, wx, wy] */
  chromaticities?: number[];
  attributes: ExrAttribute[];
  layers: ExrLayer[];
}

export interface DecodedImage {
  name: string;
  byteSize: number;
  width: number;
  height: number;
  /** RGBA float32, rows stored bottom-up (row 0 is the bottom of the image). */
  data: Float32Array;
  hasAlpha: boolean;
  /** True when the source only had a Y channel (R=G=B=Y). */
  luminanceOnly: boolean;
  part: number;
  /** Id of the decoded layer within the part. */
  layer: string;
  parts: ExrPart[];
  /** Weights for computing luminance from RGB, derived from chromaticities. */
  lumaWeights: [number, number, number];
  histograms: Record<ChannelKey, ChannelHistogram>;
  timings: { decodeMs: number; histMs: number };
  synthetic?: boolean;
}

export type WorkerRequest =
  | { type: 'decode'; buffer: ArrayBuffer; name: string; part: number; layer?: string }
  | { type: 'demo' };

export type WorkerResponse =
  | { type: 'result'; image: DecodedImage }
  | { type: 'error'; message: string };

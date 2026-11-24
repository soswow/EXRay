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
  /**
   * Exact distribution, for data that only takes a few distinct values (RAW photosites):
   * every distinct finite value (zero and negatives included) in ascending order, and
   * cumulative counts (length n + 1). When present, counts come from here, not from the log2 bins.
   */
  exact?: { values: Float64Array; cum: Float64Array };
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
  /** Tile size and level mode (0 one level, 1 mipmap, 2 ripmap) for tiled parts. */
  tiles?: { x: number; y: number; mode: number };
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
  /** Present for camera RAW files. `data` then holds the demosaiced, normalized image. */
  raw?: RawImage;
}

/** How a RAW file's sensor values are turned into RGB. */
export type RawModeId = 'cam' | 'wb' | '709';
export const RAW_MODES: { id: RawModeId; label: string }[] = [
  { id: 'cam', label: 'Camera RGB (no WB)' },
  { id: 'wb', label: 'Camera RGB × as-shot WB' },
  { id: '709', label: 'Linear Rec.709 primaries (WB + rgb_cam)' },
];

/** Where the black level used for normalization comes from. */
export type BlackSource = 'libraw' | 'maker' | 'masked';
/** Where the white level used for normalization comes from. */
export type WhiteSource = 'libraw' | 'linear' | 'normal' | 'data';
/** Which area of the sensor readout is shown. */
export type CropId = 'maker' | 'active' | 'libraw' | 'full';

export interface RawOptions {
  black: BlackSource;
  white: WhiteSource;
  crop: CropId;
}

/** A rectangle on the full sensor readout, in unrotated raw coordinates. */
export interface RawArea {
  id: CropId;
  label: string;
  /** Where the numbers come from, e.g. "Canon makernote". */
  source: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One candidate level (black or white), per CFA color R, G, B, G2 (null when it doesn't apply). */
export interface LevelCandidate<Id extends string> {
  id: Id;
  label: string;
  /** Where the numbers come from, shown on hover. */
  source: string;
  values: (number | null)[];
  /** Extra per-color text, e.g. how many photosites sit at the data maximum. */
  detail?: string[];
}

export interface RawImage {
  mode: RawModeId;
  /**
   * 'cfa': mosaic sensor data, one value per photosite.
   * 'linear': already demosaiced in the file (linear DNG, sRAW) or by LibRaw (unusual layouts).
   */
  kind: 'cfa' | 'linear';
  /** Raw integer values of the shown area (see options.crop), rows top-down; 1 value per pixel for 'cfa', 3 for 'linear'. */
  dn: Uint16Array;
  channels: 1 | 3;
  /**
   * The CFA pattern as a repeating cell of `cellW` × `cellH` photosites, anchored at the top-left
   * pixel of the shown area. Per cell: color (0 R, 1 G, 2 B, 3 second G), black level, and the factor that
   * turns (DN − black) into the displayed value (normalization and, in WB modes, white balance).
   * For 'linear' there is one cell per channel.
   */
  cellW: number;
  cellH: number;
  cellColor: number[];
  cellBlack: number[];
  cellScale: number[];
  /** White level per cell used for normalization: 1.0 in the display means this DN. */
  cellWhite: number[];
  /** The levels and area actually used. */
  options: RawOptions;
  /** All black and white levels the file, LibRaw and the masked border offer, per CFA color. */
  blacks: LevelCandidate<BlackSource>[];
  whites: LevelCandidate<WhiteSource>[];
  /** Sensor areas that can be shown, and the full readout size. */
  areas: RawArea[];
  rawSize: [number, number];
  /** Raw integer statistics of the shown area per CFA color R, G (both), B. */
  dnStats: { max: number; atMax: number; min: number; atOrBelowBlack: number; count: number }[];
  /** Short pattern name, e.g. "RGGB", "X-Trans". */
  pattern: string;
  make: string;
  model: string;
  /** EXIF-like metadata for the info panel. */
  attributes: ExrAttribute[];
  notes: string[];
  /** Read noise estimated from the sensor's masked border, when the file includes one. */
  noise: { sigma: number; pixels: number; region: string } | null;
  /** White balance multipliers R, G, B (normalized to G) and the camera → Rec.709 matrix, from LibRaw. */
  wb: [number, number, number];
  wbSource: string;
  rgbCam: number[];
  /** LibRaw unpack (0 when reused from the previous decode) and our own processing. */
  timings: { unpackMs: number; developMs: number };
}

export type WorkerRequest =
  | { type: 'decode'; buffer: ArrayBuffer; name: string; part: number; layer?: string; rawOptions?: Partial<RawOptions> }
  | { type: 'demo' };

export type WorkerResponse =
  | { type: 'result'; image: DecodedImage }
  | { type: 'error'; message: string };

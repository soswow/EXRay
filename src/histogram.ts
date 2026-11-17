import type { ChannelHistogram, ChannelStats } from './types';

/**
 * Histogram layout: bins are uniform in log2 space ("stops" / EV), covering the
 * entire positive float32 range, including denormals:
 *
 *   bin i covers  [EV_ORIGIN + i / BINS_PER_STOP,  EV_ORIGIN + (i + 1) / BINS_PER_STOP)
 *
 * so nothing is ever clamped or lost. Zero, negative, NaN and Inf values can't be
 * placed on a log axis; they're counted separately in ChannelStats.
 */
export const BINS_PER_STOP = 64;
export const EV_ORIGIN = -150; // smallest float32 denormal is 2^-149
export const EV_END = 129; // largest float32 is just under 2^128
export const NUM_BINS = (EV_END - EV_ORIGIN) * BINS_PER_STOP;

/** Maps the top 10 mantissa bits to the sub-stop bin: floor(log2(1.m) * BINS_PER_STOP). */
const SUB_LUT = (() => {
  const lut = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) {
    const v = Math.floor(Math.log2(1 + (i + 0.5) / 1024) * BINS_PER_STOP);
    lut[i] = Math.min(BINS_PER_STOP - 1, v);
  }
  return lut;
})();

export function emptyStats(): ChannelStats {
  return { zero: 0, neg: 0, nan: 0, inf: 0, pos: 0, minPos: 0, maxPos: 0, minNeg: 0 };
}

/**
 * Accumulates a histogram of `count` values read from `src` at `start`, `start + stride`, ...
 * Uses the float bit pattern directly: exponent gives the whole stop, a LUT on the
 * mantissa gives the fraction. Much faster than Math.log2 per value.
 */
export class HistogramAccumulator {
  readonly bins = new Uint32Array(NUM_BINS);
  zero = 0;
  neg = 0;
  nan = 0;
  inf = 0;
  pos = 0;
  // For positive floats, unsigned bit order equals numeric order.
  private minPosBits = 0xffffffff;
  private maxPosBits = 0;
  private minNeg = 0;

  add(f32: Float32Array, u32: Uint32Array, start: number, stride: number, count: number): void {
    const bins = this.bins;
    let zero = 0, neg = 0, nan = 0, inf = 0, pos = 0;
    let minPosBits = this.minPosBits, maxPosBits = this.maxPosBits, minNeg = this.minNeg;
    const end = start + stride * count;
    for (let i = start; i < end; i += stride) {
      const bits = u32[i];
      const exp = (bits >>> 23) & 0xff;
      if (exp === 0xff) {
        if (bits & 0x7fffff) nan++;
        else inf++;
        continue;
      }
      if ((bits & 0x7fffffff) === 0) {
        zero++;
        continue;
      }
      if (bits >>> 31) {
        neg++;
        const v = f32[i];
        if (v < minNeg) minNeg = v;
        continue;
      }
      pos++;
      if (bits < minPosBits) minPosBits = bits;
      if (bits > maxPosBits) maxPosBits = bits;
      let bin: number;
      if (exp === 0) {
        // Denormal: rare, so the slow path is fine.
        bin = Math.floor((Math.log2(f32[i]) - EV_ORIGIN) * BINS_PER_STOP);
      } else {
        bin = (exp - 127 - EV_ORIGIN) * BINS_PER_STOP + SUB_LUT[(bits >>> 13) & 1023];
      }
      bins[bin]++;
    }
    this.zero += zero;
    this.neg += neg;
    this.nan += nan;
    this.inf += inf;
    this.pos += pos;
    this.minPosBits = minPosBits;
    this.maxPosBits = maxPosBits;
    this.minNeg = minNeg;
  }

  result(): ChannelHistogram {
    const scratch = new Uint32Array(1);
    const asFloat = new Float32Array(scratch.buffer);
    const bitsToFloat = (b: number) => {
      scratch[0] = b;
      return asFloat[0];
    };
    const stats: ChannelStats = {
      zero: this.zero,
      neg: this.neg,
      nan: this.nan,
      inf: this.inf,
      pos: this.pos,
      minPos: this.pos ? bitsToFloat(this.minPosBits) : 0,
      maxPos: this.pos ? bitsToFloat(this.maxPosBits) : 0,
      minNeg: this.minNeg,
    };
    return { bins: this.bins, stats };
  }
}

/** Prefix sums so any EV range can be summed in O(1). Length NUM_BINS + 1. */
export function cumulative(bins: Uint32Array): Float64Array {
  const cum = new Float64Array(bins.length + 1);
  let acc = 0;
  for (let i = 0; i < bins.length; i++) {
    acc += bins[i];
    cum[i + 1] = acc;
  }
  return cum;
}

/** Interpolated cumulative count at a fractional bin position. */
export function cumAt(cum: Float64Array, binPos: number): number {
  if (binPos <= 0) return 0;
  const n = cum.length - 1;
  if (binPos >= n) return cum[n];
  const i = Math.floor(binPos);
  const f = binPos - i;
  return cum[i] + f * (cum[i + 1] - cum[i]);
}

export const evToBin = (ev: number) => (ev - EV_ORIGIN) * BINS_PER_STOP;
export const binToEv = (bin: number) => bin / BINS_PER_STOP + EV_ORIGIN;

/** EV at which the given fraction (0..1) of positive values lies below. */
export function percentileEv(cum: Float64Array, fraction: number): number {
  const total = cum[cum.length - 1];
  if (total === 0) return 0;
  const target = fraction * total;
  // Binary search for the first bin whose cumulative exceeds the target.
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid + 1] < target) lo = mid + 1;
    else hi = mid;
  }
  const inBin = cum[lo + 1] - cum[lo];
  const frac = inBin > 0 ? (target - cum[lo]) / inBin : 0;
  return binToEv(lo + frac);
}

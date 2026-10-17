import { Rng } from './random.js';

/**
 * Log-bucketed latency histogram (~1% relative precision, 10µs .. ~30min).
 * Mergeable across worker threads and cheap to serialise: only non-empty
 * buckets are sent over postMessage.
 */
export class Histogram {
  static readonly GROWTH = 1.02;
  static readonly MIN_MS = 0.01;
  private static readonly LOG_G = Math.log(Histogram.GROWTH);

  counts = new Map<number, number>();
  total = 0;
  sum = 0;
  min = Infinity;
  max = 0;

  record(ms: number) {
    const v = Math.max(ms, Histogram.MIN_MS);
    const idx = Math.floor(Math.log(v / Histogram.MIN_MS) / Histogram.LOG_G);
    this.counts.set(idx, (this.counts.get(idx) ?? 0) + 1);
    this.total++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }

  merge(other: Histogram | SerializedHistogram) {
    const entries = other instanceof Histogram ? [...other.counts.entries()] : other.b;
    for (const [idx, c] of entries) this.counts.set(idx, (this.counts.get(idx) ?? 0) + c);
    const total = other instanceof Histogram ? other.total : other.n;
    if (total === 0) return;
    this.total += total;
    this.sum += other instanceof Histogram ? other.sum : other.s;
    this.min = Math.min(this.min, other instanceof Histogram ? other.min : other.lo);
    this.max = Math.max(this.max, other instanceof Histogram ? other.max : other.hi);
  }

  percentile(p: number): number {
    if (this.total === 0) return NaN;
    if (p <= 0) return this.min;
    if (p >= 100) return this.max;
    const target = Math.ceil((p / 100) * this.total);
    let seen = 0;
    for (const idx of [...this.counts.keys()].sort((a, b) => a - b)) {
      seen += this.counts.get(idx)!;
      if (seen >= target) {
        // bucket midpoint, clamped to the observed range
        const lo = Histogram.MIN_MS * Math.pow(Histogram.GROWTH, idx);
        const mid = lo * (1 + Histogram.GROWTH) / 2;
        return Math.min(Math.max(mid, this.min), this.max);
      }
    }
    return this.max;
  }

  mean(): number {
    return this.total ? this.sum / this.total : NaN;
  }

  /** Fraction of samples <= thresholdMs (bucket-precision). */
  fractionBelow(thresholdMs: number): number {
    if (this.total === 0) return NaN;
    const limit = Math.floor(Math.log(Math.max(thresholdMs, Histogram.MIN_MS) / Histogram.MIN_MS) / Histogram.LOG_G);
    let below = 0;
    for (const [idx, c] of this.counts) if (idx <= limit) below += c;
    return below / this.total;
  }

  serialize(): SerializedHistogram {
    return { b: [...this.counts.entries()], n: this.total, s: this.sum, lo: this.min, hi: this.max };
  }

  static from(s: SerializedHistogram): Histogram {
    const h = new Histogram();
    h.merge(s);
    return h;
  }

  summary(): LatencySummary {
    return {
      count: this.total,
      mean: round(this.mean()),
      min: round(this.total ? this.min : NaN),
      p50: round(this.percentile(50)),
      p95: round(this.percentile(95)),
      p99: round(this.percentile(99)),
      max: round(this.total ? this.max : NaN),
    };
  }
}

export type SerializedHistogram = { b: [number, number][]; n: number; s: number; lo: number; hi: number };

export type LatencySummary = { count: number; mean: number | null; min: number | null; p50: number | null; p95: number | null; p99: number | null; max: number | null };

export function round(v: number, digits = 2): number | null {
  if (!Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Exact percentile over raw samples (used by request/response benchmarks). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function describe(samples: number[]) {
  const sorted = samples.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const mean = n ? sorted.reduce((a, b) => a + b, 0) / n : NaN;
  const sd = n > 1 ? Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    count: n,
    mean: round(mean),
    stdev: round(sd),
    min: round(sorted[0] ?? NaN),
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    max: round(sorted[n - 1] ?? NaN),
  };
}

export type Comparison = {
  baseline: string;
  candidate: string;
  /** candidate median / baseline median */
  medianRatio: number | null;
  ci95: [number | null, number | null];
  verdict: 'faster' | 'slower' | 'similar';
  explanation: string;
};

/**
 * Bootstrap 95% CI for the ratio of medians. If the interval overlaps the
 * "practically equal" band (±SIMILAR_BAND) we say the results are similar
 * instead of declaring a winner from noise.
 */
export function compareMedians(baselineName: string, baseline: number[], candidateName: string, candidate: number[], resamples = 2000, similarBand = 0.05): Comparison {
  const rng = new Rng('bootstrap');
  const median = (xs: number[]) => percentile(xs.slice().sort((a, b) => a - b), 50);
  const ratios: number[] = [];
  const resample = (xs: number[]) => {
    const out = new Array<number>(xs.length);
    for (let i = 0; i < xs.length; i++) out[i] = xs[Math.floor(rng.next() * xs.length)];
    return out;
  };
  if (baseline.length < 5 || candidate.length < 5) {
    return { baseline: baselineName, candidate: candidateName, medianRatio: null, ci95: [null, null], verdict: 'similar', explanation: 'Not enough samples to compare.' };
  }
  for (let i = 0; i < resamples; i++) ratios.push(median(resample(candidate)) / median(resample(baseline)));
  ratios.sort((a, b) => a - b);
  const lo = percentile(ratios, 2.5);
  const hi = percentile(ratios, 97.5);
  const ratio = median(candidate) / median(baseline);
  let verdict: Comparison['verdict'] = 'similar';
  if (hi < 1 - similarBand) verdict = 'faster';
  else if (lo > 1 + similarBand) verdict = 'slower';
  // "3.2x faster" reads better than "69% faster" once the gap is large.
  const pct = (x: number) => (x < 0.5 ? `${(1 / x).toFixed(1)}x` : x > 2 ? `${x.toFixed(1)}x` : `${Math.round(Math.abs(1 - x) * 100)}%`);
  const explanation = verdict === 'similar'
    ? `${candidateName} and ${baselineName} are statistically similar (median ratio ${ratio.toFixed(2)}, 95% CI ${lo.toFixed(2)}–${hi.toFixed(2)} overlaps ±${similarBand * 100}%).`
    : `${candidateName} is ${pct(ratio)} ${verdict} than ${baselineName} at the median (ratio ${ratio.toFixed(2)}, 95% CI ${lo.toFixed(2)}–${hi.toFixed(2)}).`;
  return { baseline: baselineName, candidate: candidateName, medianRatio: round(ratio, 3), ci95: [round(lo, 3), round(hi, 3)], verdict, explanation };
}

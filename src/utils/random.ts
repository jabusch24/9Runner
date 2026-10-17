// Deterministic pseudo-random helpers. Every generator is derived from the
// SEED string plus a stream label, so a batch of products generated in
// parallel is identical no matter which batch ran first.

function hashString(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: string) {
    this.a = hashString(seed + ':a');
    this.b = hashString(seed + ':b');
    this.c = hashString(seed + ':c');
    this.d = hashString(seed + ':d');
    for (let i = 0; i < 15; i++) this.next();
  }

  /** sfc32: fast, good statistical quality, 128-bit state. */
  next(): number {
    this.a >>>= 0; this.b >>>= 0; this.c >>>= 0; this.d >>>= 0;
    let t = (this.a + this.b) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.d = (this.d + 1) | 0;
    t = (t + this.d) | 0;
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }

  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  pickMany<T>(items: readonly T[], n: number): T[] {
    const copy = items.slice();
    const out: T[] = [];
    while (out.length < n && copy.length) out.push(copy.splice(Math.floor(this.next() * copy.length), 1)[0]);
    return out;
  }

  normal(mean = 0, sd = 1): number {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-normal around a median: realistic for prices and counts. */
  logNormal(median: number, sigma: number): number {
    return median * Math.exp(this.normal(0, sigma));
  }
}

/** Weighted choice with a precomputed CDF (O(log n) per draw). */
export class WeightedPicker<T> {
  private cdf: number[] = [];
  constructor(private items: readonly T[], weights: readonly number[]) {
    if (items.length !== weights.length || items.length === 0) throw new Error('WeightedPicker needs equal, non-empty arrays');
    let acc = 0;
    for (const w of weights) this.cdf.push((acc += w));
  }
  pick(rng: Rng): T {
    const x = rng.next() * this.cdf[this.cdf.length - 1];
    let lo = 0;
    let hi = this.cdf.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cdf[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return this.items[lo];
  }
}

/**
 * Zipf-distributed ranks in [0, n). Uses rejection-inversion so it works for
 * n in the millions without allocating an n-sized table.
 */
export class Zipf {
  private hIntegralX1: number;
  private hIntegralN: number;
  private s: number;

  constructor(private n: number, private exponent = 1.07) {
    this.hIntegralX1 = this.hIntegral(1.5) - 1;
    this.hIntegralN = this.hIntegral(n + 0.5);
    this.s = 2 - this.hIntegralInverse(this.hIntegral(2.5) - this.h(2));
  }

  sample(rng: Rng): number {
    for (;;) {
      const u = this.hIntegralN + rng.next() * (this.hIntegralX1 - this.hIntegralN);
      const x = this.hIntegralInverse(u);
      let k = Math.floor(x + 0.5);
      if (k < 1) k = 1;
      else if (k > this.n) k = this.n;
      if (k - x <= this.s || u >= this.hIntegral(k + 0.5) - this.h(k)) return k - 1;
    }
  }

  private h(x: number) { return Math.exp(-this.exponent * Math.log(x)); }
  private hIntegral(x: number) {
    const logX = Math.log(x);
    return helper2((1 - this.exponent) * logX) * logX;
  }
  private hIntegralInverse(x: number) {
    let t = x * (1 - this.exponent);
    if (t < -1) t = -1;
    return Math.exp(helper1(t) * x);
  }
}

function helper1(x: number) {
  return Math.abs(x) > 1e-8 ? Math.log1p(x) / x : 1 - x * (0.5 - x * (1 / 3 - 0.25 * x));
}
function helper2(x: number) {
  return Math.abs(x) > 1e-8 ? Math.expm1(x) / x : 1 + x * 0.5 * (1 + x * (1 / 3) * (1 + 0.25 * x));
}

/**
 * Popularity rank -> product id. Without this, Zipf rank 0 would always be
 * product 0, making "popular" products the ones inserted first.
 */
export function scatter(rank: number, n: number): number {
  // Multiplicative hashing with a large odd constant co-prime to most n,
  // falling back to identity if the constant shares a factor with n.
  const k = 2654435761;
  return gcd(k, n) === 1 ? Number((BigInt(rank) * BigInt(k)) % BigInt(n)) : rank;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

import { performance } from 'node:perf_hooks';
import { num } from '../config/settings.js';
import { Rng } from '../utils/random.js';
import { describe } from '../utils/stats.js';

export type VariantRun = () => Promise<{ docs?: number; result?: unknown }>;

export type Variant = {
  id: string;
  label: string;
  /** Which engine does the heavy lifting: shown in the UI to keep "server version" and "search engine" apart. */
  executionPath: string;
  run: VariantRun;
};

export type VariantResult = {
  id: string;
  label: string;
  executionPath: string;
  supported: boolean;
  unsupportedReason?: string;
  firstRunMs: number | null;
  warmupMs: number[];
  samplesMs: number[];
  latency: ReturnType<typeof describe>;
  iterationsCapped: boolean;
  errors: number;
  errorSamples: string[];
  docsReturned: number | null;
  throughput: { concurrency: number; seconds: number; ops: number; opsPerSec: number | null; latency: ReturnType<typeof describe> } | null;
  lastResult?: unknown;
};

export type RunOptions = {
  warmup: number;
  iterations: number;
  concurrency: number;
  throughputSeconds: number;
  maxVariantSeconds: number;
  onProgress?: (msg: string) => void;
};

export function defaultRunOptions(): RunOptions {
  return {
    warmup: num('WARMUP_ITERATIONS', 10),
    iterations: num('MEASURED_ITERATIONS', 100),
    concurrency: num('BENCH_CONCURRENCY', 4),
    throughputSeconds: num('THROUGHPUT_SECONDS', 10),
    maxVariantSeconds: num('MAX_VARIANT_SECONDS', 90),
  };
}

const UNSUPPORTED = /unrecognized field|not supported|unknown operator|Unrecognized pipeline stage|SearchNotEnabled|is not allowed/i;

/**
 * Measure several variants that answer the same question.
 *
 *  1. first run       - recorded separately (closest to a cold cache we can get remotely)
 *  2. warm-up         - discarded from statistics
 *  3. latency phase   - concurrency 1, variants interleaved in a shuffled order each
 *                       round, so drift (other tenants, cache churn, autoscaling)
 *                       hits every variant equally instead of whichever ran last
 *  4. throughput phase- each variant alone, closed loop at `concurrency` for N seconds
 */
export async function runVariants(variants: Variant[], opts: RunOptions): Promise<VariantResult[]> {
  const log = opts.onProgress ?? (() => undefined);
  const results = new Map<string, VariantResult>();
  const rng = new Rng('interleave');

  for (const v of variants) {
    const r: VariantResult = {
      id: v.id, label: v.label, executionPath: v.executionPath, supported: true, firstRunMs: null, warmupMs: [], samplesMs: [],
      latency: describe([]), iterationsCapped: false, errors: 0, errorSamples: [], docsReturned: null, throughput: null,
    };
    results.set(v.id, r);
    try {
      const t0 = performance.now();
      const out = await v.run();
      r.firstRunMs = performance.now() - t0;
      r.docsReturned = out.docs ?? null;
      r.lastResult = out.result;
    } catch (e) {
      const msg = (e as Error).message;
      if (UNSUPPORTED.test(msg)) {
        r.supported = false;
        r.unsupportedReason = msg.replace(/^.*caused by :: /, '');
        log(`  ${v.label}: not supported on this deployment (${r.unsupportedReason})`);
        continue;
      }
      throw e;
    }
    for (let i = 0; i < opts.warmup; i++) {
      const t0 = performance.now();
      await v.run().catch(() => undefined);
      r.warmupMs.push(performance.now() - t0);
    }
  }

  const active = variants.filter((v) => results.get(v.id)!.supported);
  const started = new Map(active.map((v) => [v.id, 0]));
  const spent = new Map(active.map((v) => [v.id, 0]));
  for (let i = 0; i < opts.iterations; i++) {
    const order = active.slice().sort(() => rng.next() - 0.5);
    let anyRan = false;
    for (const v of order) {
      const r = results.get(v.id)!;
      if (spent.get(v.id)! > opts.maxVariantSeconds * 1000 && r.samplesMs.length >= 10) {
        r.iterationsCapped = true;
        continue;
      }
      anyRan = true;
      started.set(v.id, started.get(v.id)! + 1);
      const t0 = performance.now();
      try {
        await v.run();
        r.samplesMs.push(performance.now() - t0);
      } catch (e) {
        r.errors++;
        if (r.errorSamples.length < 5) r.errorSamples.push((e as Error).message);
      }
      spent.set(v.id, spent.get(v.id)! + performance.now() - t0);
    }
    if (!anyRan) break;
    if ((i + 1) % 25 === 0) log(`  latency phase: ${i + 1}/${opts.iterations} rounds`);
  }
  for (const v of active) results.get(v.id)!.latency = describe(results.get(v.id)!.samplesMs);

  if (opts.throughputSeconds > 0) {
    for (const v of active) {
      log(`  throughput phase: ${v.label} @ concurrency ${opts.concurrency} for ${opts.throughputSeconds}s`);
      results.get(v.id)!.throughput = await measureThroughput(v.run, opts.concurrency, opts.throughputSeconds);
    }
  }
  return variants.map((v) => results.get(v.id)!);
}

export async function measureThroughput(run: VariantRun, concurrency: number, seconds: number) {
  const deadline = performance.now() + seconds * 1000;
  const lat: number[] = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (performance.now() < deadline) {
      const s = performance.now();
      try {
        await run();
        lat.push(performance.now() - s);
      } catch {
        /* errors are counted in the latency phase */
      }
    }
  }));
  const elapsed = (performance.now() - t0) / 1000;
  return { concurrency, seconds: Math.round(elapsed * 10) / 10, ops: lat.length, opsPerSec: lat.length ? Math.round((lat.length / elapsed) * 10) / 10 : null, latency: describe(lat) };
}

export function stripForStorage(r: VariantResult): Omit<VariantResult, 'lastResult'> {
  const { lastResult: _ignored, ...rest } = r;
  return rest;
}

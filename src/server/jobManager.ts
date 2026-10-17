import { EventEmitter } from 'node:events';
import { runBenchmark } from '../benchmark/jobs.js';
import { BenchmarkName } from '../benchmark/results.js';
import type { ProgressEvent } from '../iwm/stressTest.js';

export type JobStatus = {
  id: number;
  benchmark: string;
  env?: string;
  overrides: Record<string, string>;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt?: string;
  error?: string;
  log: string[];
};

/**
 * One benchmark at a time - two concurrent load tests would measure each
 * other. Overrides (e.g. PEAK_RPS) are applied to process.env for the job's
 * duration and restored afterwards.
 */
const ALLOWED_OVERRIDES = new Set([
  'BASE_RPS', 'PEAK_RPS', 'BASELINE_SECONDS', 'RAMP_SECONDS', 'OVERLOAD_SECONDS', 'RECOVERY_SECONDS', 'STEADY_SECONDS', 'RAMP_STEPS',
  'WORKERS', 'SLO_MS', 'OP_TIMEOUT_MS', 'CLIENT_RETRY_MODE', 'LS_RETRY_MODES', 'WORKLOAD_MIX', 'COOLDOWN_SECONDS',
  'WARMUP_ITERATIONS', 'MEASURED_ITERATIONS', 'BENCH_CONCURRENCY', 'THROUGHPUT_SECONDS', 'AGGREGATION_QUERIES', 'LOCAL_EMULATION_MODES',
  'CALIBRATE_START_RPS', 'CALIBRATE_MAX_RPS', 'CALIBRATE_STEP_SECONDS',
]);

export class JobManager extends EventEmitter {
  current: JobStatus | null = null;
  private nextId = 1;

  start(benchmark: BenchmarkName | 'all', env: string | undefined, overrides: Record<string, string>): JobStatus {
    if (this.current?.state === 'running') throw new Error(`A benchmark is already running (${this.current.benchmark}).`);
    const clean = Object.fromEntries(Object.entries(overrides ?? {}).filter(([k, v]) => ALLOWED_OVERRIDES.has(k) && v !== '' && v != null).map(([k, v]) => [k, String(v)]));
    const job: JobStatus = { id: this.nextId++, benchmark, env, overrides: clean, state: 'running', startedAt: new Date().toISOString(), log: [] };
    this.current = job;
    const previous = Object.fromEntries(Object.keys(clean).map((k) => [k, process.env[k]]));
    Object.assign(process.env, clean);
    const log = (m: string) => {
      const line = `${new Date().toISOString().slice(11, 19)} ${m}`;
      job.log.push(line);
      if (job.log.length > 500) job.log.shift();
      this.emit('event', { type: 'log', jobId: job.id, line });
    };
    const progress = (e: ProgressEvent) => this.emit('event', { ...e, jobId: job.id });
    this.emit('event', { type: 'job', job: summary(job) });
    runBenchmark(benchmark, env, log, progress)
      .then(() => { job.state = 'done'; })
      .catch((e) => { job.state = 'failed'; job.error = (e as Error).message; log(`ERROR: ${job.error}`); })
      .finally(() => {
        for (const [k, v] of Object.entries(previous)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
        job.finishedAt = new Date().toISOString();
        this.emit('event', { type: 'job', job: summary(job) });
      });
    return job;
  }
}

export function summary(job: JobStatus) {
  const { log: _log, ...rest } = job;
  return rest;
}

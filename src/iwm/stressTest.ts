import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { DemoEnvironment } from '../config/environments.js';
import { settings, str } from '../config/settings.js';
import { readDatasetMeta } from '../seed/seed.js';
import { getSearchIndexStatus } from '../search/indexDefinition.js';
import { clientFacts, collectServerFacts, getDb, RetryMode, ServerFacts } from '../utils/mongo.js';
import { Histogram, LatencySummary, round } from '../utils/stats.js';
import { ClusterMonitor } from './monitor.js';
import { DEFAULT_MIX, OP_CLASSES, parseMix } from './operations.js';
import { phaseAt, Schedule, rpsAt } from './schedule.js';
import type { ClassCounters, SecondSample, ServerSample, WorkerConfig, WorkerMessage } from './types.js';

export type TimelinePoint = {
  sec: number;
  phase: string;
  targetRps: number;
  attempted: number;
  ok: number;
  okWithinSlo: number;
  rejected: number;
  timeouts: number;
  errors: number;
  clientDropped: number;
  retries: number;
  serverRejectedAttempts: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  criticalP95: number | null;
  criticalP99: number | null;
  heavyP95: number | null;
  inflight: number;
  clientEventLoopP99Ms: number;
  server?: ServerSample;
};

type Totals = Omit<ClassCounters, 'hist'>;
export type OutcomeSummary = Totals & {
  /** sent and not rejected by the server: what "accepted" means here */
  accepted: number;
  serverRejectedAttempts: number;
  latency: LatencySummary;
  sloCompliancePct: number | null;
  goodputPerSec: number | null;
};

export type StressRun = {
  envId: string;
  envName: string;
  label: string;
  retryMode: RetryMode;
  server: ServerFacts;
  client: ReturnType<typeof clientFacts>;
  dataset: unknown;
  config: Record<string, unknown>;
  schedule: Schedule;
  startedAt: string;
  durationSec: number;
  timeline: TimelinePoint[];
  totals: OutcomeSummary;
  byPhase: Record<string, OutcomeSummary & { byClass: Record<string, OutcomeSummary> }>;
  byClass: Record<string, OutcomeSummary>;
  errorCodes: Record<string, number>;
  recovery: { recoveredAfterSec: number | null; criterion: string };
  canary: Record<string, { p50: number | null; maxMs: number | null; failures: number; probes: number }>;
  serverPeaks: Record<string, number | null>;
  validity: { valid: boolean; clientBound: boolean; overloadReached: boolean; warnings: string[] };
  atlasMetrics?: unknown;
};

export type ProgressEvent = { type: 'stress-progress'; envId: string; label: string; point: TimelinePoint; totalSec: number };

const emptyTotals = (): Totals => ({ attempted: 0, clientDropped: 0, ok: 0, okWithinSlo: 0, rejected: 0, timeouts: 0, errors: 0, retries: 0 });

function addInto(t: Totals, c: Totals) {
  t.attempted += c.attempted; t.clientDropped += c.clientDropped; t.ok += c.ok; t.okWithinSlo += c.okWithinSlo;
  t.rejected += c.rejected; t.timeouts += c.timeouts; t.errors += c.errors; t.retries += c.retries;
}

class Acc {
  t = emptyTotals();
  h = new Histogram();
  serverRejected = 0;
  seconds = new Set<number>();
  summarize(): OutcomeSummary {
    const secs = this.seconds.size || 1;
    return {
      ...this.t,
      accepted: this.t.attempted - this.t.clientDropped - this.t.rejected,
      serverRejectedAttempts: this.serverRejected,
      latency: this.h.summary(),
      sloCompliancePct: this.t.attempted - this.t.clientDropped > 0 ? round((this.t.okWithinSlo / (this.t.attempted - this.t.clientDropped)) * 100, 1) : null,
      goodputPerSec: round(this.t.okWithinSlo / secs, 1),
    };
  }
}

export type StressOptions = {
  label?: string;
  schedule: Schedule;
  retryMode?: RetryMode;
  mix?: string;
  onProgress?: (e: ProgressEvent) => void;
  log: (m: string) => void;
};

export async function runStressTest(env: DemoEnvironment, opts: StressOptions): Promise<StressRun> {
  const log = opts.log;
  const label = opts.label ?? env.name;
  const retryMode = opts.retryMode ?? settings.clientRetryMode;
  const db = await getDb(env);
  const dataset = await readDatasetMeta(db);
  if (!dataset) throw new Error(`[${env.id}] no dataset found - run "npm run seed" first`);
  const server = await collectServerFacts(env);
  const searchIdx = await getSearchIndexStatus(db.collection('products'), settings.searchIndexName);
  const searchAvailable = Boolean(searchIdx.queryable);
  const mix = opts.mix ?? str('WORKLOAD_MIX', DEFAULT_MIX);
  const parsedMix = parseMix(mix, searchAvailable);
  const workers = Math.max(1, settings.workers);
  const schedule = opts.schedule;
  const config = {
    workers, poolSizePerWorker: settings.poolSizePerWorker, maxInflightPerWorker: settings.maxInflightPerWorker,
    sloMs: settings.sloMs, opTimeoutMs: settings.opTimeoutMs, retryMode, appMaxRetries: settings.appMaxRetries,
    mix: parsedMix.normalized, searchInMix: searchAvailable, canaryRps: settings.canaryRps,
  };
  log(`[${env.id}] ${label}: ${schedule.phases.map((p) => `${p.name} ${p.durationSec}s@${p.rpsStart}${p.rpsEnd !== p.rpsStart ? '→' + p.rpsEnd : ''}`).join(' | ')} | ${workers} workers, retry=${retryMode}, SLO ${settings.sloMs}ms`);
  for (const w of server.warnings) log(`[${env.id}] WARNING: ${w}`);

  const workerUrl = new URL('./worker.js', import.meta.url);
  const pool: Worker[] = [];
  const perWorkerLast: number[] = new Array(workers).fill(-1);
  const pending = new Map<number, SecondSample[]>();
  const timeline: TimelinePoint[] = [];
  const phaseAcc = new Map<string, Map<string, Acc>>();
  const classAcc = new Map<string, Acc>();
  const totalAcc = new Acc();
  const errorCodes: Record<string, number> = {};
  const serverSamples = new Map<number, ServerSample>();
  let monitor: ClusterMonitor | null = null;

  const finalize = (sec: number, parts: SecondSample[]) => {
    const phase = phaseAt(schedule, sec)?.name ?? 'drain';
    const t = emptyTotals();
    const all = new Histogram();
    const critical = new Histogram();
    const heavy = new Histogram();
    let serverRejected = 0;
    let inflight = 0;
    let eld = 0;
    for (const p of parts) {
      serverRejected += p.serverRejectedAttempts;
      inflight += p.inflight;
      eld = Math.max(eld, p.eventLoopP99Ms);
      for (const [k, v] of Object.entries(p.errorCodes)) errorCodes[k] = (errorCodes[k] ?? 0) + v;
      for (const [cls, c] of Object.entries(p.perClass)) {
        addInto(t, c);
        const h = Histogram.from(c.hist);
        all.merge(h);
        (OP_CLASSES[cls as keyof typeof OP_CLASSES]?.critical ? critical : heavy).merge(h);
        for (const acc of [accFor(phaseAcc, phase, cls), accFor(phaseAcc, phase, '*'), classAcc.get(cls) ?? classAcc.set(cls, new Acc()).get(cls)!, totalAcc]) {
          addInto(acc.t, c);
          acc.h.merge(h);
          acc.seconds.add(sec);
        }
      }
    }
    for (const acc of [accFor(phaseAcc, phase, '*'), totalAcc]) { acc.serverRejected += serverRejected; acc.seconds.add(sec); }
    const point: TimelinePoint = {
      sec, phase, targetRps: Math.round(rpsAt(schedule, sec + 0.5)), ...t, serverRejectedAttempts: serverRejected,
      p50: round(all.percentile(50)), p95: round(all.percentile(95)), p99: round(all.percentile(99)),
      criticalP95: round(critical.percentile(95)), criticalP99: round(critical.percentile(99)), heavyP95: round(heavy.percentile(95)),
      inflight, clientEventLoopP99Ms: eld, server: serverSamples.get(sec),
    };
    timeline.push(point);
    opts.onProgress?.({ type: 'stress-progress', envId: env.id, label, point, totalSec: schedule.totalSec });
  };

  const startedAt = new Date();
  try {
    let readyCount = 0;
    const allReady = new Promise<void>((resolve, reject) => {
      for (let i = 0; i < workers; i++) {
        const cfg: WorkerConfig = {
          workerIndex: i, workers, uri: env.uri, dbName: settings.dbName, schedule, mix, searchAvailable,
          searchIndex: settings.searchIndexName, productCount: dataset.productCount, reviewCount: dataset.reviewCount, seed: settings.seed,
          sloMs: settings.sloMs, opTimeoutMs: settings.opTimeoutMs, poolSize: settings.poolSizePerWorker,
          maxInflight: settings.maxInflightPerWorker, retryMode, appMaxRetries: settings.appMaxRetries,
        };
        const w = new Worker(workerUrl, { workerData: cfg });
        pool.push(w);
        w.on('message', (m: WorkerMessage) => {
          if (m.type === 'ready' && ++readyCount === workers) resolve();
          if (m.type === 'error') reject(new Error(`worker ${i}: ${m.message}`));
          if (m.type === 'second') {
            perWorkerLast[i] = m.sample.sec;
            const list = pending.get(m.sample.sec) ?? [];
            list.push(m.sample);
            pending.set(m.sample.sec, list);
            const complete = Math.min(...perWorkerLast);
            for (const s of [...pending.keys()].sort((a, b) => a - b)) {
              if (s > complete) break;
              finalize(s, pending.get(s)!);
              pending.delete(s);
            }
          }
        });
        w.on('error', reject);
      }
    });
    await allReady;
    const startAt = Date.now() + 500;
    monitor = new ClusterMonitor(env.uri, settings.dbName, dataset.productCount, settings.canaryRps, (s) => serverSamples.set(s.sec, s));
    await monitor.start(performance.now() + (startAt - Date.now()));
    for (const w of pool) w.postMessage({ startAt });
    await Promise.all(pool.map((w) => new Promise<void>((resolve, reject) => {
      w.on('message', (m: WorkerMessage) => { if (m.type === 'done') resolve(); if (m.type === 'error') reject(new Error(m.message)); });
      w.on('exit', () => resolve());
    })));
    for (const s of [...pending.keys()].sort((a, b) => a - b)) finalize(s, pending.get(s)!);
  } finally {
    await Promise.allSettled(pool.map((w) => w.terminate()));
    if (monitor) await monitor.stop();
  }
  // Late server samples (the poller runs on its own clock) are attached after the fact.
  for (const p of timeline) p.server ??= serverSamples.get(p.sec);

  const byPhase: StressRun['byPhase'] = {};
  for (const phase of schedule.phases) {
    const m = phaseAcc.get(phase.name);
    if (!m) continue;
    const byClass: Record<string, OutcomeSummary> = {};
    for (const [cls, acc] of m) if (cls !== '*') byClass[cls] = acc.summarize();
    byPhase[phase.name] = { ...(m.get('*') ?? new Acc()).summarize(), byClass };
  }
  const byClass = Object.fromEntries([...classAcc].map(([k, a]) => [k, a.summarize()]));
  const run: StressRun = {
    envId: env.id, envName: env.name, label, retryMode, server, client: clientFacts(), dataset, config, schedule,
    startedAt: startedAt.toISOString(), durationSec: timeline.length, timeline, totals: totalAcc.summarize(), byPhase, byClass, errorCodes,
    recovery: computeRecovery(timeline, schedule),
    canary: canarySummary(timeline, schedule),
    serverPeaks: serverPeaks(timeline),
    validity: { valid: true, clientBound: false, overloadReached: false, warnings: [] },
  };
  run.validity = assessValidity(run);
  for (const w of run.validity.warnings) log(`[${env.id}] ${w}`);
  return run;
}

function accFor(m: Map<string, Map<string, Acc>>, phase: string, cls: string): Acc {
  let p = m.get(phase);
  if (!p) m.set(phase, (p = new Map()));
  let a = p.get(cls);
  if (!a) p.set(cls, (a = new Acc()));
  return a;
}

/**
 * Recovery = seconds after the overload ends until the cluster serves
 * critical traffic within SLO again (critical p95 <= SLO and < 1% failures)
 * for 3 consecutive seconds.
 */
function computeRecovery(timeline: TimelinePoint[], schedule: Schedule) {
  const slo = settings.sloMs;
  const criterion = `first of 3 consecutive seconds after overload with critical p95 ≤ ${slo} ms and < 1% rejected/timed out/failed`;
  if (schedule.overloadEndSec == null) return { recoveredAfterSec: null, criterion };
  const after = timeline.filter((p) => p.sec >= schedule.overloadEndSec!);
  let streak = 0;
  for (const p of after) {
    const bad = p.rejected + p.timeouts + p.errors;
    const healthy = p.criticalP95 != null && p.criticalP95 <= slo && bad <= 0.01 * Math.max(1, p.attempted);
    streak = healthy ? streak + 1 : 0;
    if (streak === 3) return { recoveredAfterSec: p.sec - 2 - schedule.overloadEndSec, criterion };
  }
  return { recoveredAfterSec: null, criterion };
}

function canarySummary(timeline: TimelinePoint[], schedule: Schedule) {
  const out: StressRun['canary'] = {};
  for (const phase of schedule.phases) {
    const pts = timeline.filter((p) => p.phase === phase.name && p.server?.canary);
    const p50s = pts.map((p) => p.server!.canary!.p50).filter((x): x is number => x != null).sort((a, b) => a - b);
    out[phase.name] = {
      p50: p50s.length ? p50s[Math.floor(p50s.length / 2)] : null,
      maxMs: pts.reduce<number | null>((a, p) => (p.server!.canary!.max != null ? Math.max(a ?? 0, p.server!.canary!.max!) : a), null),
      failures: pts.reduce((a, p) => a + p.server!.canary!.failures, 0),
      probes: pts.reduce((a, p) => a + p.server!.canary!.count, 0),
    };
  }
  return out;
}

function serverPeaks(timeline: TimelinePoint[]) {
  const max = (f: (s: ServerSample) => number | null | undefined) => {
    const vals = timeline.map((p) => (p.server?.ok ? f(p.server) : null)).filter((v): v is number => v != null && Number.isFinite(v));
    return vals.length ? Math.max(...vals) : null;
  };
  const sum = (f: (s: ServerSample) => number | null | undefined) => {
    const vals = timeline.map((p) => (p.server?.ok ? f(p.server) : null)).filter((v): v is number => v != null && Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  return {
    cpuPct: max((s) => s.cpuPct),
    connections: max((s) => s.connections),
    residentMb: max((s) => s.residentMb),
    serverOpsPerSec: max((s) => s.serverOpsPerSec),
    executionQueued: max((s) => (s.executionQueue ? s.executionQueue.readQueued + s.executionQueue.writeQueued : null)),
    ingressQueueLength: max((s) => s.ingress?.queueLength),
    ingressRejectedTotal: sum((s) => s.ingress?.rejected),
    ingressQueuedTotal: sum((s) => s.ingress?.queued),
    deprioritizations: sum((s) => s.executionQueue?.deprioritizations),
    monitorPollFailures: timeline.filter((p) => p.server && !p.server.ok).length,
  };
}

/**
 * Guard rails that keep the demo honest:
 *  - client-bound: the load generator could not issue the requested rate or
 *    its event loop stalled. Then the client, not the database, was the
 *    bottleneck and the comparison is invalid.
 *  - overload not reached: nothing in the data shows stress. Then the test
 *    cannot say anything about overload behaviour - increase PEAK_RPS or the
 *    heavy-report share (run `npm run calibrate`).
 */
function assessValidity(run: StressRun) {
  const warnings: string[] = [];
  let clientBound = false;
  for (const phase of run.schedule.phases) {
    const pts = run.timeline.filter((p) => p.phase === phase.name);
    if (!pts.length) continue;
    const target = pts.reduce((a, p) => a + p.targetRps, 0);
    const attempted = pts.reduce((a, p) => a + p.attempted, 0);
    const dropped = pts.reduce((a, p) => a + p.clientDropped, 0);
    const worstEld = Math.max(...pts.map((p) => p.clientEventLoopP99Ms));
    if (target > 0 && attempted < 0.9 * target) { clientBound = true; warnings.push(`CLIENT-BOUND: phase "${phase.name}" issued ${attempted} of ${target} scheduled requests. Add WORKERS / a bigger load-generator VM.`); }
    // A full application queue is an outcome of a slow server, not a broken test: report it, count it as failed.
    if (dropped > 0.01 * attempted) warnings.push(`APP QUEUE FULL: ${dropped} requests in "${phase.name}" were never sent because ${run.config.maxInflightPerWorker} requests per worker were already waiting (MAX_INFLIGHT_PER_WORKER). They count as failed requests.`);
    if (worstEld > 200) { clientBound = true; warnings.push(`CLIENT-BOUND: load generator event loop stalled up to ${worstEld} ms in "${phase.name}" - latency numbers include client delay.`); }
  }
  const overload = run.byPhase['overload'] ?? Object.values(run.byPhase).at(-1);
  const slo = settings.sloMs;
  const crit = Object.entries(overload?.byClass ?? {}).filter(([c]) => OP_CLASSES[c as keyof typeof OP_CLASSES]?.critical);
  const critP95 = Math.max(0, ...crit.map(([, s]) => s.latency.p95 ?? 0));
  const overloadReached = Boolean(overload && (
    overload.rejected > 0 || overload.timeouts > 0.005 * overload.attempted || critP95 > slo || (run.serverPeaks.cpuPct ?? 0) > 85 || (run.serverPeaks.executionQueued ?? 0) > 0 || (run.serverPeaks.ingressQueueLength ?? 0) > 0
  ));
  if (!overloadReached) warnings.push('NOT OVERLOADED: no rejections, timeouts, queueing or SLO breaches during the overload phase. This run cannot show overload behaviour - raise PEAK_RPS or the heavy-report share (npm run calibrate).');
  if (run.server.location === 'remote' && run.client.cpus < 4) warnings.push(`Load generator has only ${run.client.cpus} CPUs - check for CLIENT-BOUND warnings.`);
  return { valid: !clientBound, clientBound, overloadReached, warnings };
}

import { performance } from 'node:perf_hooks';
import { Document, MongoClient } from 'mongodb';
import { retryOptions, toNum } from '../utils/mongo.js';
import { Rng } from '../utils/random.js';
import { Histogram } from '../utils/stats.js';
import type { ServerSample } from './types.js';

/**
 * Two independent observers that run alongside the load generator:
 *
 *  - serverStatus poller (1/s): connections, CPU, execution-control queues,
 *    ingress request rate limiter, server-side latency. Needs clusterMonitor;
 *    missing sections are simply left empty.
 *  - canary: a few product-page reads per second on a separate connection
 *    pool, i.e. "can a shopper still open a product page right now?". It is
 *    not counted in the workload totals.
 */
export class ClusterMonitor {
  private client: MongoClient;
  private canaryClient: MongoClient;
  private samples: ServerSample[] = [];
  private prev: Document | null = null;
  private prevAt = 0;
  private cores = 1;
  private stopped = false;
  private t0 = 0;
  private canaryHist = new Histogram();
  private canaryFailures = 0;
  private canaryCount = 0;
  private loops: Promise<void>[] = [];

  constructor(uri: string, private dbName: string, private productCount: number, private canaryRps: number, private onSample?: (s: ServerSample) => void) {
    this.client = new MongoClient(uri, { appName: '9runner-monitor', maxPoolSize: 4, serverSelectionTimeoutMS: 10_000 });
    this.canaryClient = new MongoClient(uri, { appName: '9runner-canary', maxPoolSize: 4, serverSelectionTimeoutMS: 10_000, ...retryOptions('none') });
  }

  async start(t0: number) {
    await Promise.all([this.client.connect(), this.canaryClient.connect()]);
    const host = await this.client.db('admin').command({ hostInfo: 1 }).catch(() => null);
    this.cores = toNum(host?.system?.numCores) || 1;
    this.t0 = t0;
    this.loops.push(this.pollLoop(), this.canaryLoop());
  }

  async stop(): Promise<ServerSample[]> {
    this.stopped = true;
    await Promise.allSettled(this.loops);
    await Promise.allSettled([this.client.close(), this.canaryClient.close()]);
    return this.samples;
  }

  private sec() {
    return Math.floor((performance.now() - this.t0) / 1000);
  }

  private async pollLoop() {
    while (!this.stopped) {
      const started = performance.now();
      const sec = this.sec();
      let sample: ServerSample;
      try {
        const ss = await this.client.db('admin').command({ serverStatus: 1, repl: 0, locks: 0, tcmalloc: 0, wiredTiger: 0 }, { timeoutMS: 5_000 });
        sample = this.toSample(sec, ss, performance.now() - started);
      } catch (e) {
        sample = { sec, ok: false, error: (e as Error).message, pollMs: performance.now() - started };
      }
      const c = this.drainCanary();
      sample.canary = c;
      this.samples.push(sample);
      this.onSample?.(sample);
      await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (performance.now() - started))));
    }
  }

  private drainCanary() {
    const s = { p50: this.canaryHist.total ? Math.round(this.canaryHist.percentile(50) * 10) / 10 : null, max: this.canaryHist.total ? Math.round(this.canaryHist.max * 10) / 10 : null, failures: this.canaryFailures, count: this.canaryCount };
    this.canaryHist = new Histogram();
    this.canaryFailures = 0;
    this.canaryCount = 0;
    return s;
  }

  private async canaryLoop() {
    if (this.canaryRps <= 0) return;
    const rng = new Rng('canary');
    const products = this.canaryClient.db(this.dbName).collection('products');
    const interval = 1000 / this.canaryRps;
    while (!this.stopped) {
      const started = performance.now();
      // Fire and don't wait: a stuck canary must not stop later probes.
      void products.findOne({ _id: rng.int(0, this.productCount - 1) } as Document, { timeoutMS: 5_000 })
        .then(() => { this.canaryHist.record(performance.now() - started); })
        .catch(() => { this.canaryFailures++; })
        .finally(() => { this.canaryCount++; });
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  private toSample(sec: number, ss: Document, pollMs: number): ServerSample {
    const now = performance.now();
    const prev = this.prev;
    const dt = prev ? (now - this.prevAt) / 1000 : 0;
    const d = (path: string) => (prev ? toNum(get(ss, path)) - toNum(get(prev, path)) : NaN);

    const opsDelta = ['insert', 'query', 'update', 'delete', 'getmore', 'command'].reduce((a, k) => a + (d(`opcounters.${k}`) || 0), 0);
    const lat = (k: string) => {
      const ops = d(`opLatencies.${k}.ops`);
      return ops > 0 ? Math.round((d(`opLatencies.${k}.latency`) / ops / 1000) * 100) / 100 : null;
    };
    const cpuMicros = d('extra_info.user_time_us') + d('extra_info.system_time_us');
    const cpuPct = prev && Number.isFinite(cpuMicros) && dt > 0 ? Math.round((cpuMicros / 1e6 / dt / this.cores) * 1000) / 10 : null;

    const exec = ss.queues?.execution;
    const queued = (side: 'read' | 'write') => {
      const q = exec?.[side];
      if (!q) return 0;
      return toNum(q.normalPriority?.queueLength ?? q.queueLength ?? 0) + toNum(q.lowPriority?.queueLength ?? 0);
    };
    const ingressStats = ss.network?.ingressRequestRateLimiter;
    const ingress = ingressStats
      ? {
          attempted: d('network.ingressRequestRateLimiter.attemptedAdmissions'),
          admitted: d('network.ingressRequestRateLimiter.successfulAdmissions'),
          rejected: d('network.ingressRequestRateLimiter.rejectedAdmissions'),
          queued: d('network.ingressRequestRateLimiter.addedToQueue'),
          avgQueuedMicros: Number.isFinite(toNum(ingressStats.averageTimeQueuedMicros)) ? toNum(ingressStats.averageTimeQueuedMicros) : null,
          queueLength: prev ? Math.max(0, toNum(ingressStats.addedToQueue) - toNum(ingressStats.removedFromQueue) - toNum(ingressStats.interruptedInQueue ?? 0)) : null,
        }
      : null;

    this.prev = ss;
    this.prevAt = now;
    return {
      sec,
      ok: true,
      pollMs: Math.round(pollMs),
      connections: toNum(ss.connections?.current),
      residentMb: toNum(ss.mem?.resident),
      cpuPct,
      serverOpsPerSec: dt > 0 ? Math.round(opsDelta / dt) : undefined,
      serverAvgLatencyMs: { reads: lat('reads'), writes: lat('writes'), commands: lat('commands') },
      executionQueue: exec
        ? {
            readOut: toNum(exec.read?.normalPriority?.out ?? exec.read?.out ?? 0),
            readQueued: queued('read'),
            writeOut: toNum(exec.write?.normalPriority?.out ?? exec.write?.out ?? 0),
            writeQueued: queued('write'),
            deprioritizations: d('queues.execution.totalDeprioritizations') || 0,
          }
        : undefined,
      ingress,
    };
  }
}

function get(doc: Document, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Document)[k] : undefined), doc);
}

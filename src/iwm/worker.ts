import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import { CommandFailedEvent, MongoClient, MongoError } from 'mongodb';
import { classifyError, retryOptions } from '../utils/mongo.js';
import { Rng, WeightedPicker } from '../utils/random.js';
import { Histogram } from '../utils/stats.js';
import { OpClass, READ_CLASSES, makeOperations, parseMix } from './operations.js';
import { expectedCount } from './schedule.js';
import type { ClassCounters, SecondSample, WorkerConfig, WorkerMessage } from './types.js';

/**
 * Open-loop load generator.
 *
 * Requests are issued on a fixed arrival schedule whether or not earlier ones
 * have finished - like shoppers who keep arriving when the site is slow. A
 * closed loop ("N threads, send next when previous returns") would slow down
 * with the database and hide overload. Latency is measured from the moment a
 * request was *scheduled*, so time spent queued in the client counts too
 * (avoids coordinated omission).
 */

const cfg = workerData as WorkerConfig;
const port = parentPort!;
const send = (m: WorkerMessage) => port.postMessage(m);

type Bucket = { perClass: Map<string, { c: Omit<ClassCounters, 'hist'>; h: Histogram }>; serverRejected: number; errorCodes: Record<string, number> };

const buckets = new Map<number, Bucket>();
let t0 = 0;
let inflight = 0;
// Retry budget (token bucket): each original request earns `retryBudget` tokens,
// each retry spends one. Without it, retries under sustained overload multiply
// the load - the classic retry storm.
let retryTokens = 10;

function bucket(sec: number): Bucket {
  let b = buckets.get(sec);
  if (!b) buckets.set(sec, (b = { perClass: new Map(), serverRejected: 0, errorCodes: {} }));
  return b;
}

function counters(sec: number, cls: string) {
  const b = bucket(sec);
  let e = b.perClass.get(cls);
  if (!e) b.perClass.set(cls, (e = { c: { attempted: 0, clientDropped: 0, ok: 0, okWithinSlo: 0, rejected: 0, timeouts: 0, errors: 0, retries: 0 }, h: new Histogram() }));
  return e;
}

const nowSec = () => Math.floor((performance.now() - t0) / 1000);

class ClientDeadline extends Error {
  constructor() {
    super('client deadline exceeded');
    this.name = 'ClientDeadline';
  }
}

async function main() {
  const client = new MongoClient(cfg.uri, {
    appName: '9runner-load',
    maxPoolSize: cfg.poolSize,
    minPoolSize: Math.min(cfg.poolSize, 20),
    maxConnecting: 8,
    serverSelectionTimeoutMS: 15_000,
    monitorCommands: cfg.retryMode === 'driver',
    ...retryOptions(cfg.retryMode),
  });
  await client.connect();
  if (cfg.retryMode === 'driver') {
    // The driver may retry an overload rejection and then succeed. Count the
    // server's rejections anyway so "accepted" is not overstated.
    client.on('commandFailed', (ev: CommandFailedEvent) => {
      if (classifyError(ev.failure).kind === 'rejected') bucket(nowSec()).serverRejected++;
    });
  }

  const rng = new Rng(`${cfg.seed}:load:${cfg.workerIndex}`);
  const ops = makeOperations({
    db: client.db(cfg.dbName),
    rng,
    productCount: cfg.productCount,
    reviewCount: cfg.reviewCount,
    searchIndex: cfg.searchIndex,
  });
  const mix = parseMix(cfg.mix, cfg.searchAvailable);
  const picker = new WeightedPicker(mix.classes, mix.weights);

  // Warm the pool so the first second isn't dominated by TLS handshakes.
  await Promise.all(Array.from({ length: Math.min(cfg.poolSize, 20) }, () => client.db('admin').command({ ping: 1 }).catch(() => undefined)));
  send({ type: 'ready' });
  const startAt: number = await new Promise((resolve) => port.once('message', (m) => resolve(m.startAt)));
  await new Promise((r) => setTimeout(r, Math.max(0, startAt - Date.now())));

  t0 = performance.now();
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  const share = 1 / cfg.workers;
  let issued = 0;
  let lastFlushed = -1;

  const flush = (uptoSec: number) => {
    for (let s = lastFlushed + 1; s <= uptoSec; s++) {
      const b = buckets.get(s);
      const perClass: Record<string, ClassCounters> = {};
      if (b) for (const [cls, { c, h }] of b.perClass) perClass[cls] = { ...c, hist: h.serialize() };
      const sample: SecondSample = {
        sec: s,
        perClass,
        serverRejectedAttempts: b?.serverRejected ?? 0,
        inflight,
        eventLoopP99Ms: eld.count > 0 ? Math.round(eld.percentile(99) / 1e4) / 100 : 0,
        errorCodes: b?.errorCodes ?? {},
      };
      eld.reset();
      buckets.delete(s);
      send({ type: 'second', sample });
    }
    lastFlushed = Math.max(lastFlushed, uptoSec);
  };

  const execute = async (cls: OpClass, scheduledAt: number) => {
    const sentSec = Math.floor((scheduledAt - t0) / 1000);
    if (inflight >= cfg.maxInflight) {
      counters(sentSec, cls).c.attempted++;
      counters(sentSec, cls).c.clientDropped++;
      return;
    }
    counters(sentSec, cls).c.attempted++;
    inflight++;
    retryTokens = Math.min(retryTokens + cfg.retryBudget, 100);
    let attempt = 0;
    let outcome: ReturnType<typeof classifyError> | null = null;
    const deadline = scheduledAt + cfg.opTimeoutMs;
    for (;;) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new ClientDeadline();
        // timeoutMS makes the driver enforce the deadline (pool wait, server
        // selection, server-side maxTimeMS). The race is only a safety net.
        await Promise.race([
          ops[cls](Math.max(1, Math.floor(remaining))),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new ClientDeadline()), remaining + 1_000); }),
        ]);
        outcome = { kind: 'ok', code: 'ok' };
      } catch (e) {
        outcome = classifyError(e);
        const retryable = outcome.kind === 'rejected' && cfg.retryMode === 'app' && attempt < cfg.appMaxRetries && retryTokens >= 1
          && (READ_CLASSES.has(cls) || (e instanceof MongoError && e.hasErrorLabel('RetryableError')));
        if (retryable) {
          attempt++;
          retryTokens -= 1;
          counters(nowSec(), cls).c.retries++;
          // Full-jitter exponential backoff, as recommended for overload errors.
          const backoff = Math.random() * Math.min(2_000, 50 * 2 ** attempt);
          if (performance.now() + backoff < deadline) {
            clearTimeout(timer);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
        }
      } finally {
        clearTimeout(timer);
      }
      break;
    }
    inflight--;
    const done = nowSec();
    const latency = performance.now() - scheduledAt;
    const e = counters(done, cls);
    switch (outcome!.kind) {
      case 'ok':
        e.c.ok++;
        e.h.record(latency);
        if (latency <= cfg.sloMs) e.c.okWithinSlo++;
        break;
      case 'rejected': e.c.rejected++; break;
      case 'timeout': e.c.timeouts++; break;
      default: e.c.errors++;
    }
    if (outcome!.kind !== 'ok') {
      const codes = bucket(done).errorCodes;
      const key = `${outcome!.kind}:${outcome!.code}`;
      codes[key] = (codes[key] ?? 0) + 1;
    }
  };

  // Scheduler: every tick, issue however many requests the arrival curve says
  // are due. If the event loop stalls, the backlog is issued on the next tick
  // with its original scheduled time, so the stall shows up as latency.
  const totalMs = cfg.schedule.totalSec * 1000;
  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = performance.now() - t0;
      const due = Math.floor(expectedCount(cfg.schedule, Math.min(elapsed, totalMs) / 1000) * share);
      const backlog = due - issued;
      for (let k = 0; k < backlog; k++) {
        issued++;
        // Spread the scheduled times of this tick's requests over the tick interval.
        const scheduledAt = t0 + Math.min(elapsed, totalMs) - ((backlog - 1 - k) / Math.max(backlog, 1)) * Math.min(elapsed, 5);
        void execute(picker.pick(rng), scheduledAt);
      }
      flush(nowSec() - 1);
      if (elapsed >= totalMs) return resolve();
      setTimeout(tick, 2);
    };
    tick();
  });

  // Drain: give in-flight requests until their deadline, then report.
  const drainUntil = performance.now() + cfg.opTimeoutMs + 1_000;
  while (inflight > 0 && performance.now() < drainUntil) {
    await new Promise((r) => setTimeout(r, 50));
    flush(nowSec() - 1);
  }
  flush(nowSec());
  eld.disable();
  send({ type: 'done' });
  await client.close().catch(() => undefined);
}

main().catch((e) => {
  send({ type: 'error', message: (e as Error).stack ?? String(e) });
});

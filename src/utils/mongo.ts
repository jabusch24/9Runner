import { MongoClient, MongoClientOptions, MongoError, MongoServerError, Db } from 'mongodb';
import os from 'node:os';
import { DemoEnvironment, hostOf, isLocalUri, redactUri } from '../config/environments.js';
import { settings } from '../config/settings.js';

const clients = new Map<string, MongoClient>();

export type RetryMode = 'none' | 'driver' | 'app';

/**
 * Driver retry behaviour matters a lot for overload tests: driver 7.x retries
 * SystemOverloadedError up to `maxAdaptiveRetries` (default 2) times with
 * backoff, which hides Load Shedding rejections inside a slower "success".
 *   none   - no driver retries: we see exactly what the server did
 *   driver - driver defaults (what an unmodified application gets)
 *   app    - driver retries off, the workload retries with its own backoff
 *            so every retry is counted
 */
export function retryOptions(mode: RetryMode): MongoClientOptions {
  if (mode === 'driver') return { retryReads: true, retryWrites: true };
  return { retryReads: false, retryWrites: false, maxAdaptiveRetries: 0 };
}

export async function getClient(env: DemoEnvironment, purpose = 'demo', extra: MongoClientOptions = {}): Promise<MongoClient> {
  const key = `${env.id}:${purpose}`;
  const existing = clients.get(key);
  if (existing) return existing;
  const client = new MongoClient(env.uri, {
    appName: `9runner-${purpose}`,
    serverSelectionTimeoutMS: 15_000,
    ...extra,
  });
  await client.connect();
  clients.set(key, client);
  return client;
}

export async function getDb(env: DemoEnvironment, purpose = 'demo'): Promise<Db> {
  return (await getClient(env, purpose)).db(settings.dbName);
}

export async function closeAll() {
  await Promise.allSettled([...clients.values()].map((c) => c.close()));
  clients.clear();
}

export type OutcomeKind = 'ok' | 'rejected' | 'timeout' | 'error';

/**
 * Overload rejections are identified by the SystemOverloadedError label first
 * (that's what Atlas documents and what drivers key off), then by known codes:
 *   462 IngressRequestRateLimitExceeded   (observed on 8.3 self-managed)
 *   463 IngressOperationRateLimitExceeded (Atlas IWM docs)
 */
export function classifyError(err: unknown): { kind: OutcomeKind; code: string } {
  if (err instanceof MongoError) {
    const labels = (err as MongoError).errorLabels ?? [];
    const codeName = (err as MongoServerError).codeName ?? '';
    const code = (err as MongoServerError).code;
    const tag = `${code ?? ''}${codeName ? ':' + codeName : ''}` || err.name;
    if (labels.includes('SystemOverloadedError') || code === 462 || code === 463 || /RateLimitExceeded|Overload/i.test(codeName)) {
      return { kind: 'rejected', code: tag };
    }
    if (code === 50 || codeName === 'MaxTimeMSExpired' || err.name === 'MongoOperationTimeoutError' || /timed out/i.test(err.message)) {
      return { kind: 'timeout', code: tag || 'timeout' };
    }
    return { kind: 'error', code: tag };
  }
  if (err instanceof Error && err.name === 'ClientDeadline') return { kind: 'timeout', code: 'client-deadline' };
  return { kind: 'error', code: err instanceof Error ? err.name : 'unknown' };
}

export function isOverloadError(err: unknown): boolean {
  return classifyError(err).kind === 'rejected';
}

export type ServerFacts = {
  envId: string;
  envName: string;
  host: string;
  uri: string;
  location: 'local' | 'remote';
  version: string | null;
  major: number | null;
  gitVersion?: string;
  modules?: string[];
  topology: string;
  setName?: string;
  tier?: string;
  configuredIwm?: boolean;
  configuredLoadShedding?: boolean;
  /** What the server itself reports about its ingress limiter, when readable. */
  ingressRateLimiter?: Record<string, unknown> | null;
  executionControl?: Record<string, unknown> | null;
  serverStatusReadable: boolean;
  warnings: string[];
};

export async function collectServerFacts(env: DemoEnvironment): Promise<ServerFacts> {
  const client = await getClient(env, 'monitor');
  const admin = client.db('admin');
  const warnings: string[] = [];
  const build = await admin.command({ buildInfo: 1 }).catch(() => null);
  const hello = await admin.command({ hello: 1 }).catch(() => null);
  const version: string | null = build?.version ?? null;
  const major = version ? Number(version.split('.')[0]) : null;
  if (env.expectedMajor && major && major !== env.expectedMajor) {
    warnings.push(`${env.name} is labelled as MongoDB ${env.expectedMajor} but reports ${version}.`);
  }
  let ingressRateLimiter: Record<string, unknown> | null = null;
  let executionControl: Record<string, unknown> | null = null;
  let serverStatusReadable = true;
  try {
    const ss = await admin.command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0, tcmalloc: 0 });
    ingressRateLimiter = (ss.network?.ingressRequestRateLimiter as Record<string, unknown>) ?? null;
    const ex = ss.queues?.execution;
    executionControl = ex
      ? {
          usesThroughputProbing: ex.usesThroughputProbing,
          usesPrioritization: ex.usesPrioritization,
          heuristicDeprioritization: ex.heuristicDeprioritization,
          deprioritizationGate: ex.deprioritizationGate,
        }
      : null;
  } catch (e) {
    serverStatusReadable = false;
    warnings.push(`serverStatus not readable (${(e as Error).message}). Grant clusterMonitor to collect queue/ingress metrics.`);
  }
  const params = await admin
    .command({ getParameter: 1, ingressRequestRateLimiterEnabled: 1, ingressRequestAdmissionRatePerSec: 1, ingressRequestAdmissionMaxQueueDepth: 1 })
    .catch(() => null);
  if (params && ingressRateLimiter) {
    ingressRateLimiter = {
      ...ingressRateLimiter,
      enabled: params.ingressRequestRateLimiterEnabled,
      admissionRatePerSec: toNum(params.ingressRequestAdmissionRatePerSec),
      maxQueueDepth: toNum(params.ingressRequestAdmissionMaxQueueDepth),
    };
  }
  return {
    envId: env.id,
    envName: env.name,
    host: hostOf(env.uri),
    uri: redactUri(env.uri),
    location: isLocalUri(env.uri) ? 'local' : 'remote',
    version,
    major,
    gitVersion: build?.gitVersion,
    modules: build?.modules,
    topology: hello?.msg === 'isdbgrid' ? 'sharded' : hello?.setName ? 'replicaSet' : 'standalone',
    setName: hello?.setName,
    tier: env.tier,
    configuredIwm: env.iwm,
    configuredLoadShedding: env.loadShedding,
    ingressRateLimiter,
    executionControl,
    serverStatusReadable,
    warnings,
  };
}

/** Convert BSON Long / Int / Double-ish values to plain numbers. */
export function toNum(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && 'toNumber' in (v as object)) return (v as { toNumber(): number }).toNumber();
  return Number(v);
}

export function clientFacts() {
  return {
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpus: os.cpus().length,
    cpuModel: os.cpus()[0]?.model,
    memoryGb: Math.round(os.totalmem() / 1e9),
    node: process.version,
  };
}

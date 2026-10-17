import type { SerializedHistogram } from '../utils/stats.js';
import type { RetryMode } from '../utils/mongo.js';
import type { Schedule } from './schedule.js';

export type ClassCounters = {
  /** requests the schedule asked for */
  attempted: number;
  /** could not be sent because the worker hit MAX_INFLIGHT (client limit, not a server outcome) */
  clientDropped: number;
  ok: number;
  okWithinSlo: number;
  rejected: number;
  timeouts: number;
  errors: number;
  /** app-level retries (CLIENT_RETRY_MODE=app) */
  retries: number;
  hist: SerializedHistogram;
};

export type SecondSample = {
  sec: number;
  perClass: Record<string, ClassCounters>;
  /** server-side overload rejections seen by command monitoring, including ones the driver retried away */
  serverRejectedAttempts: number;
  inflight: number;
  eventLoopP99Ms: number;
  errorCodes: Record<string, number>;
};

export type WorkerConfig = {
  workerIndex: number;
  workers: number;
  uri: string;
  dbName: string;
  schedule: Schedule;
  mix: string;
  searchAvailable: boolean;
  searchIndex: string;
  productCount: number;
  reviewCount: number;
  seed: string;
  sloMs: number;
  opTimeoutMs: number;
  poolSize: number;
  maxInflight: number;
  retryMode: RetryMode;
  appMaxRetries: number;
  /** retries allowed per original request, e.g. 0.1 = at most 10% extra load */
  retryBudget: number;
};

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'second'; sample: SecondSample }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type ServerSample = {
  sec: number;
  ok: boolean;
  error?: string;
  pollMs: number;
  connections?: number;
  residentMb?: number;
  cpuPct?: number | null;
  serverOpsPerSec?: number;
  serverAvgLatencyMs?: { reads: number | null; writes: number | null; commands: number | null };
  executionQueue?: { readOut: number; readQueued: number; writeOut: number; writeQueued: number; deprioritizations: number };
  ingress?: { attempted: number; admitted: number; rejected: number; queued: number; avgQueuedMicros: number | null; queueLength: number | null } | null;
  canary?: { p50: number | null; max: number | null; failures: number; count: number };
};

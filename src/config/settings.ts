import 'dotenv/config';

// Every tunable is an environment variable so the same command can be re-run
// with different sizes (`PRODUCT_COUNT=50000 npm run seed`). CLI flags such as
// `--peak-rps 8000` are mapped onto these names before anything reads them.

export function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) throw new Error(`${name} must be a number, got "${raw}"`);
  return v;
}

export function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

export function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const settings = {
  get dbName() { return str('DB_NAME', 'ecommerce_demo'); },
  get seed() { return str('SEED', 'mongodb-9-demo'); },
  get productCount() { return num('PRODUCT_COUNT', 500_000); },
  get reviewCount() { return num('REVIEW_COUNT', 2_000_000); },
  get orderCount() { return num('ORDER_COUNT', 200_000); },
  get seedBatchSize() { return num('SEED_BATCH_SIZE', 5_000); },
  get seedConcurrency() { return num('SEED_CONCURRENCY', 4); },
  get searchIndexName() { return str('SEARCH_INDEX_NAME', 'products_search'); },

  // Request/response style benchmarks (search, facets, aggregation)
  get warmupIterations() { return num('WARMUP_ITERATIONS', 10); },
  get measuredIterations() { return num('MEASURED_ITERATIONS', 100); },
  get benchConcurrency() { return num('BENCH_CONCURRENCY', 4); },

  // Stress tests
  get sloMs() { return num('SLO_MS', 500); },
  get opTimeoutMs() { return num('OP_TIMEOUT_MS', 5_000); },
  get workers() { return num('WORKERS', 4); },
  get poolSizePerWorker() { return num('POOL_SIZE_PER_WORKER', 250); },
  get maxInflightPerWorker() { return num('MAX_INFLIGHT_PER_WORKER', 5_000); },
  get clientRetryMode() { return str('CLIENT_RETRY_MODE', 'none') as 'none' | 'driver' | 'app'; },
  get appMaxRetries() { return num('APP_MAX_RETRIES', 3); },
  get appRetryBudget() { return num('APP_RETRY_BUDGET', 0.1); },
  get cooldownSeconds() { return num('COOLDOWN_SECONDS', 30); },
  get canaryRps() { return num('CANARY_RPS', 5); },

  get resultsDir() { return str('RESULTS_DIR', 'results'); },
  get port() { return num('PORT', 3000); },
};

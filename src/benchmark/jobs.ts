import { createRequire } from 'node:module';
import { DemoEnvironment, EnvironmentId, loadEnvironments, selectEnvironments } from '../config/environments.js';
import { settings } from '../config/settings.js';
import { benchmarkIwm, benchmarkLoadShedding, benchmarkMongo8vs9, calibrate, IWM_DEFAULT_ENVS, LS_DEFAULT_ENVS, V8V9_DEFAULT_ENVS } from '../iwm/benchmarks.js';
import type { ProgressEvent } from '../iwm/stressTest.js';
import { benchmarkAggregation, benchmarkFacets, benchmarkSearch } from '../search/benchmarks.js';
import { facetMetaPipeline } from '../search/queries.js';
import { getSearchIndexStatus } from '../search/indexDefinition.js';
import { readDatasetMeta } from '../seed/seed.js';
import { collectServerFacts, getDb } from '../utils/mongo.js';
import { defaultRunOptions } from './runner.js';
import { BenchmarkName, saveResult } from './results.js';

export type Log = (m: string) => void;
export type JobProgress = (e: ProgressEvent) => void;

const SEARCH_DEFAULT_ENVS: EnvironmentId[] = ['mongo8', 'mongo9', 'mongo9iwm', 'mongo9iwmls', 'local'];

/** Falls back to "local" so the demo works out of the box with docker compose. */
function pick(requested: string | undefined, preferred: EnvironmentId[]): DemoEnvironment[] {
  const configured = new Set(loadEnvironments().map((e) => e.id));
  let ids = preferred.filter((id) => configured.has(id));
  if (ids.length > 1) ids = ids.filter((id) => id !== 'local');
  if (ids.length === 0 && configured.has('local')) ids = ['local'];
  return selectEnvironments(requested, ids);
}

export async function runBenchmark(name: BenchmarkName | 'all', requestedEnvs: string | undefined, log: Log, onProgress?: JobProgress): Promise<Record<string, string>> {
  const saved: Record<string, string> = {};
  const opts = { ...defaultRunOptions(), onProgress: log };
  const run = async (n: BenchmarkName, f: () => Promise<object>) => {
    log(`=== benchmark: ${n} ===`);
    const result = await f();
    saved[n] = await saveResult(n, { driver: driverVersion(), ...result });
    log(`saved ${saved[n]}`);
  };
  const want = (n: BenchmarkName) => name === n || (name === 'all' && n !== 'calibrate');
  if (want('search')) await run('search', () => benchmarkSearch(pick(requestedEnvs, SEARCH_DEFAULT_ENVS), opts, log));
  if (want('facets')) await run('facets', () => benchmarkFacets(pick(requestedEnvs, SEARCH_DEFAULT_ENVS), opts, log));
  if (want('aggregation')) await run('aggregation', () => benchmarkAggregation(pick(requestedEnvs, SEARCH_DEFAULT_ENVS), opts, log, process.env.AGGREGATION_QUERIES?.split(',')));
  if (want('mongo8-vs-9')) await run('mongo8-vs-9', () => benchmarkMongo8vs9(pick(requestedEnvs, V8V9_DEFAULT_ENVS), log, onProgress));
  if (want('iwm')) await run('iwm', () => benchmarkIwm(pick(requestedEnvs, IWM_DEFAULT_ENVS), log, onProgress));
  if (want('load-shedding')) await run('load-shedding', () => benchmarkLoadShedding(pick(requestedEnvs, LS_DEFAULT_ENVS), log, onProgress));
  if (name === 'calibrate') {
    const [env] = pick(requestedEnvs, ['mongo9iwm', 'mongo8', 'mongo9', 'mongo9iwmls', 'local']);
    await run('calibrate', () => calibrate(env, log, onProgress));
  }
  return saved;
}

export function driverVersion(): string {
  const require = createRequire(import.meta.url);
  return (require('mongodb/package.json') as { version: string }).version;
}

/** Everything that decides whether a benchmark is meaningful, per environment. */
export async function probe(requestedEnvs: string | undefined, log: Log) {
  const envs = selectEnvironments(requestedEnvs ?? 'all', []);
  const out = [];
  for (const env of envs) {
    try {
      const facts = await collectServerFacts(env);
      const db = await getDb(env);
      const dataset = await readDatasetMeta(db);
      const index = await getSearchIndexStatus(db.collection('products'), settings.searchIndexName);
      let facetAggregations: string = 'not tested (no queryable index)';
      if (index.queryable) {
        facetAggregations = await db.collection('products').aggregate(facetMetaPipeline(settings.searchIndexName, { q: 'shoe' }, true)).toArray()
          .then(() => 'supported')
          .catch((e) => `NOT supported: ${(e as Error).message.replace(/^.*caused by :: /, '').slice(0, 160)}`);
      }
      const row = { env: env.id, name: env.name, ...facts, dataset, searchIndex: index, facetAggregations };
      out.push(row);
      log(`\n[${env.id}] ${env.name}`);
      log(`  server        ${facts.version ?? '?'} (${facts.topology}${facts.setName ? ' ' + facts.setName : ''}), ${facts.location}, host ${facts.host}${env.tier ? ', tier ' + env.tier : ''}`);
      log(`  labelled      IWM=${env.iwm ?? '-'} LoadShedding=${env.loadShedding ?? '-'}${env.emulation ? ' (local emulation allowed)' : ''}`);
      log(`  serverStatus  ${facts.serverStatusReadable ? 'readable' : 'NOT readable (grant clusterMonitor)'}`);
      if (facts.ingressRateLimiter) log(`  ingress RL    enabled=${facts.ingressRateLimiter.enabled} rate=${facts.ingressRateLimiter.admissionRatePerSec}/s maxQueue=${facts.ingressRateLimiter.maxQueueDepth}`);
      if (facts.executionControl) log(`  exec control  ${JSON.stringify(facts.executionControl)}`);
      log(`  dataset       ${dataset ? `${dataset.productCount.toLocaleString()} products, ${dataset.reviewCount.toLocaleString()} reviews (seed ${dataset.seed})` : 'MISSING - run npm run seed'}`);
      log(`  search index  ${index.exists ? `${index.status}${index.queryable ? ' queryable' : ''}${index.matchesExpected ? '' : ' (definition differs - run npm run search:index)'}` : `missing${index.error ? ': ' + index.error : ''}`}`);
      log(`  facet aggs    ${facetAggregations}`);
      for (const w of facts.warnings) log(`  WARNING       ${w}`);
    } catch (e) {
      log(`[${env.id}] unreachable: ${(e as Error).message}`);
      out.push({ env: env.id, error: (e as Error).message });
    }
  }
  log(`\nNode.js driver ${driverVersion()}`);
  return out;
}

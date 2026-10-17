import { Collection, Document } from 'mongodb';
import { DemoEnvironment } from '../config/environments.js';
import { settings } from '../config/settings.js';
import { RunOptions, Variant, VariantResult, runVariants, stripForStorage } from '../benchmark/runner.js';
import { readDatasetMeta } from '../seed/seed.js';
import { clientFacts, collectServerFacts, getDb } from '../utils/mongo.js';
import { compareMedians, Comparison } from '../utils/stats.js';
import { getSearchIndexStatus, PRODUCT_SEARCH_INDEX } from './indexDefinition.js';
import {
  compareFacetResults, describeQuery, facetMetaPipeline, matchThenGroupPipeline, normalizeGroupFacet, normalizeSearchMeta,
  ParityReport, productSearchPipeline, searchOperator, searchThenGroupPipeline, ShopperQuery,
} from './queries.js';

type Log = (m: string) => void;

export const SEARCH_QUERIES: { id: string; query: ShopperQuery }[] = [
  { id: 'running-shoes', query: { q: 'running shoes', matchCriteria: 'all' } },
  { id: 'running-shoes-filtered', query: { q: 'running shoes', matchCriteria: 'all', brands: ['Nike', 'Asics', 'Hoka'], priceMin: 80, priceMax: 180 } },
  { id: 'wireless-headphones', query: { q: 'wireless headphones', matchCriteria: 'all', ratingMin: 4 } },
  { id: 'waterproof-jacket', query: { q: 'waterproof jacket', matchCriteria: 'all', inStockOnly: true } },
];

/**
 * The selectivity sweep: Search-side aggregation should matter more as the
 * matched set grows, because the $group path has to move every matching
 * document from mongot through mongod. Structured queries can also run with
 * no Search at all ($match on a B-tree index), the classic baseline.
 */
export const AGGREGATION_QUERIES: { id: string; query: ShopperQuery; note: string }[] = [
  { id: 'text-narrow', query: { q: 'wireless headphones', matchCriteria: 'all' }, note: 'full-text, ~4% of catalog' },
  { id: 'text-medium', query: { q: 'running shoes', matchCriteria: 'all' }, note: 'full-text, ~18% of catalog' },
  { id: 'text-broad', query: { q: 'running', matchCriteria: 'all' }, note: 'full-text, ~50% of catalog' },
  { id: 'struct-narrow', query: { brands: ['Nike'], priceMax: 150 }, note: 'structured, ~11% of catalog' },
  { id: 'struct-medium', query: { categories: ['Running Shoes'] }, note: 'structured, ~18% of catalog' },
  { id: 'struct-broad', query: { categories: ['Running Shoes', 'Sneakers', 'Jackets', 'T-Shirts'] }, note: 'structured, ~54% of catalog' },
  { id: 'struct-all', query: {}, note: 'structured, 100% of catalog' },
];

async function context(env: DemoEnvironment) {
  const db = await getDb(env);
  const products = db.collection('products');
  const facts = await collectServerFacts(env);
  const dataset = await readDatasetMeta(db);
  const index = await getSearchIndexStatus(products, settings.searchIndexName);
  return { db, products, facts, dataset, index };
}

function header(ctx: Awaited<ReturnType<typeof context>>, opts: RunOptions) {
  return {
    server: ctx.facts,
    dataset: ctx.dataset,
    searchIndex: { ...ctx.index, definition: PRODUCT_SEARCH_INDEX },
    client: clientFacts(),
    options: { warmup: opts.warmup, iterations: opts.iterations, concurrency: opts.concurrency, throughputSeconds: opts.throughputSeconds },
  };
}

function searchReady(ctx: Awaited<ReturnType<typeof context>>, log: Log, env: DemoEnvironment): boolean {
  if (!ctx.index.exists || !ctx.index.queryable) {
    log(`[${env.id}] search index "${settings.searchIndexName}" is not queryable (${ctx.index.status ?? ctx.index.error ?? 'missing'}) - skipping. Run "npm run search:index".`);
    return false;
  }
  return true;
}

const aggregate = (coll: Collection<Document>, pipeline: Document[]) => coll.aggregate(pipeline, { maxTimeMS: 120_000 }).toArray();

// ------------------------------------------------------------- Part A: search

export async function benchmarkSearch(envs: DemoEnvironment[], opts: RunOptions, log: Log) {
  const perEnv: Record<string, unknown>[] = [];
  for (const env of envs) {
    const ctx = await context(env);
    if (!searchReady(ctx, log, env)) { perEnv.push({ envId: env.id, envName: env.name, skipped: true, ...header(ctx, opts) }); continue; }
    log(`[${env.id}] Part A - ranked product search (${SEARCH_QUERIES.length} queries)`);
    const variants: Variant[] = SEARCH_QUERIES.map(({ id, query }) => ({
      id,
      label: describeQuery(query),
      executionPath: 'mongot: match + score + top-N → mongod: fetch 24 docs',
      run: async () => {
        const docs = await aggregate(ctx.products, productSearchPipeline(settings.searchIndexName, query, 24));
        return { docs: docs.length, result: docs.slice(0, 5) };
      },
    }));
    const results = await runVariants(variants, { ...opts, onProgress: log });
    const totals = await Promise.all(SEARCH_QUERIES.map(async ({ query }) => {
      const [m] = await aggregate(ctx.products, [{ $searchMeta: { index: settings.searchIndexName, ...searchOperator(query), count: { type: 'total' } } }]);
      return m?.count?.total ?? null;
    }));
    perEnv.push({
      envId: env.id, envName: env.name, ...header(ctx, opts),
      queries: results.map((r, i) => ({ ...stripForStorage(r), query: SEARCH_QUERIES[i].query, totalMatches: totals[i], sample: r.lastResult })),
    });
  }
  return { perEnv, crossEnv: crossEnvComparisons(perEnv, 'queries'), interpretation: interpretSearch(perEnv) };
}

// ------------------------------------------------------------- Part B: facets

export async function benchmarkFacets(envs: DemoEnvironment[], opts: RunOptions, log: Log) {
  const perEnv: Record<string, unknown>[] = [];
  const query = SEARCH_QUERIES[0].query;
  for (const env of envs) {
    const ctx = await context(env);
    if (!searchReady(ctx, log, env)) { perEnv.push({ envId: env.id, envName: env.name, skipped: true, ...header(ctx, opts) }); continue; }
    log(`[${env.id}] Part B - faceted search for ${describeQuery(query)}`);
    const index = settings.searchIndexName;
    const variants: Variant[] = [
      {
        id: 'facets-counts',
        label: '$searchMeta facets (counts)',
        executionPath: 'mongot: match + facet counts → mongod: 1 metadata doc',
        run: async () => ({ result: normalizeSearchMeta((await aggregate(ctx.products, facetMetaPipeline(index, query, false)))[0]) }),
      },
      {
        id: 'facets-metrics',
        label: '$searchMeta facets + aggregations (avg/min/max/sum)',
        executionPath: 'mongot: match + facet buckets + per-bucket metrics (Preview) → mongod: 1 metadata doc',
        run: async () => ({ result: normalizeSearchMeta((await aggregate(ctx.products, facetMetaPipeline(index, query, true)))[0]) }),
      },
      {
        id: 'results-and-facets',
        label: '$search top 24 + $$SEARCH_META facets (one round trip)',
        executionPath: 'mongot: match + score + facets → mongod: fetch 24 docs + metadata',
        run: async () => {
          const pipeline = [
            { $search: { index, facet: facetMetaPipeline(index, query, false)[0].$searchMeta.facet, count: { type: 'total' } } },
            { $limit: 24 },
            { $facet: { docs: [{ $project: { name: 1, price: 1, brand: 1 } }], meta: [{ $replaceWith: '$$SEARCH_META' }, { $limit: 1 }] } },
          ];
          const [out] = await aggregate(ctx.products, pipeline);
          return { docs: out?.docs?.length ?? 0, result: normalizeSearchMeta(out?.meta?.[0]) };
        },
      },
    ];
    const results = await runVariants(variants, { ...opts, onProgress: log });
    perEnv.push({
      envId: env.id, envName: env.name, ...header(ctx, opts), query, queryLabel: describeQuery(query),
      variants: results.map((r) => ({ ...stripForStorage(r), facets: r.lastResult })),
      facetAggregationsSupported: results.find((r) => r.id === 'facets-metrics')?.supported ?? false,
    });
  }
  return { perEnv, crossEnv: crossEnvComparisons(perEnv, 'variants'), interpretation: interpretFacets(perEnv) };
}

// ------------------------------------------------- Part C: Search vs $group

export async function benchmarkAggregation(envs: DemoEnvironment[], opts: RunOptions, log: Log, only?: string[]) {
  const perEnv: Record<string, unknown>[] = [];
  const queries = AGGREGATION_QUERIES.filter((q) => !only?.length || only.includes(q.id));
  for (const env of envs) {
    const ctx = await context(env);
    const hasSearch = Boolean(ctx.index.exists && ctx.index.queryable);
    if (!hasSearch) log(`[${env.id}] no queryable search index - only the $match → $group baseline will run`);
    const N = ctx.dataset?.productCount ?? (await ctx.products.estimatedDocumentCount());
    const index = settings.searchIndexName;
    const perQuery: Record<string, unknown>[] = [];
    for (const { id, query, note } of queries) {
      log(`[${env.id}] Part C - ${id}: ${describeQuery(query)} (${note})`);
      const variants: Variant[] = [];
      if (hasSearch) {
        variants.push(
          { id: 'searchMeta-counts', label: 'Search facets: counts', executionPath: 'mongot facet collector', run: async () => ({ result: normalizeSearchMeta((await aggregate(ctx.products, facetMetaPipeline(index, query, false)))[0]) }) },
          { id: 'searchMeta-metrics', label: 'Search facets: counts + avg/min/max/sum', executionPath: 'mongot facet aggregations (Preview)', run: async () => ({ result: normalizeSearchMeta((await aggregate(ctx.products, facetMetaPipeline(index, query, true)))[0]) }) },
          { id: 'search-group-counts', label: '$search → $group: counts', executionPath: 'mongot match → mongod full-doc lookup → $group', run: async () => ({ result: normalizeGroupFacet((await aggregate(ctx.products, searchThenGroupPipeline(index, query, false, false)))[0]) }) },
          { id: 'search-group-metrics', label: '$search → $group: counts + avg/min/max/sum', executionPath: 'mongot match → mongod full-doc lookup → $group', run: async () => ({ result: normalizeGroupFacet((await aggregate(ctx.products, searchThenGroupPipeline(index, query, true, false)))[0]) }) },
          { id: 'search-stored-group-metrics', label: '$search (returnStoredSource) → $group: metrics', executionPath: 'mongot match + stored fields → mongod $group (no doc lookup)', run: async () => ({ result: normalizeGroupFacet((await aggregate(ctx.products, searchThenGroupPipeline(index, query, true, true)))[0]) }) },
        );
      }
      if (!query.q) {
        variants.push(
          { id: 'match-group-counts', label: '$match (B-tree) → $group: counts', executionPath: 'mongod only: index scan + fetch + $group', run: async () => ({ result: normalizeGroupFacet((await aggregate(ctx.products, matchThenGroupPipeline(query, false)))[0]) }) },
          { id: 'match-group-metrics', label: '$match (B-tree) → $group: counts + avg/min/max/sum', executionPath: 'mongod only: index scan + fetch + $group', run: async () => ({ result: normalizeGroupFacet((await aggregate(ctx.products, matchThenGroupPipeline(query, true)))[0]) }) },
        );
      }
      const results = await runVariants(variants, { ...opts, onProgress: log });
      const byId = new Map(results.map((r) => [r.id, r]));
      const matched = (byId.get('search-group-counts')?.lastResult ?? byId.get('match-group-counts')?.lastResult) as { total: number } | undefined;
      perQuery.push({
        id, note, query, label: describeQuery(query),
        matchedDocs: matched?.total ?? null,
        matchedPct: matched ? Math.round((matched.total / N) * 1000) / 10 : null,
        variants: results.map(stripForStorage),
        parity: parityChecks(byId),
        comparisons: aggregationComparisons(byId),
      });
    }
    perEnv.push({ envId: env.id, envName: env.name, ...header(ctx, opts), queries: perQuery });
  }
  return { perEnv, interpretation: interpretAggregation(perEnv) };
}

function parityChecks(byId: Map<string, VariantResult>): Record<string, ParityReport> {
  const out: Record<string, ParityReport> = {};
  const pairs: [string, string][] = [
    ['searchMeta-counts', 'search-group-counts'],
    ['searchMeta-metrics', 'search-group-metrics'],
    ['search-group-metrics', 'search-stored-group-metrics'],
    ['match-group-counts', 'searchMeta-counts'],
    ['match-group-metrics', 'search-group-metrics'],
  ];
  for (const [a, b] of pairs) {
    const ra = byId.get(a);
    const rb = byId.get(b);
    if (!ra?.supported || !rb?.supported || !ra.lastResult || !rb.lastResult) continue;
    out[`${a} = ${b}`] = compareFacetResults(ra.lastResult as never, rb.lastResult as never);
  }
  return out;
}

function aggregationComparisons(byId: Map<string, VariantResult>): Comparison[] {
  const pairs: [string, string][] = [
    ['search-group-counts', 'searchMeta-counts'],
    ['search-group-metrics', 'searchMeta-metrics'],
    ['search-group-metrics', 'search-stored-group-metrics'],
    ['match-group-counts', 'searchMeta-counts'],
    ['match-group-metrics', 'searchMeta-metrics'],
  ];
  const out: Comparison[] = [];
  for (const [base, cand] of pairs) {
    const b = byId.get(base);
    const c = byId.get(cand);
    if (!b?.supported || !c?.supported || b.samplesMs.length === 0 || c.samplesMs.length === 0) continue;
    out.push(compareMedians(b.label, b.samplesMs, c.label, c.samplesMs));
  }
  return out;
}

/** Same query, different deployments. Explicitly labelled as NOT a server-version comparison. */
function crossEnvComparisons(perEnv: Record<string, any>[], key: string) {
  const ready = perEnv.filter((e) => !e.skipped && e[key]);
  if (ready.length < 2) return [];
  const [base, ...others] = ready;
  const out: (Comparison & { item: string; caveat: string })[] = [];
  for (const other of others) {
    for (const item of base[key] as any[]) {
      const match = (other[key] as any[]).find((x) => x.id === item.id);
      if (!match?.samplesMs?.length || !item.samplesMs?.length) continue;
      out.push({
        ...compareMedians(`${base.envName}`, item.samplesMs, `${other.envName}`, match.samplesMs),
        item: item.label,
        caveat: 'Search work runs in mongot, which Atlas versions independently of the MongoDB server. A difference here reflects mongot version, Search Node vs co-located deployment, cluster tier and network - not "MongoDB 9 vs 8".',
      });
    }
  }
  return out;
}

// --------------------------------------------------------------- narratives

function fmt(ms: number | null | undefined) {
  return ms == null ? 'n/a' : ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

function interpretSearch(perEnv: Record<string, any>[]): string[] {
  const lines: string[] = [];
  for (const e of perEnv.filter((x) => !x.skipped)) {
    const q = e.queries as any[];
    const worst = q.reduce((a, b) => ((b.latency.p95 ?? 0) > (a.latency.p95 ?? 0) ? b : a));
    lines.push(`${e.envName}: ranked search returns the top 24 of up to ${Math.max(...q.map((x) => x.totalMatches ?? 0)).toLocaleString()} matches with p50 ${fmt(q[0].latency.p50)} and p95 ${fmt(q[0].latency.p95)}; the slowest query (${worst.label}) has p95 ${fmt(worst.latency.p95)}.`);
  }
  lines.push('What this means for an e-commerce platform: relevance ranking, fuzzy text matching and filtering happen inside the Search index; mongod only fetches the handful of products shown on the page, so latency is dominated by the size of the page, not by the size of the catalogue.');
  return lines;
}

function interpretFacets(perEnv: Record<string, any>[]): string[] {
  const lines: string[] = [];
  for (const e of perEnv.filter((x) => !x.skipped)) {
    const v = new Map((e.variants as any[]).map((x) => [x.id, x]));
    const counts = v.get('facets-counts');
    const metrics = v.get('facets-metrics');
    lines.push(`${e.envName}: brand/price/rating facet counts for ${e.queryLabel} take p50 ${fmt(counts?.latency.p50)}.`);
    if (metrics && !metrics.supported) {
      lines.push(`${e.envName}: per-bucket facet aggregations (avg/min/max/sum) are NOT available on this deployment: "${metrics.unsupportedReason}". This is a Search engine (mongot) capability, documented as Preview - it is not tied to the MongoDB server version, so a 9.0 cluster can lack it and an 8.x cluster can have it.`);
    } else if (metrics) {
      lines.push(`${e.envName}: adding avg/min/max/sum per bucket costs p50 ${fmt(metrics.latency.p50)} vs ${fmt(counts?.latency.p50)} for counts only - the metrics are computed from the index without returning documents to mongod.`);
    }
  }
  lines.push('What this means for an e-commerce platform: the left-hand filter panel ("Nike 32,100 · Adidas 27,430 · €50–€100 31,921 …") is answered from the Search index in one request, alongside or instead of the result page.');
  return lines;
}

function interpretAggregation(perEnv: Record<string, any>[]): string[] {
  const lines: string[] = [];
  for (const e of perEnv) {
    for (const q of e.queries as any[]) {
      const cmp = (q.comparisons as Comparison[]).map((c) => c.explanation);
      const parityFails = Object.entries(q.parity as Record<string, ParityReport>).filter(([, p]) => !p.ok).map(([k]) => k);
      lines.push(`${e.envName} · ${q.label} (${q.matchedPct ?? '?'}% of catalogue): ${cmp.join(' ') || 'no comparable pairs ran.'}${parityFails.length ? ` ⚠ Result parity failed for ${parityFails.join(', ')} - the variants did not answer the same question; do not compare their timings.` : ''}`);
    }
  }
  lines.push('How to read this: the $search → $group path moves every matching document out of the Search index and through mongod before grouping, so its cost grows with the number of matches. The facet path answers from the index. Expect little difference for narrow queries and a growing gap for broad ones; returnStoredSource shows how much of the gap is document lookup. A B-tree $match → $group can be competitive for simple structured filters - that is a valid result, not a failure of the demo.');
  return lines;
}

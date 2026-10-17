import { Router } from 'express';
import { performance } from 'node:perf_hooks';
import { getEnvironment } from '../../config/environments.js';
import { settings } from '../../config/settings.js';
import { getDb } from '../../utils/mongo.js';
import { CATEGORIES } from '../../seed/catalog.js';
import {
  compareFacetResults, describeQuery, facetMetaPipeline, matchThenGroupPipeline, normalizeGroupFacet, normalizeSearchMeta,
  productSearchPipeline, searchThenGroupPipeline, ShopperQuery,
} from '../../search/queries.js';

/** Interactive, single-shot versions of the Search demos (the benchmarks live in /api/jobs). */
export const searchRouter = Router();

function parseQuery(q: Record<string, unknown>): ShopperQuery {
  const list = (v: unknown) => (typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
  const n = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v));
  return {
    q: typeof q.q === 'string' && q.q.trim() ? q.q.trim() : undefined,
    matchCriteria: q.matchCriteria === 'any' ? 'any' : 'all',
    categories: list(q.categories),
    brands: list(q.brands),
    priceMin: n(q.priceMin),
    priceMax: n(q.priceMax),
    ratingMin: n(q.ratingMin),
    inStockOnly: q.inStockOnly === 'true',
  };
}

async function timed<T>(f: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const t0 = performance.now();
  try {
    const value = await f();
    return { ms: Math.round((performance.now() - t0) * 10) / 10, value };
  } catch (e) {
    return { ms: Math.round((performance.now() - t0) * 10) / 10, error: (e as Error).message.replace(/^.*caused by :: /, '') };
  }
}

searchRouter.get('/catalog', (_req, res) => {
  res.json({ categories: CATEGORIES.map((c) => ({ name: c.name, brands: c.brands.map((b) => b[0]) })) });
});

searchRouter.get('/search', async (req, res) => {
  try {
    const env = getEnvironment(String(req.query.env));
    const products = (await getDb(env)).collection('products');
    const sq = parseQuery(req.query);
    const index = settings.searchIndexName;
    const searchPipeline = productSearchPipeline(index, sq, 24);
    const facetPipeline = facetMetaPipeline(index, sq, false);
    const [results, facets] = await Promise.all([
      timed(() => products.aggregate(searchPipeline).toArray()),
      timed(async () => normalizeSearchMeta((await products.aggregate(facetPipeline).toArray())[0])),
    ]);
    res.json({ query: sq, label: describeQuery(sq), results, facets, pipelines: { search: searchPipeline, facets: facetPipeline } });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

/** Every way of computing the facet panel for one query, once each, with timings and parity. */
searchRouter.get('/facet-compare', async (req, res) => {
  try {
    const env = getEnvironment(String(req.query.env));
    const products = (await getDb(env)).collection('products');
    const sq = parseQuery(req.query);
    const index = settings.searchIndexName;
    const pipelines: Record<string, object[]> = {
      'searchMeta-counts': facetMetaPipeline(index, sq, false),
      'searchMeta-metrics': facetMetaPipeline(index, sq, true),
      'search-group-metrics': searchThenGroupPipeline(index, sq, true, false),
      'search-stored-group-metrics': searchThenGroupPipeline(index, sq, true, true),
    };
    if (!sq.q) pipelines['match-group-metrics'] = matchThenGroupPipeline(sq, true);
    const out: Record<string, unknown> = {};
    const normalized: Record<string, ReturnType<typeof normalizeSearchMeta>> = {};
    // Sequential on purpose: running them in parallel would make them compete.
    for (const [id, p] of Object.entries(pipelines)) {
      await products.aggregate(p).toArray().catch(() => undefined); // warm once
      const r = await timed(() => products.aggregate(p).toArray());
      const norm = r.value ? (id.startsWith('searchMeta') ? normalizeSearchMeta(r.value[0]) : normalizeGroupFacet(r.value[0])) : undefined;
      if (norm) normalized[id] = norm;
      out[id] = { ms: r.ms, error: r.error, facets: norm, pipeline: p };
    }
    const reference = normalized['search-group-metrics'];
    const parity = Object.fromEntries(Object.entries(normalized).filter(([k]) => k !== 'search-group-metrics' && reference).map(([k, v]) => [k, compareFacetResults(v, reference)]));
    res.json({ query: sq, label: describeQuery(sq), variants: out, parity });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

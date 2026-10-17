import { Document } from 'mongodb';

/**
 * A shopper's query: optional full-text part plus structured filters.
 * The same object is translated into Search operators *and* into a $match,
 * so the Search path and the classic aggregation path answer the identical
 * question (verified by the parity check in the aggregation benchmark).
 */
export type ShopperQuery = {
  q?: string;
  matchCriteria?: 'any' | 'all';
  categories?: string[];
  brands?: string[];
  priceMin?: number;
  priceMax?: number;
  ratingMin?: number;
  inStockOnly?: boolean;
};

export const PRICE_BOUNDARIES = [0, 50, 100, 150, 250, 500, 1_000_000];
export const RATING_BOUNDARIES = [0, 3, 4, 4.5, 5.01];
export const TOP_BRANDS = 10;
export const TEXT_PATHS = ['name', 'description', 'tags'];

export function describeQuery(sq: ShopperQuery): string {
  const parts: string[] = [];
  if (sq.q) parts.push(`"${sq.q}"${sq.matchCriteria === 'all' ? ' (all terms)' : ''}`);
  if (sq.categories?.length) parts.push(`category ∈ {${sq.categories.join(', ')}}`);
  if (sq.brands?.length) parts.push(`brand ∈ {${sq.brands.join(', ')}}`);
  if (sq.priceMin != null || sq.priceMax != null) parts.push(`price ${sq.priceMin ?? 0}–${sq.priceMax ?? '∞'}`);
  if (sq.ratingMin != null) parts.push(`rating ≥ ${sq.ratingMin}`);
  if (sq.inStockOnly) parts.push('in stock');
  return parts.join(', ') || 'all products';
}

// ---------------------------------------------------------------- Search side

function searchFilters(sq: ShopperQuery): Document[] {
  const f: Document[] = [];
  if (sq.categories?.length) f.push({ in: { path: 'category', value: sq.categories } });
  if (sq.brands?.length) f.push({ in: { path: 'brand', value: sq.brands } });
  if (sq.priceMin != null || sq.priceMax != null) {
    f.push({ range: { path: 'price', ...(sq.priceMin != null ? { gte: sq.priceMin } : {}), ...(sq.priceMax != null ? { lte: sq.priceMax } : {}) } });
  }
  if (sq.ratingMin != null) f.push({ range: { path: 'rating', gte: sq.ratingMin } });
  if (sq.inStockOnly) f.push({ range: { path: 'stock', gt: 0 } });
  return f;
}

/** The operator shared by $search and $searchMeta. */
export function searchOperator(sq: ShopperQuery, opts: { boostName?: boolean } = {}): Document {
  const filter = searchFilters(sq);
  const must: Document[] = [];
  const should: Document[] = [];
  if (sq.q) {
    must.push({ text: { query: sq.q, path: TEXT_PATHS, ...(sq.matchCriteria ? { matchCriteria: sq.matchCriteria } : {}) } });
    if (opts.boostName) should.push({ text: { query: sq.q, path: 'name', score: { boost: { value: 3 } } } });
  }
  if (must.length === 0 && filter.length === 0) {
    // "match everything" - every product has a price
    filter.push({ range: { path: 'price', gte: 0 } });
  }
  return { compound: { ...(must.length ? { must } : {}), ...(should.length ? { should } : {}), ...(filter.length ? { filter } : {}) } };
}

/** Part A: ranked product search. */
export function productSearchPipeline(index: string, sq: ShopperQuery, limit = 24): Document[] {
  return [
    { $search: { index, ...searchOperator(sq, { boostName: true }) } },
    { $limit: limit },
    { $project: { name: 1, brand: 1, category: 1, subcategory: 1, price: 1, rating: 1, reviewCount: 1, stock: 1, tags: 1, score: { $meta: 'searchScore' } } },
  ];
}

const metricAggregations = {
  count: { type: 'count' },
  avgPrice: { type: 'avg', path: 'price' },
  minPrice: { type: 'min', path: 'price' },
  maxPrice: { type: 'max', path: 'price' },
  totalStock: { type: 'sum', path: 'stock' },
  avgRating: { type: 'avg', path: 'rating' },
};

/**
 * Part B: facets computed inside the Search engine.
 * withMetrics=true adds per-bucket `aggregations` (avg/min/max/sum), which
 * MongoDB Search documents as a Preview feature ("Accelerated Search
 * Aggregations") - it may be unavailable on a given cluster/mongot.
 */
export function facetMetaPipeline(index: string, sq: ShopperQuery, withMetrics: boolean): Document[] {
  const brand: Document = { type: 'string', path: 'brand', numBuckets: TOP_BRANDS };
  const price: Document = { type: 'number', path: 'price', boundaries: PRICE_BOUNDARIES };
  const rating: Document = { type: 'number', path: 'rating', boundaries: RATING_BOUNDARIES };
  if (withMetrics) {
    brand.aggregations = metricAggregations;
    price.aggregations = { count: { type: 'count' }, avgRating: { type: 'avg', path: 'rating' } };
    rating.aggregations = { count: { type: 'count' } };
  }
  return [
    {
      $searchMeta: {
        index,
        facet: { operator: searchOperator(sq), facets: { brand, price, rating } },
        count: { type: 'total' },
      },
    },
  ];
}

const groupCounts = {
  brand: { count: { $sum: 1 } },
  price: { count: { $sum: 1 } },
};
const groupMetrics = {
  brand: { count: { $sum: 1 }, avgPrice: { $avg: '$price' }, minPrice: { $min: '$price' }, maxPrice: { $max: '$price' }, totalStock: { $sum: '$stock' }, avgRating: { $avg: '$rating' } },
  price: { count: { $sum: 1 }, avgRating: { $avg: '$rating' } },
};

function groupFacetStage(withMetrics: boolean): Document {
  const g = withMetrics ? groupMetrics : groupCounts;
  return {
    $facet: {
      total: [{ $count: 'n' }],
      brand: [{ $group: { _id: '$brand', ...g.brand } }, { $sort: { count: -1, _id: 1 } }, { $limit: TOP_BRANDS }],
      price: [{ $bucket: { groupBy: '$price', boundaries: PRICE_BOUNDARIES, default: 'other', output: g.price } }],
      rating: [{ $bucket: { groupBy: '$rating', boundaries: RATING_BOUNDARIES, default: 'other', output: { count: { $sum: 1 } } } }],
    },
  };
}

/**
 * Part C (1): $search returns every matching document to mongod, which then
 * groups them. With storedSource=true the documents come from the Search
 * index's stored fields instead of a full lookup on mongod.
 */
export function searchThenGroupPipeline(index: string, sq: ShopperQuery, withMetrics: boolean, storedSource: boolean): Document[] {
  return [
    { $search: { index, ...searchOperator(sq), ...(storedSource ? { returnStoredSource: true } : {}) } },
    { $project: { _id: 0, brand: 1, price: 1, rating: 1, stock: 1 } },
    groupFacetStage(withMetrics),
  ];
}

/** Part C (2): no Search at all - B-tree index $match then $group. Structured queries only. */
export function matchThenGroupPipeline(sq: ShopperQuery, withMetrics: boolean): Document[] {
  if (sq.q) throw new Error('matchThenGroup cannot express a full-text query');
  return [{ $match: toMatch(sq) }, { $project: { _id: 0, brand: 1, price: 1, rating: 1, stock: 1 } }, groupFacetStage(withMetrics)];
}

export function toMatch(sq: ShopperQuery): Document {
  const m: Document = {};
  if (sq.categories?.length) m.category = sq.categories.length === 1 ? sq.categories[0] : { $in: sq.categories };
  if (sq.brands?.length) m.brand = sq.brands.length === 1 ? sq.brands[0] : { $in: sq.brands };
  if (sq.priceMin != null || sq.priceMax != null) m.price = { ...(sq.priceMin != null ? { $gte: sq.priceMin } : {}), ...(sq.priceMax != null ? { $lte: sq.priceMax } : {}) };
  if (sq.ratingMin != null) m.rating = { $gte: sq.ratingMin };
  if (sq.inStockOnly) m.stock = { $gt: 0 };
  return m;
}

// ------------------------------------------------------------ result shapes

export type FacetBucket = { key: string | number; count: number; metrics: Record<string, number> };
export type FacetResult = { total: number | null; brand: FacetBucket[]; price: FacetBucket[]; rating: FacetBucket[] };

/**
 * Normalise both result shapes into one structure. The Search side is parsed
 * defensively because the per-bucket `aggregations` output is a Preview
 * feature: metrics may appear on the bucket itself or nested under
 * `aggregations`.
 */
export function normalizeSearchMeta(doc: Document | undefined): FacetResult {
  const total = doc?.count?.total ?? doc?.count?.lowerBound ?? null;
  const facet = doc?.facet ?? {};
  const buckets = (name: string): FacetBucket[] => (facet[name]?.buckets ?? []).map((b: Document) => {
    const metrics: Record<string, number> = {};
    const source = { ...b, ...(b.aggregations ?? {}) };
    for (const [k, v] of Object.entries(source)) {
      if (k === '_id' || k === 'aggregations') continue;
      const n = typeof v === 'number' ? v : typeof v === 'object' && v && 'value' in v ? Number((v as { value: unknown }).value) : Number(v);
      if (Number.isFinite(n)) metrics[k] = n;
    }
    return { key: b._id, count: metrics.count ?? 0, metrics };
  });
  return { total: total == null ? null : Number(total), brand: buckets('brand'), price: buckets('price'), rating: buckets('rating') };
}

export function normalizeGroupFacet(doc: Document | undefined): FacetResult {
  const toBuckets = (xs: Document[] = []) => xs.map((b) => {
    const metrics: Record<string, number> = {};
    for (const [k, v] of Object.entries(b)) if (k !== '_id' && typeof v === 'number') metrics[k] = v;
    return { key: b._id, count: metrics.count ?? 0, metrics };
  });
  // $bucket omits empty buckets while Search facets return them with count 0.
  const fill = (buckets: FacetBucket[], boundaries: number[]) => boundaries.slice(0, -1).map((lo) => buckets.find((b) => b.key === lo) ?? { key: lo, count: 0, metrics: { count: 0 } });
  return {
    total: doc?.total?.[0]?.n ?? 0,
    brand: toBuckets(doc?.brand),
    price: fill(toBuckets(doc?.price), PRICE_BOUNDARIES),
    rating: fill(toBuckets(doc?.rating), RATING_BOUNDARIES),
  };
}

export type ParityReport = { ok: boolean; differences: string[] };

/**
 * Do two facet results answer the same question? Counts must be exact.
 * Floating point metrics may differ in the last digits (different summation
 * order), so they're compared with a relative tolerance. Brand buckets are
 * compared as maps so ties at the top-N boundary don't cause false alarms.
 */
export function compareFacetResults(a: FacetResult, b: FacetResult, tolerance = 1e-6): ParityReport {
  const diffs: string[] = [];
  if (a.total !== null && b.total !== null && a.total !== b.total) diffs.push(`total ${a.total} vs ${b.total}`);
  for (const dim of ['brand', 'price', 'rating'] as const) {
    const bm = new Map(b[dim].map((x) => [String(x.key), x]));
    const lastCount = Math.min(...a[dim].map((x) => x.count), ...b[dim].map((x) => x.count));
    for (const x of a[dim]) {
      const y = bm.get(String(x.key));
      if (!y) {
        if (!(dim === 'brand' && x.count <= lastCount)) diffs.push(`${dim}[${x.key}] missing on one side`);
        continue;
      }
      if (x.count !== y.count) diffs.push(`${dim}[${x.key}].count ${x.count} vs ${y.count}`);
      for (const [k, v] of Object.entries(x.metrics)) {
        const w = y.metrics[k];
        if (w === undefined) continue;
        if (Math.abs(v - w) > tolerance * Math.max(1, Math.abs(v), Math.abs(w))) diffs.push(`${dim}[${x.key}].${k} ${v} vs ${w}`);
      }
    }
  }
  return { ok: diffs.length === 0, differences: diffs.slice(0, 20) };
}

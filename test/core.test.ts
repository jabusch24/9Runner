import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MongoServerError } from 'mongodb';
import { expectedCount, parseSchedule, rpsAt } from '../src/iwm/schedule.js';
import { parseMix } from '../src/iwm/operations.js';
import { compareFacetResults, facetMetaPipeline, normalizeGroupFacet, normalizeSearchMeta, searchOperator, toMatch } from '../src/search/queries.js';
import { generateProduct, popularityRankOf } from '../src/seed/generate.js';
import { classifyError } from '../src/utils/mongo.js';
import { Rng, Zipf, scatter } from '../src/utils/random.js';
import { Histogram, compareMedians, percentile } from '../src/utils/stats.js';

test('histogram percentiles are within ~2% of exact values', () => {
  const h = new Histogram();
  const xs: number[] = [];
  const rng = new Rng('h');
  for (let i = 0; i < 20_000; i++) {
    const v = rng.logNormal(20, 1);
    xs.push(v);
    h.record(v);
  }
  xs.sort((a, b) => a - b);
  for (const p of [50, 95, 99]) {
    const exact = percentile(xs, p);
    assert.ok(Math.abs(h.percentile(p) - exact) / exact < 0.02, `p${p}: ${h.percentile(p)} vs ${exact}`);
  }
});

test('histograms merge through serialization', () => {
  const a = new Histogram();
  const b = new Histogram();
  [1, 2, 3].forEach((v) => a.record(v));
  [100, 200].forEach((v) => b.record(v));
  const m = Histogram.from(a.serialize());
  m.merge(b.serialize());
  assert.equal(m.total, 5);
  assert.equal(m.max, 200);
  assert.equal(m.min, 1);
});

test('seeded generation is deterministic and order-independent', () => {
  assert.deepEqual(generateProduct(1234, 's', 10_000), generateProduct(1234, 's', 10_000));
  assert.notDeepEqual(generateProduct(1234, 's', 10_000).name, generateProduct(1234, 't', 10_000).name);
});

test('scatter and popularityRankOf are inverse permutations', () => {
  const n = 50_000;
  for (const rank of [0, 1, 17, 4_999, 49_999]) assert.equal(popularityRankOf(scatter(rank, n), n), rank);
});

test('zipf favours low ranks', () => {
  const z = new Zipf(10_000, 1.0);
  const rng = new Rng('z');
  let top100 = 0;
  for (let i = 0; i < 10_000; i++) if (z.sample(rng) < 100) top100++;
  assert.ok(top100 > 4_000, `top 1% got ${top100}/10000`);
});

test('schedule integral matches piecewise-linear rate', () => {
  const s = parseSchedule('baseline:10:100,ramp:10:100-300,overload:5:300,recovery:5:100');
  assert.equal(s.totalSec, 30);
  assert.equal(s.overloadStartSec, 20);
  assert.equal(rpsAt(s, 15), 200);
  assert.equal(expectedCount(s, 10), 1000);
  assert.equal(expectedCount(s, 20), 1000 + 2000);
  assert.equal(expectedCount(s, 30), 3000 + 1500 + 500);
  assert.throws(() => parseSchedule('bad'));
});

test('workload mix drops search when no index exists', () => {
  const m = parseMix('product-page:50,search:50', false);
  assert.deepEqual(m.classes, ['product-page']);
  assert.throws(() => parseMix('nope:1', true));
});

test('overload errors are classified as rejections by label or code', () => {
  const labelled = new MongoServerError({ code: 462, codeName: 'IngressRequestRateLimitExceeded', errmsg: 'rejected', errorLabels: ['SystemOverloadedError', 'RetryableError'] });
  assert.equal(classifyError(labelled).kind, 'rejected');
  const atlas = new MongoServerError({ code: 463, codeName: 'IngressOperationRateLimitExceeded', errmsg: 'x' });
  assert.equal(classifyError(atlas).kind, 'rejected');
  const maxTime = new MongoServerError({ code: 50, codeName: 'MaxTimeMSExpired', errmsg: 'x' });
  assert.equal(classifyError(maxTime).kind, 'timeout');
  assert.equal(classifyError(new MongoServerError({ code: 11000, errmsg: 'dup' })).kind, 'error');
});

test('one shopper query becomes equivalent $search and $match filters', () => {
  const sq = { categories: ['Running Shoes'], priceMin: 50, priceMax: 100, inStockOnly: true };
  assert.deepEqual(toMatch(sq), { category: 'Running Shoes', price: { $gte: 50, $lte: 100 }, stock: { $gt: 0 } });
  const op = searchOperator(sq);
  assert.equal(op.compound.filter.length, 3);
  const meta = facetMetaPipeline('idx', sq, true)[0].$searchMeta;
  assert.equal(meta.count.type, 'total');
  assert.ok(meta.facet.facets.brand.aggregations.avgPrice);
});

test('facet results from both paths normalise and compare', () => {
  const search = normalizeSearchMeta({
    count: { total: 3 },
    facet: {
      brand: { buckets: [{ _id: 'Nike', count: 2, avgPrice: 10 }, { _id: 'Asics', count: 1, aggregations: { avgPrice: 20 } }] },
      price: { buckets: [{ _id: 0, count: 3 }, { _id: 50, count: 0 }] },
      rating: { buckets: [] },
    },
  });
  assert.equal(search.brand[1].metrics.avgPrice, 20);
  const group = normalizeGroupFacet({ total: [{ n: 3 }], brand: [{ _id: 'Nike', count: 2, avgPrice: 10 }, { _id: 'Asics', count: 1, avgPrice: 20.0000000001 }], price: [{ _id: 0, count: 3 }], rating: [] });
  // $bucket omits empty buckets; normalisation fills them so the comparison is fair
  assert.equal(group.price.length, 6);
  const sameShape = { ...search, price: group.price, rating: group.rating };
  assert.equal(compareFacetResults(sameShape, group).ok, true);
  const wrong = { ...group, total: 4 };
  assert.equal(compareFacetResults(sameShape, wrong).ok, false);
});

test('compareMedians says "similar" for noise and detects real gaps', () => {
  const rng = new Rng('c');
  const a = Array.from({ length: 100 }, () => rng.normal(100, 5));
  const b = Array.from({ length: 100 }, () => rng.normal(101, 5));
  const c = Array.from({ length: 100 }, () => rng.normal(50, 5));
  assert.equal(compareMedians('a', a, 'b', b).verdict, 'similar');
  assert.equal(compareMedians('a', a, 'c', c).verdict, 'faster');
});

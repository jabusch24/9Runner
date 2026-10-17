import { Db, Document } from 'mongodb';
import { CATEGORIES, SEARCH_TERMS } from '../seed/catalog.js';
import { Rng, WeightedPicker, Zipf, scatter } from '../utils/random.js';

/**
 * Operation classes of an online store. "critical" classes are what a shopper
 * waits on; "heavy" classes are the reports and badly-written queries that
 * cause overload in real life. IWM's claim is about protecting the former
 * from the latter, so every metric is also reported per class.
 */
export const OP_CLASSES = {
  'product-page': { critical: true, description: 'findOne by _id (Zipf-popular products)' },
  'category-listing': { critical: true, description: 'category + price range, sorted by rating, limit 24 (indexed)' },
  'search': { critical: true, description: '$search full-text top 20 (requires Search index)' },
  'checkout': { critical: true, description: 'insert order' },
  'inventory': { critical: true, description: 'updateOne $inc stock (hot products)' },
  'analytics': { critical: false, description: 'indexed $match + $group brand stats for a category' },
  'heavy-report': { critical: false, description: 'unindexed scans: review sentiment report, regex over descriptions, $lookup' },
} as const;

export type OpClass = keyof typeof OP_CLASSES;
export const OP_CLASS_NAMES = Object.keys(OP_CLASSES) as OpClass[];

export const DEFAULT_MIX = 'product-page:40,category-listing:20,search:8,checkout:8,inventory:10,analytics:6,heavy-report:8';

export function parseMix(spec: string, searchAvailable: boolean): { classes: OpClass[]; weights: number[]; normalized: Record<string, number> } {
  const classes: OpClass[] = [];
  const weights: number[] = [];
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, w] = part.split(':');
    if (!(name in OP_CLASSES)) throw new Error(`Unknown op class "${name}" in WORKLOAD_MIX. Known: ${OP_CLASS_NAMES.join(', ')}`);
    if (name === 'search' && !searchAvailable) continue;
    const weight = Number(w);
    if (weight > 0) {
      classes.push(name as OpClass);
      weights.push(weight);
    }
  }
  const total = weights.reduce((a, b) => a + b, 0);
  const normalized = Object.fromEntries(classes.map((c, i) => [c, Math.round((weights[i] / total) * 1000) / 10]));
  return { classes, weights, normalized };
}

export type OpContext = {
  db: Db;
  rng: Rng;
  productCount: number;
  reviewCount: number;
  searchIndex: string;
};

const termPicker = new WeightedPicker(SEARCH_TERMS.map((t) => t[0]), SEARCH_TERMS.map((t) => t[1]));
const categoryPicker = new WeightedPicker(CATEGORIES.map((c) => c.name), CATEGORIES.map((c) => c.weight));
const REGEXES = ['carbon fiber plate.*night', 'recycled down.*hood', 'noise cancell.*multipoint', 'organic cotton.*quick', 'gore-tex.*vibram'];
const DAY = 86_400_000;
const EPOCH = Date.UTC(2026, 8, 1);

/**
 * Each operation receives its remaining time budget and passes it to the
 * driver as `timeoutMS` (client-side operation timeout). Unlike a plain
 * maxTimeMS this also cancels requests still waiting for a pooled
 * connection, so requests the shopper already gave up on are not sent to the
 * server seconds later.
 */
export function makeOperations(ctx: OpContext): Record<OpClass, (timeoutMS: number) => Promise<unknown>> {
  const { db, rng, productCount } = ctx;
  const products = db.collection('products');
  const reviews = db.collection('reviews');
  const orders = db.collection('orders');
  const popular = new Zipf(productCount, 1.0);
  const productId = () => scatter(popular.sample(rng), productCount);

  return {
    'product-page': (timeoutMS) => products.findOne({ _id: productId() } as Document, { projection: { description: 0 }, timeoutMS }),

    'category-listing': (timeoutMS) => {
      const lo = rng.pick([0, 25, 50, 100, 150]);
      return products
        .find({ category: categoryPicker.pick(rng), price: { $gte: lo, $lte: lo + rng.pick([50, 100, 250]) } }, { projection: { name: 1, price: 1, rating: 1, brand: 1 }, timeoutMS })
        .sort({ price: 1 })
        .limit(24)
        .toArray();
    },

    search: (timeoutMS) => products.aggregate([
      { $search: { index: ctx.searchIndex, text: { query: termPicker.pick(rng), path: ['name', 'description', 'tags'] } } },
      { $limit: 20 },
      { $project: { name: 1, price: 1, rating: 1 } },
    ], { timeoutMS }).toArray(),

    checkout: (timeoutMS) => {
      const n = rng.int(1, 3);
      const items = Array.from({ length: n }, () => ({ productId: productId(), qty: 1, price: Math.round(rng.logNormal(80, 0.6) * 100) / 100 }));
      return orders.insertOne({
        customerId: rng.int(1, 250_000),
        status: 'processing',
        items,
        total: Math.round(items.reduce((a, i) => a + i.price, 0) * 100) / 100,
        currency: 'EUR',
        createdAt: new Date(),
        source: 'load-test',
      }, { timeoutMS });
    },

    inventory: (timeoutMS) => products.updateOne({ _id: productId() } as Document, { $inc: { stock: rng.chance(0.8) ? -1 : 5 }, $set: { updatedAt: new Date() } }, { timeoutMS }),

    analytics: (timeoutMS) => products.aggregate([
      { $match: { category: categoryPicker.pick(rng) } },
      { $group: { _id: '$brand', products: { $sum: 1 }, avgPrice: { $avg: '$price' }, avgRating: { $avg: '$rating' }, stock: { $sum: '$stock' } } },
      { $sort: { products: -1 } },
    ], { timeoutMS }).toArray(),

    'heavy-report': (timeoutMS) => {
      const kind = rng.int(0, 2);
      if (kind === 0) {
        // Review sentiment over a date window: there is no index on createdAt alone -> collection scan of reviews.
        const since = new Date(EPOCH - rng.int(30, 365) * DAY);
        return reviews.aggregate([
          { $match: { createdAt: { $gte: since }, rating: { $lte: rng.int(2, 3) } } },
          { $group: { _id: '$productId', complaints: { $sum: 1 }, helpful: { $sum: '$helpfulVotes' } } },
          { $sort: { complaints: -1 } },
          { $limit: 20 },
        ], { timeoutMS, allowDiskUse: true }).toArray();
      }
      if (kind === 1) {
        // Unanchored case-insensitive regex over descriptions: collection scan of products.
        return products.find({ description: { $regex: rng.pick(REGEXES), $options: 'i' } }, { projection: { name: 1 }, timeoutMS }).limit(50).toArray();
      }
      // Join a category's top products to their reviews.
      return products.aggregate([
        { $match: { category: categoryPicker.pick(rng) } },
        { $sort: { reviewCount: -1 } },
        { $limit: 200 },
        { $lookup: { from: 'reviews', localField: '_id', foreignField: 'productId', as: 'r', pipeline: [{ $project: { rating: 1 } }] } },
        { $project: { name: 1, n: { $size: '$r' }, avg: { $avg: '$r.rating' } } },
        { $sort: { avg: 1 } },
        { $limit: 20 },
      ], { timeoutMS }).toArray();
    },
  };
}

/** Reads are safe to retry; writes only when the server says nothing was written. */
export const READ_CLASSES = new Set<OpClass>(['product-page', 'category-listing', 'search', 'analytics', 'heavy-report']);

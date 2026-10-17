import { Db } from 'mongodb';
import { DemoEnvironment } from '../config/environments.js';
import { settings } from '../config/settings.js';
import { ensureSearchIndex } from '../search/indexDefinition.js';
import { getDb } from '../utils/mongo.js';
import { Zipf } from '../utils/random.js';
import { generateOrder, generateProduct, generateReview } from './generate.js';

export type DatasetMeta = {
  _id: 'dataset';
  seed: string;
  productCount: number;
  reviewCount: number;
  orderCount: number;
  generatorVersion: number;
  seededAt: Date;
};

// Bump when generate.ts changes in a way that alters documents.
export const GENERATOR_VERSION = 1;

type Log = (m: string) => void;

export async function seedEnvironment(env: DemoEnvironment, log: Log, opts: { skipSearchIndex?: boolean } = {}) {
  const db = await getDb(env, 'seed');
  const { seed, productCount, reviewCount, orderCount } = settings;
  log(`[${env.id}] seeding ${productCount.toLocaleString()} products, ${reviewCount.toLocaleString()} reviews, ${orderCount.toLocaleString()} orders (seed "${seed}")`);

  const existing = await db.collection<DatasetMeta>('meta').findOne({ _id: 'dataset' });
  if (existing && existing.seed === seed && existing.productCount === productCount && existing.reviewCount === reviewCount
      && existing.orderCount === orderCount && existing.generatorVersion === GENERATOR_VERSION && process.env.SEED_FORCE !== 'true') {
    log(`[${env.id}] dataset already present with identical parameters - skipping (SEED_FORCE=true to reseed)`);
  } else {
    await Promise.all(['products', 'reviews', 'orders', 'meta'].map((c) => db.collection(c).drop().catch(() => undefined)));
    const productZipf = new Zipf(productCount, 1.0);
    await insertGenerated(db, 'products', productCount, (i) => generateProduct(i, seed, productCount), log, env.id);
    await insertGenerated(db, 'reviews', reviewCount, (i) => generateReview(i, seed, productCount, productZipf), log, env.id);
    await insertGenerated(db, 'orders', orderCount, (i) => generateOrder(i, seed, productCount, productZipf), log, env.id);
    await db.collection<DatasetMeta>('meta').insertOne({
      _id: 'dataset', seed, productCount, reviewCount, orderCount, generatorVersion: GENERATOR_VERSION, seededAt: new Date(),
    });
  }

  log(`[${env.id}] creating B-tree indexes`);
  await createIndexes(db);

  if (!opts.skipSearchIndex) {
    try {
      await ensureSearchIndex(db.collection('products'), settings.searchIndexName, (m) => log(`[${env.id}] ${m}`));
    } catch (e) {
      log(`[${env.id}] WARNING: ${(e as Error).message}. Search benchmarks will be skipped for this environment.`);
    }
  }
  log(`[${env.id}] seed complete`);
}

/**
 * Indexes used by the workload. Note what is deliberately NOT indexed:
 * reviews by rating/date for the analytics report and product descriptions,
 * so the "expensive" operations are genuinely expensive collection scans.
 */
export async function createIndexes(db: Db) {
  await db.collection('products').createIndexes([
    { key: { category: 1, price: 1 } },
    { key: { category: 1, rating: -1 } },
    { key: { brand: 1, category: 1 } },
    { key: { tags: 1 } },
    { key: { popularityRank: 1 } },
  ]);
  await db.collection('reviews').createIndexes([{ key: { productId: 1, createdAt: -1 } }]);
  await db.collection('orders').createIndexes([{ key: { customerId: 1, createdAt: -1 } }]);
}

async function insertGenerated(db: Db, name: string, count: number, make: (i: number) => object, log: Log, envId: string) {
  const coll = db.collection(name);
  const batchSize = settings.seedBatchSize;
  const batches = Math.ceil(count / batchSize);
  let next = 0;
  let done = 0;
  const started = Date.now();
  let lastLog = 0;
  const worker = async () => {
    for (;;) {
      const b = next++;
      if (b >= batches) return;
      const docs = [];
      for (let i = b * batchSize; i < Math.min(count, (b + 1) * batchSize); i++) docs.push(make(i));
      await coll.insertMany(docs, { ordered: false });
      done += docs.length;
      if (Date.now() - lastLog > 3_000 || done === count) {
        lastLog = Date.now();
        const rate = Math.round(done / ((Date.now() - started) / 1000));
        log(`[${envId}] ${name}: ${done.toLocaleString()}/${count.toLocaleString()} (${rate.toLocaleString()} docs/s)`);
      }
    }
  };
  await Promise.all(Array.from({ length: settings.seedConcurrency }, worker));
}

export async function readDatasetMeta(db: Db): Promise<DatasetMeta | null> {
  return db.collection<DatasetMeta>('meta').findOne({ _id: 'dataset' });
}

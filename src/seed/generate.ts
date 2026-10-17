import { Rng, WeightedPicker, Zipf, scatter } from '../utils/random.js';
import { BRAND_TRAITS, CATEGORIES, COLORS, CategorySpec, GENERIC_PHRASES, REVIEW_PHRASES } from './catalog.js';

export type Product = {
  _id: number;
  sku: string;
  name: string;
  description: string;
  brand: string;
  category: string;
  subcategory: string;
  department: string;
  price: number;
  rating: number;
  reviewCount: number;
  popularityRank: number;
  color: string;
  size: string[];
  gender: string;
  stock: number;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  attributes: Record<string, unknown>;
};

export type Review = {
  _id: number;
  productId: number;
  userId: number;
  rating: number;
  title: string;
  body: string;
  verifiedPurchase: boolean;
  helpfulVotes: number;
  createdAt: Date;
};

export type Order = {
  _id: number;
  customerId: number;
  status: string;
  items: { productId: number; qty: number; price: number }[];
  total: number;
  currency: string;
  createdAt: Date;
};

const categoryPicker = new WeightedPicker(CATEGORIES, CATEGORIES.map((c) => c.weight));
const colorPicker = new WeightedPicker(COLORS.map((c) => c[0]), COLORS.map((c) => c[1]));
const brandPickers = new Map<string, WeightedPicker<string>>(
  CATEGORIES.map((c) => [c.name, new WeightedPicker(c.brands.map((b) => b[0]), c.brands.map((b) => b[1]))]),
);
const genderPickers = new Map<string, WeightedPicker<string>>(
  CATEGORIES.map((c) => {
    const g = c.genders ?? [['Unisex', 1]];
    return [c.name, new WeightedPicker(g.map((x) => x[0]), g.map((x) => x[1]))];
  }),
);

// Dates are anchored to a fixed epoch, not "now", so re-seeding next week yields identical data.
const EPOCH = Date.UTC(2026, 8, 1);
const DAY = 86_400_000;

/**
 * Generate product `id` deterministically. Each product has its own RNG stream
 * so reviews can regenerate a product's attributes without reading it back.
 */
export function generateProduct(id: number, seed: string, productCount: number): Product {
  const rng = new Rng(`${seed}:product:${id}`);
  const cat = categoryPicker.pick(rng);
  const brand = brandPickers.get(cat.name)!.pick(rng);
  const traits = BRAND_TRAITS[brand] ?? { quality: 0, premium: 1 };
  const subcategory = rng.pick(cat.subcategories);
  // Each brand owns a few model lines of its category, so "On Adizero" doesn't happen.
  const brandIdx = cat.brands.findIndex((b) => b[0] === brand);
  const model = cat.models[(brandIdx * 2 + rng.int(0, 1)) % cat.models.length];
  const series = rng.int(1, 45);
  const variant = rng.chance(0.25) ? ` ${rng.pick(['Pro', 'Lite', 'GTX', 'Max', 'Plus', 'SE', 'Elite'])}` : '';
  const name = `${brand} ${model}${variant} ${series} ${cat.noun}`;

  const rank = popularityRankOf(id, productCount);
  // Popular products get more reviews: reviewCount falls off with rank, plus noise.
  const reviewCount = Math.max(0, Math.round(rng.logNormal(4000 / Math.pow(rank + 1, 0.55), 0.6)));

  const ratingMean = 4.15 + traits.quality + (rng.chance(0.07) ? -1.4 : 0);
  const rating = clamp(round1(rng.normal(ratingMean, 0.38)), 1, 5);

  const price = toPrice(rng.logNormal(cat.priceMedian * traits.premium, cat.priceSigma));
  const stockBucket = rng.next();
  const stock = stockBucket < 0.08 ? 0 : stockBucket < 0.38 ? rng.int(1, 10) : stockBucket < 0.88 ? rng.int(10, 200) : rng.int(200, 5000);

  const features = rng.pickMany(cat.features, rng.int(2, 3));
  const description = [
    `The ${name} is a ${subcategory.toLowerCase()} ${cat.noun.toLowerCase()} from ${brand}.`,
    `Features ${features.join(', ')}.`,
    rng.pick(GENERIC_PHRASES),
    rng.chance(0.3) ? rng.pick(GENERIC_PHRASES) : '',
  ].filter(Boolean).join(' ');

  const tags = Array.from(new Set([...rng.pickMany(cat.tags, rng.int(2, 4)), subcategory.toLowerCase()]));
  const sizes = cat.sizes ? cat.sizes.filter(() => rng.chance(0.6)) : [];
  const createdAt = new Date(EPOCH - Math.floor(Math.pow(rng.next(), 1.6) * 3 * 365) * DAY);

  return {
    _id: id,
    sku: `SKU-${String(id).padStart(8, '0')}`,
    name,
    description,
    brand,
    category: cat.name,
    subcategory,
    department: cat.department,
    price,
    rating,
    reviewCount,
    popularityRank: rank,
    color: colorPicker.pick(rng),
    size: sizes,
    gender: genderPickers.get(cat.name)!.pick(rng),
    stock,
    tags,
    createdAt,
    updatedAt: createdAt,
    attributes: cat.attributes(() => rng.next()),
  };
}

export function generateReview(id: number, seed: string, productCount: number, productZipf: Zipf): Review {
  const rng = new Rng(`${seed}:review:${id}`);
  const productId = scatter(productZipf.sample(rng), productCount);
  const product = generateProduct(productId, seed, productCount);
  const rating = clamp(Math.round(rng.normal(product.rating, 0.9)), 1, 5);
  const tone = rating >= 4 ? REVIEW_PHRASES.good : rating === 3 ? REVIEW_PHRASES.mixed : REVIEW_PHRASES.bad;
  const title = rng.pick(tone);
  const body = `${title}. ${rating >= 4 ? 'The' : 'This'} ${product.category.toLowerCase()} from ${product.brand} ${rating >= 4 ? 'is great for' : 'was not ideal for'} ${rng.pick(product.tags)}. ${rng.pick(tone)}.`;
  return {
    _id: id,
    productId,
    userId: rng.int(1, 1_000_000),
    rating,
    title,
    body,
    verifiedPurchase: rng.chance(0.78),
    helpfulVotes: Math.floor(rng.logNormal(1, 1.4)),
    createdAt: new Date(EPOCH - Math.floor(Math.pow(rng.next(), 2) * 2 * 365 * DAY)),
  };
}

export function generateOrder(id: number, seed: string, productCount: number, productZipf: Zipf): Order {
  const rng = new Rng(`${seed}:order:${id}`);
  const n = rng.int(1, 4);
  const items = Array.from({ length: n }, () => {
    const productId = scatter(productZipf.sample(rng), productCount);
    // Price is regenerated cheaply from the product stream rather than read back.
    const price = generateProduct(productId, seed, productCount).price;
    return { productId, qty: rng.chance(0.85) ? 1 : rng.int(2, 3), price };
  });
  return {
    _id: id,
    customerId: rng.int(1, 250_000),
    status: rng.pick(['delivered', 'delivered', 'delivered', 'shipped', 'processing', 'returned']),
    items,
    total: Math.round(items.reduce((a, i) => a + i.price * i.qty, 0) * 100) / 100,
    currency: 'EUR',
    createdAt: new Date(EPOCH - Math.floor(Math.pow(rng.next(), 1.5) * 365 * DAY)),
  };
}

/** Inverse of `scatter`: product id -> popularity rank (0 = most popular). */
export function popularityRankOf(id: number, n: number): number {
  const k = 2654435761n;
  const N = BigInt(n);
  if (gcd(k, N) !== 1n) return id;
  return Number((BigInt(id) * modInverse(k % N, N)) % N);
}

function modInverse(a: bigint, m: bigint): bigint {
  let [oldR, r] = [a, m];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b];
  return a;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;
function toPrice(v: number): number {
  const p = Math.max(4.99, v);
  return p < 20 ? Math.floor(p) + 0.99 : p < 200 ? Math.round(p / 5) * 5 - 0.01 : Math.round(p / 10) * 10 - 0.01;
}

export function categoryByName(name: string): CategorySpec | undefined {
  return CATEGORIES.find((c) => c.name === name);
}

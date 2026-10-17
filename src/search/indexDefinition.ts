import crypto from 'node:crypto';
import { Collection, Document } from 'mongodb';

/**
 * One Search index serves the whole demo.
 *
 * - name/description/tags: full-text (lucene.english) for relevance search
 * - brand/category/subcategory/color/gender: `token` so they can be facet
 *   dimensions and exact-match filters
 * - price/rating/stock/reviewCount: `number` for range filters, numeric facets
 *   and the per-bucket facet aggregations (avg/min/max/sum)
 * - storedSource: lets the "$search + $group" variant use returnStoredSource
 *   and skip the full document lookup on mongod, which isolates how much of
 *   the cost is document materialization
 */
export const PRODUCT_SEARCH_INDEX = {
  mappings: {
    dynamic: false,
    fields: {
      name: [{ type: 'string', analyzer: 'lucene.english' }, { type: 'autocomplete', tokenization: 'edgeGram', minGrams: 2, maxGrams: 12 }],
      description: { type: 'string', analyzer: 'lucene.english' },
      tags: [{ type: 'string', analyzer: 'lucene.english' }, { type: 'token' }],
      brand: [{ type: 'token' }, { type: 'string' }],
      category: [{ type: 'token' }, { type: 'string' }],
      subcategory: { type: 'token' },
      department: { type: 'token' },
      color: { type: 'token' },
      gender: { type: 'token' },
      price: { type: 'number' },
      rating: { type: 'number' },
      reviewCount: { type: 'number' },
      stock: { type: 'number' },
      createdAt: { type: 'date' },
    },
  },
  storedSource: {
    include: ['brand', 'category', 'price', 'rating', 'stock'],
  },
} as const;

export function indexDefinitionHash(def: unknown = fieldSignature(PRODUCT_SEARCH_INDEX)): string {
  return crypto.createHash('sha256').update(typeof def === 'string' ? def : JSON.stringify(def)).digest('hex').slice(0, 12);
}

/**
 * Atlas normalises stored definitions (adds defaults, reorders keys), so we
 * compare a signature of "field -> sorted mapping types" plus storedSource.
 */
export function fieldSignature(def: any): string {
  const fields = def?.mappings?.fields ?? {};
  const sig = Object.keys(fields).sort().map((k) => {
    const types = (Array.isArray(fields[k]) ? fields[k] : [fields[k]]).map((f: any) => f?.type).sort();
    return `${k}:${types.join('+')}`;
  });
  const stored = (def?.storedSource?.include ?? []).slice().sort().join(',');
  return `${sig.join('|')}#${stored}`;
}

export type SearchIndexStatus = {
  name: string;
  exists: boolean;
  status?: string;
  queryable?: boolean;
  definitionHash?: string;
  matchesExpected?: boolean;
  error?: string;
};

export async function getSearchIndexStatus(coll: Collection<Document>, name: string): Promise<SearchIndexStatus> {
  try {
    const [idx] = (await coll.listSearchIndexes(name).toArray()) as Document[];
    if (!idx) return { name, exists: false };
    return {
      name,
      exists: true,
      status: idx.status,
      queryable: idx.queryable,
      definitionHash: indexDefinitionHash(fieldSignature(idx.latestDefinition)),
      matchesExpected: fieldSignature(idx.latestDefinition) === fieldSignature(PRODUCT_SEARCH_INDEX),
    };
  } catch (e) {
    return { name, exists: false, error: (e as Error).message };
  }
}

/** Create or update the index, then wait until it is queryable. */
export async function ensureSearchIndex(coll: Collection<Document>, name: string, log: (m: string) => void, timeoutMs = 30 * 60_000) {
  const current = await getSearchIndexStatus(coll, name);
  if (current.error && /not supported|CommandNotFound|SearchNotEnabled|Atlas/i.test(current.error)) {
    throw new Error(`Search is not available on this deployment: ${current.error}`);
  }
  if (!current.exists) {
    log(`creating search index "${name}"`);
    await coll.createSearchIndex({ name, definition: PRODUCT_SEARCH_INDEX as unknown as Document });
  } else if (!current.matchesExpected) {
    log(`updating search index "${name}" (definition changed)`);
    await coll.updateSearchIndex(name, PRODUCT_SEARCH_INDEX as unknown as Document);
  } else {
    log(`search index "${name}" already up to date (${current.status})`);
  }
  const started = Date.now();
  let lastStatus = '';
  for (;;) {
    const s = await getSearchIndexStatus(coll, name);
    if (s.status !== lastStatus) {
      log(`search index status: ${s.status}${s.queryable ? ' (queryable)' : ''}`);
      lastStatus = s.status ?? '';
    }
    if (s.queryable && s.status === 'READY' && s.matchesExpected) return s;
    if (s.status === 'FAILED') throw new Error(`Search index build failed: ${JSON.stringify(s)}`);
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for search index (last status ${s.status})`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

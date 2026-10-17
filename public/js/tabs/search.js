import { api, fmt, h, state } from '../app.js';
import { bulletCallout, jobPanel, loadResult, resultHeader, serverBadge, table } from '../components.js';

/** Part A: an interactive storefront search + the search benchmark results. */
export default {
  id: 'search',
  title: 'Search Demo',
  render(el) {
    const envs = state.overview?.environments ?? [];
    const envSelect = h('select', {}, envs.map((e) => h('option', { value: e.id }, e.name)));
    const q = h('input', { value: 'running shoes', placeholder: 'search products' });
    const brands = h('input', { placeholder: 'Nike,Asics', size: 14 });
    const category = h('input', { placeholder: 'Running Shoes', size: 14 });
    const priceMin = h('input', { type: 'number', size: 5, placeholder: 'min €' });
    const priceMax = h('input', { type: 'number', size: 5, placeholder: 'max €' });
    const rating = h('select', {}, ['', '3', '4', '4.5'].map((r) => h('option', { value: r }, r ? `${r}+ ★` : 'any rating')));
    const go = h('button', { type: 'submit' }, 'Search');
    const out = h('div', { class: 'section' });

    const form = h('form', { class: 'controls' },
      h('label', {}, 'Environment', envSelect),
      h('label', { class: 'grow' }, 'Query', q),
      h('label', {}, 'Category', category),
      h('label', {}, 'Brands', brands),
      h('label', {}, 'Price', h('span', {}, priceMin, ' – ', priceMax)),
      h('label', {}, 'Rating', rating),
      go,
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const params = new URLSearchParams({ env: envSelect.value, q: q.value, brands: brands.value, categories: category.value, priceMin: priceMin.value, priceMax: priceMax.value, ratingMin: rating.value });
      out.replaceChildren(h('p', { class: 'muted' }, 'Searching…'));
      try {
        out.replaceChildren(renderSearch(await api.get(`/api/search/search?${params}`)));
      } catch (e) {
        out.replaceChildren(h('div', { class: 'callout bad' }, e.message));
      }
    });

    const results = h('div', {});
    const show = async () => results.replaceChildren(renderBenchmark(await loadResult('search')));
    el.append(
      h('div', { class: 'card' }, h('h2', {}, 'Storefront search'), h('p', { class: 'muted' }, 'Full-text over name, description and tags with category/brand/price/rating filters, ranked by Lucene relevance (name matches boosted). Facet counts come from the same Search index in a parallel $searchMeta.'), form, out),
      jobPanel({ benchmark: 'search', fields: [{ key: 'MEASURED_ITERATIONS', label: 'Iterations', value: '100' }, { key: 'WARMUP_ITERATIONS', label: 'Warm-up', value: '10' }, { key: 'BENCH_CONCURRENCY', label: 'Throughput concurrency', value: '4' }], onDone: show }),
      results,
    );
    show();
    if (envs.length) form.requestSubmit();
  },
};

function renderSearch(r) {
  const facets = r.facets.value;
  const res = r.results;
  return h('div', {},
    h('div', { class: 'kpis' },
      kpi(facets ? fmt.n(facets.total) : '–', 'matching products'),
      kpi(fmt.ms(res.ms), '$search top 24 (round trip)'),
      kpi(fmt.ms(r.facets.ms), '$searchMeta facets (round trip)'),
    ),
    res.error ? h('div', { class: 'callout bad' }, res.error) : null,
    h('div', { class: 'facet-layout section' },
      h('div', {}, facets ? facetPanel(facets) : h('div', { class: 'callout bad' }, r.facets.error)),
      h('div', {}, (res.value ?? []).map((p) => h('div', { class: 'product' },
        h('div', { class: 'name' }, p.name),
        h('div', { class: 'meta' }, `${p.brand} · ${p.category} / ${p.subcategory} · ${fmt.money(p.price)} · ${p.rating}★ (${fmt.n(p.reviewCount)}) · stock ${p.stock} · score ${p.score?.toFixed(2)}`),
      ))),
    ),
    h('details', {}, h('summary', {}, 'Pipelines sent to MongoDB'), h('pre', {}, JSON.stringify(r.pipelines, null, 2))),
  );
}

export function kpi(v, l) {
  return h('div', { class: 'kpi' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
}

const PRICE_LABEL = { 0: '< €50', 50: '€50–100', 100: '€100–150', 150: '€150–250', 250: '€250–500', 500: '€500+' };
const RATING_LABEL = { 0: '< 3 ★', 3: '3–4 ★', 4: '4–4.5 ★', 4.5: '4.5+ ★' };

/** The left-hand filter panel. Rating facets are disjoint buckets; "4+ stars" is shown cumulatively, like a shop would. */
export function facetPanel(f, { metrics = false } = {}) {
  const row = (label, b) => h('div', { class: 'facet-row' },
    h('span', {}, label, metrics && b.metrics?.avgPrice != null ? h('span', { class: 'metric' }, ` · avg ${fmt.money(b.metrics.avgPrice)}, ${fmt.money(b.metrics.minPrice)}–${fmt.money(b.metrics.maxPrice)}`) : null),
    h('span', { class: 'count' }, fmt.n(b.count)));
  const ratingCum = (min) => f.rating.filter((b) => Number(b.key) >= min).reduce((a, b) => a + b.count, 0);
  return h('div', { class: 'facet-group' },
    h('h4', {}, 'Brand'), f.brand.map((b) => row(b.key, b)),
    h('h4', {}, 'Price'), f.price.map((b) => row(PRICE_LABEL[b.key] ?? b.key, b)),
    h('h4', {}, 'Rating'), f.rating.map((b) => row(RATING_LABEL[b.key] ?? b.key, b)),
    h('div', { class: 'facet-row' }, h('span', { class: 'muted' }, '4+ stars (cumulative)'), h('span', { class: 'count' }, fmt.n(ratingCum(4)))),
    h('div', { class: 'facet-row' }, h('span', { class: 'muted' }, '3+ stars (cumulative)'), h('span', { class: 'count' }, fmt.n(ratingCum(3)))),
  );
}

function renderBenchmark(r) {
  const wrap = h('div', { class: 'card' }, h('h3', {}, 'Benchmark: ranked search'), resultHeader(r));
  if (!r) return wrap;
  for (const e of r.perEnv) {
    wrap.append(h('h4', { class: 'section' }, `${e.envName} `, h('span', { class: 'badge' }, serverBadge(e.server))));
    if (e.skipped) { wrap.append(h('p', { class: 'muted' }, 'Skipped: no queryable Search index.')); continue; }
    wrap.append(table([
      { label: 'query', value: (q) => q.label },
      { label: 'matches', num: true, value: (q) => fmt.n(q.totalMatches) },
      { label: 'first run', num: true, value: (q) => fmt.ms(q.firstRunMs) },
      { label: 'p50', num: true, value: (q) => fmt.ms(q.latency.p50) },
      { label: 'p95', num: true, value: (q) => fmt.ms(q.latency.p95) },
      { label: 'p99', num: true, value: (q) => fmt.ms(q.latency.p99) },
      { label: 'throughput', num: true, value: (q) => (q.throughput ? `${fmt.n(q.throughput.opsPerSec)}/s @${q.throughput.concurrency}` : '–') },
      { label: 'errors', num: true, value: (q) => q.errors },
    ], e.queries));
  }
  if (r.crossEnv?.length) wrap.append(bulletCallout('Same query, different deployments', r.crossEnv.map((c) => `${c.item}: ${c.explanation}`)), h('p', { class: 'muted' }, r.crossEnv[0].caveat));
  wrap.append(bulletCallout('What this means for an e-commerce platform', r.interpretation, 'good'));
  return wrap;
}

import { api, fmt, h, state } from '../app.js';
import { bulletCallout, flow, jobPanel, loadResult, resultHeader, serverBadge, table } from '../components.js';
import { facetPanel, kpi } from './search.js';

export const VARIANT_LABEL = {
  'searchMeta-counts': 'Search facets: counts',
  'searchMeta-metrics': 'Search facets: counts + avg/min/max/sum (Preview)',
  'search-group-metrics': '$search → $group (full documents)',
  'search-stored-group-metrics': '$search returnStoredSource → $group',
  'match-group-metrics': '$match (B-tree) → $group, no Search',
};

/** Part B: the facet panel and per-bucket statistics computed inside the Search index. */
export default {
  id: 'facets',
  title: 'Facet Aggregation',
  render(el) {
    const envs = state.overview?.environments ?? [];
    const envSelect = h('select', {}, envs.map((e) => h('option', { value: e.id }, e.name)));
    const q = h('input', { value: 'running shoes' });
    const out = h('div', {});
    const form = h('form', { class: 'controls' }, h('label', {}, 'Environment', envSelect), h('label', { class: 'grow' }, 'Search (empty = whole catalogue)', q), h('button', { type: 'submit' }, 'Compute facets'));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      out.replaceChildren(h('p', { class: 'muted' }, 'Running each variant once (after one warm-up)…'));
      try {
        out.replaceChildren(renderCompare(await api.get(`/api/search/facet-compare?${new URLSearchParams({ env: envSelect.value, q: q.value })}`)));
      } catch (e) {
        out.replaceChildren(h('div', { class: 'callout bad' }, e.message));
      }
    });
    const results = h('div', {});
    const show = async () => results.replaceChildren(renderBenchmark(await loadResult('facets')));
    el.append(
      h('div', { class: 'card' },
        h('h2', {}, 'Faceted search with Search-side aggregation'),
        flow(['Search index', 'search + filtering', 'facets + per-bucket count / avg / min / max / sum', 'result']),
        h('p', { class: 'ink2' }, 'A shop page needs the facet panel ("Nike 32,100 · Adidas 27,430 …") and, increasingly, statistics per bucket (average price per brand, price range). MongoDB Search can compute facet counts in the index; facet aggregations (sum, avg, min, max, first, last per bucket) extend that. Facet aggregations are documented as Preview and depend on the Search engine (mongot) version, not the MongoDB server version - this page detects support at runtime.'),
        form, out,
      ),
      jobPanel({ benchmark: 'facets', fields: [{ key: 'MEASURED_ITERATIONS', label: 'Iterations', value: '100' }, { key: 'WARMUP_ITERATIONS', label: 'Warm-up', value: '10' }], onDone: show }),
      results,
    );
    show();
    if (envs.length) form.requestSubmit();
  },
};

function renderCompare(r) {
  const v = r.variants;
  const metricsOk = v['searchMeta-metrics'] && !v['searchMeta-metrics'].error;
  const best = metricsOk ? v['searchMeta-metrics'].facets : v['search-group-metrics']?.facets;
  const source = metricsOk ? 'MongoDB Search facet aggregations' : '$search → $group (facet aggregations unavailable here)';
  return h('div', { class: 'section' },
    h('div', { class: 'kpis' }, kpi(fmt.n(best?.total), `results for ${r.label}`), kpi(fmt.ms(v['searchMeta-counts']?.ms), 'facet counts from Search'), kpi(metricsOk ? fmt.ms(v['searchMeta-metrics'].ms) : 'n/a', 'counts + metrics from Search'), kpi(fmt.ms(v['search-group-metrics']?.ms), 'same via $search → $group')),
    !metricsOk && v['searchMeta-metrics'] ? h('div', { class: 'callout warn' }, h('strong', {}, 'Facet aggregations are not supported on this deployment. '), v['searchMeta-metrics'].error, ' - the statistics below come from $search → $group instead.') : null,
    h('div', { class: 'facet-layout section' },
      h('div', {}, best ? facetPanel(best, { metrics: true }) : null),
      h('div', {},
        h('h4', {}, `Per-brand statistics · source: ${source}`),
        best ? table([
          { label: 'brand', value: (b) => b.key },
          { label: 'products', num: true, value: (b) => fmt.n(b.count) },
          { label: 'avg price', num: true, value: (b) => fmt.money(b.metrics.avgPrice) },
          { label: 'min', num: true, value: (b) => fmt.money(b.metrics.minPrice) },
          { label: 'max', num: true, value: (b) => fmt.money(b.metrics.maxPrice) },
          { label: 'units in stock', num: true, value: (b) => fmt.n(b.metrics.totalStock) },
          { label: 'avg rating', num: true, value: (b) => (b.metrics.avgRating?.toFixed(2) ?? '–') },
        ], best.brand) : null,
        h('h4', { class: 'section' }, 'One run of each way to compute this panel'),
        table([
          { label: 'variant', value: ([id]) => VARIANT_LABEL[id] ?? id },
          { label: 'time', num: true, value: ([, x]) => (x.error ? 'unsupported' : fmt.ms(x.ms)) },
          { label: 'same answer as $search → $group?', value: ([id]) => id === 'search-group-metrics' ? 'reference' : r.parity[id] ? (r.parity[id].ok ? h('span', { class: 'badge good' }, 'identical') : h('span', { class: 'badge bad' }, r.parity[id].differences.slice(0, 2).join('; '))) : '–' },
        ], Object.entries(v)),
        h('p', { class: 'muted' }, 'Single runs are indicative only - use the benchmark below for p50/p95/p99.'),
      ),
    ),
    h('details', {}, h('summary', {}, 'Pipelines'), h('pre', {}, JSON.stringify(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.pipeline])), null, 2))),
  );
}

function renderBenchmark(r) {
  const wrap = h('div', { class: 'card' }, h('h3', {}, 'Benchmark: facet panel'), resultHeader(r));
  if (!r) return wrap;
  for (const e of r.perEnv) {
    wrap.append(h('h4', { class: 'section' }, `${e.envName} `, h('span', { class: 'badge' }, serverBadge(e.server)), ' ', e.facetAggregationsSupported ? h('span', { class: 'badge good' }, 'facet aggregations supported') : h('span', { class: 'badge warn' }, 'facet aggregations not supported')));
    if (e.skipped) { wrap.append(h('p', { class: 'muted' }, 'Skipped: no queryable Search index.')); continue; }
    wrap.append(table([
      { label: 'variant', value: (x) => x.label },
      { label: 'execution path', value: (x) => h('span', { class: 'muted' }, x.executionPath) },
      { label: 'p50', num: true, value: (x) => (x.supported ? fmt.ms(x.latency.p50) : 'unsupported') },
      { label: 'p95', num: true, value: (x) => fmt.ms(x.latency.p95) },
      { label: 'p99', num: true, value: (x) => fmt.ms(x.latency.p99) },
      { label: 'throughput', num: true, value: (x) => (x.throughput ? `${fmt.n(x.throughput.opsPerSec)}/s` : '–') },
    ], e.variants));
  }
  wrap.append(bulletCallout('Interpretation', r.interpretation, 'good'));
  return wrap;
}

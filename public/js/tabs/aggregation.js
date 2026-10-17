import { fmt, h } from '../app.js';
import { bulletCallout, categoryLineChart, chartCard, flow, jobPanel, loadResult, resultHeader, seriesColor, serverBadge, table } from '../components.js';

// Fixed variant order = fixed colour per variant, across every chart.
const ORDER = ['searchMeta-counts', 'searchMeta-metrics', 'search-group-counts', 'search-group-metrics', 'search-stored-group-metrics', 'match-group-counts', 'match-group-metrics'];

/** Part C: Search-side aggregation vs the aggregation pipeline, across query selectivity. */
export default {
  id: 'aggregation',
  title: 'Aggregation Comparison',
  render(el) {
    const results = h('div', {});
    const show = async () => results.replaceChildren(...renderResult(await loadResult('aggregation')));
    el.append(
      h('div', { class: 'card' },
        h('h2', {}, 'Search facets vs $group'),
        h('div', { class: 'grid two' },
          h('div', {}, h('h4', {}, 'Search-side aggregation'), flow(['Search/Lucene index', 'facet collector (+ aggregations)', '1 small document'])),
          h('div', {}, h('h4', {}, 'Aggregation pipeline'), flow(['$search or $match', 'N matching documents → mongod', '$group / $bucket'])),
        ),
        h('p', { class: 'ink2' }, 'Seven queries from ~4% to 100% of the catalogue, each answered every possible way. Every pair of variants is checked to return identical numbers before its timings are compared. Timings are interleaved (shuffled order per round) after a warm-up, so cache warmth and drift affect all variants equally.'),
        h('p', { class: 'muted' }, 'Do not expect one path to always win: for a narrow query the difference is small; for structured filters a B-tree $match can be competitive. The gap that matters grows with the number of documents the $group path has to move.'),
      ),
      jobPanel({
        benchmark: 'aggregation',
        fields: [
          { key: 'MEASURED_ITERATIONS', label: 'Iterations', value: '100' },
          { key: 'WARMUP_ITERATIONS', label: 'Warm-up', value: '10' },
          { key: 'THROUGHPUT_SECONDS', label: 'Throughput s/variant', value: '10' },
          { key: 'AGGREGATION_QUERIES', label: 'Only queries (ids)', value: '', size: 18, placeholder: 'text-medium,struct-all' },
        ],
        onDone: show,
      }),
      results,
    );
    show();
  },
};

function renderResult(r) {
  if (!r) return [h('div', { class: 'card' }, resultHeader(r))];
  const cards = [];
  for (const e of r.perEnv) {
    const queries = e.queries;
    // Full-text and structured queries are different families: one chart each, so no line joins them.
    for (const [family, title] of [['text', 'full-text queries'], ['struct', 'structured queries']]) {
      const qs = queries.filter((q) => q.id.startsWith(family));
      if (!qs.length) continue;
      const variantIds = ORDER.filter((id) => qs.some((q) => q.variants.some((v) => v.id === id && v.supported)));
      const { card, canvas } = chartCard(`${e.envName} - p50 latency vs share of catalogue matched (${title})`, 'y: median latency, log scale · one line per way of computing the facet panel · same colour = same variant in every chart');
      card.insertBefore(h('p', { class: 'muted' }, serverBadge(e.server)), card.querySelector('.chart-box'));
      cards.push(card);
      requestAnimationFrame(() => categoryLineChart(canvas, {
        labels: qs.map((q) => `${q.matchedPct ?? '?'}% · ${q.id}`),
        yLabel: 'p50 ms (log)',
        logY: true,
        datasets: variantIds.map((id) => ({
          label: qs.flatMap((q) => q.variants).find((v) => v.id === id).label,
          borderColor: seriesColor(ORDER.indexOf(id)),
          data: qs.map((q) => q.variants.find((v) => v.id === id && v.supported)?.latency.p50 ?? null),
        })),
      }));
    }

    const detail = h('div', { class: 'card' }, h('h3', {}, `${e.envName} - per query`), resultHeader(r));
    for (const q of queries) {
      const parityFails = Object.entries(q.parity).filter(([, p]) => !p.ok);
      detail.append(
        h('h4', { class: 'section' }, `${q.label} `, h('span', { class: 'badge' }, `${fmt.n(q.matchedDocs)} docs · ${q.matchedPct}%`), ' ',
          parityFails.length ? h('span', { class: 'badge bad' }, `parity failed: ${parityFails.map(([k]) => k).join(', ')}`) : h('span', { class: 'badge good' }, 'all variants returned identical results')),
        table([
          { label: 'variant', value: (v) => v.label },
          { label: 'path', value: (v) => h('span', { class: 'muted' }, v.executionPath) },
          { label: 'p50', num: true, value: (v) => (v.supported ? fmt.ms(v.latency.p50) : 'unsupported') },
          { label: 'p95', num: true, value: (v) => fmt.ms(v.latency.p95) },
          { label: 'p99', num: true, value: (v) => fmt.ms(v.latency.p99) },
          { label: 'samples', num: true, value: (v) => `${v.latency.count}${v.iterationsCapped ? ' (time-capped)' : ''}` },
          { label: 'throughput', num: true, value: (v) => (v.throughput ? `${fmt.n(v.throughput.opsPerSec)}/s` : '–') },
        ], q.variants),
        q.comparisons.length ? h('ul', {}, q.comparisons.map((c) => h('li', { class: 'ink2' }, c.explanation))) : null,
      );
    }
    cards.push(detail);
  }
  cards.push(h('div', { class: 'card' }, bulletCallout('Interpretation', r.interpretation, 'good'),
    bulletCallout('What this means for an e-commerce platform', [
      'Traditional aggregation: Search → documents → $group. Search-side aggregation: Search index → facet/aggregation.',
      'Potential benefit: less document processing and materialisation for search-heavy pages - category pages with many matching products are where it shows.',
      'Narrow searches (a few hundred matches) won\'t feel different to shoppers; broad category browsing will.',
    ])));
  return cards;
}

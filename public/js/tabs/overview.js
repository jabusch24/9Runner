import { api, h, state } from '../app.js';
import { bulletCallout, flow, table } from '../components.js';

export default {
  id: 'overview',
  title: 'Overview',
  render(el) {
    const o = state.overview;
    const probeBox = h('div', {});
    const probeBtn = h('button', { class: 'ghost', type: 'button' }, 'Probe environments');
    probeBtn.addEventListener('click', async () => {
      probeBtn.disabled = true;
      probeBox.replaceChildren(h('p', { class: 'muted' }, 'Connecting to every environment…'));
      try {
        const r = await api.get('/api/probe?refresh=true');
        probeBox.replaceChildren(renderProbe(r.envs));
      } catch (e) {
        probeBox.replaceChildren(h('div', { class: 'callout bad' }, e.message));
      }
      probeBtn.disabled = false;
    });

    el.append(
      h('div', { class: 'card' },
        h('h2', {}, 'What this demo shows'),
        h('p', {}, 'One realistic e-commerce workload (products, reviews, orders) sent to MongoDB 8 and MongoDB 9 deployments. The demo measures - it never assumes - and says so when there is no difference.'),
        h('div', { class: 'grid two' },
          h('div', {},
            h('h4', {}, '1 · Search aggregations'),
            flow(['Search index', 'match + filter + facets / per-bucket metrics', 'one metadata doc']),
            h('p', { class: 'muted' }, 'vs. the classic path:'),
            flow(['$search or $match', 'every matching document → mongod', '$group / $bucket']),
            h('p', { class: 'ink2' }, 'Expected: little difference for narrow queries, a growing gap as more documents match. Measured in the Facet Aggregation and Aggregation Comparison tabs.'),
          ),
          h('div', {},
            h('h4', {}, '2 · Intelligent Workload Management'),
            flow(['normal traffic', 'ramp', 'sustained overload', 'recovery']),
            h('p', { class: 'ink2' }, 'The same open-loop load (requests keep arriving when the database slows down) against MongoDB 8, MongoDB 9 + IWM and MongoDB 9 + IWM + Load Shedding. Judge by successful requests within the SLO, critical-path latency, recovery and cluster health - not by accepted requests.'),
          ),
        ),
      ),
      h('div', { class: 'card' },
        h('h3', {}, 'Configured environments'),
        o?.environments?.length
          ? table([
              { label: 'id', value: (e) => h('code', {}, e.id) },
              { label: 'name', value: (e) => e.name },
              { label: 'host', value: (e) => e.host },
              { label: 'where', value: (e) => e.location },
              { label: 'tier (label)', value: (e) => e.tier },
              { label: 'IWM (label)', value: (e) => (e.iwm == null ? '–' : e.iwm ? 'yes' : 'no') },
              { label: 'Load Shedding (label)', value: (e) => (e.loadShedding == null ? '–' : e.loadShedding ? 'yes' : 'no') },
            ], o.environments)
          : h('div', { class: 'callout warn' }, 'No environments configured. Copy .env.example to .env.'),
        h('p', { class: 'muted section' }, 'Labels come from .env. "Probe" asks each server what it really is - version, ingress rate limiter state, execution control, dataset and Search index - and whether per-bucket facet aggregations are supported.'),
        probeBtn,
        probeBox,
      ),
      h('div', { class: 'card' },
        h('h3', {}, 'Read this before presenting'),
        bulletCallout('Version caveats (verified against MongoDB docs, Oct 2026)', [
          'IWM is an Atlas capability on Dedicated clusters running MongoDB 9.0+. Its always-on protections (queueing, prioritisation, slowing down) cannot be switched off there, so "MongoDB 9 without IWM" only exists outside Atlas Dedicated.',
          'Load Shedding is optional (Atlas Managed / Enabled / Disabled) and only takes effect on M30+ replica sets on 9.0+. On M10/M20 the setting is shown but the effective state stays Disabled.',
          'MongoDB 8.x already has much of the machinery: throughput-probing execution control, heuristic deprioritisation of long-running operations, ingress connection rate limiting (8.0.12+/8.2) and an ingress request rate limiter with SystemOverloadedError (8.0.20+ changelog). Atlas adaptive operation rate limiting exists from 8.3 (off by default). Expect 8 and 9 to look similar unless the workload actually saturates the cluster.',
          'Search runs in mongot, versioned separately from the server. Per-bucket facet aggregations (avg/min/max/sum/first/last) are a Search capability documented as Preview - a 9.0 cluster may lack it, and it is not "MongoDB 9 made search faster".',
          'Rejected requests come back as SystemOverloadedError (codes 462/463). Driver 7.x retries them by default (maxAdaptiveRetries = 2); the benchmarks disable that unless CLIENT_RETRY_MODE=driver so rejections are visible.',
        ], 'warn'),
      ),
    );
  },
};

function renderProbe(envs) {
  if (!Array.isArray(envs)) return h('div', { class: 'callout bad' }, JSON.stringify(envs));
  return table([
    { label: 'env', value: (e) => e.name ?? e.env },
    { label: 'version', value: (e) => e.error ? h('span', { class: 'badge bad' }, e.error) : e.version },
    { label: 'topology', value: (e) => e.topology },
    { label: 'ingress limiter', value: (e) => e.ingressRateLimiter ? `enabled=${e.ingressRateLimiter.enabled} rate=${e.ingressRateLimiter.admissionRatePerSec}/s queue=${e.ingressRateLimiter.maxQueueDepth}` : '–' },
    { label: 'exec control', value: (e) => e.executionControl ? Object.entries(e.executionControl).filter(([, v]) => v).map(([k]) => k).join(', ') : '–' },
    { label: 'dataset', value: (e) => e.dataset ? `${e.dataset.productCount.toLocaleString()} products` : h('span', { class: 'badge bad' }, 'not seeded') },
    { label: 'search index', value: (e) => e.searchIndex?.queryable ? h('span', { class: 'badge good' }, e.searchIndex.status) : h('span', { class: 'badge bad' }, e.searchIndex?.status ?? 'missing') },
    { label: 'facet aggregations', value: (e) => (String(e.facetAggregations).startsWith('supported') ? h('span', { class: 'badge good' }, 'supported') : h('span', { class: 'badge warn' }, e.facetAggregations ?? '–')) },
    { label: 'warnings', value: (e) => (e.warnings ?? []).join(' ') },
  ], envs);
}

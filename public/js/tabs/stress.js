import { fmt, h, state } from '../app.js';
import { STATUS, bulletCallout, chartCard, flow, jobPanel, lineChart, loadResult, resultHeader, seriesColor, table, css } from '../components.js';

/**
 * Timeline metrics, one chart per measure (never two y-scales), one line per run.
 * The colour of a run is its position in the result file.
 */
const METRICS = [
  { key: 'goodput', title: 'Goodput: requests completed within SLO per second', sub: 'what shoppers experience as "the site works"', y: 'req/s', get: (p) => p.okWithinSlo, target: true },
  { key: 'ok', title: 'Successful requests per second', sub: 'includes slow successes', y: 'req/s', get: (p) => p.ok, target: true },
  { key: 'rejected', title: 'Rejected requests per second', sub: 'SystemOverloadedError - fast failures the client can retry', y: 'req/s', get: (p) => p.rejected },
  { key: 'failed', title: 'Timeouts + errors per second', sub: 'slow failures: held a connection until the deadline', y: 'req/s', get: (p) => p.timeouts + p.errors + p.clientDropped },
  { key: 'crit', title: 'Critical-path p95 latency', sub: 'product page, listing, search, checkout, inventory', y: 'ms', get: (p) => p.criticalP95 },
  { key: 'p99', title: 'All requests p99 latency', sub: 'measured from scheduled send time (includes client queueing)', y: 'ms', get: (p) => p.p99 },
  { key: 'cpu', title: 'Server CPU (primary)', sub: 'serverStatus user+system time / cores', y: '%', get: (p) => p.server?.cpuPct ?? null },
  { key: 'canary', title: 'Canary product-page read p50', sub: 'independent probe: "can a shopper open a product page right now?"', y: 'ms', get: (p) => p.server?.canary?.p50 ?? null },
];

function createDashboard(phases, totalSec) {
  const grid = h('div', { class: 'grid two section' });
  const charts = {};
  for (const m of METRICS) {
    const { card, canvas } = chartCard(m.title, m.sub);
    grid.append(card);
    charts[m.key] = { m, canvas, chart: null };
  }
  const runs = new Map(); // label -> index
  const ensure = () => {
    for (const c of Object.values(charts)) {
      if (!c.chart && c.canvas.isConnected) c.chart = lineChart(c.canvas, { yLabel: c.m.y, phases, xMax: totalSec, datasets: [] });
    }
  };
  const datasetFor = (c, label) => {
    let i = runs.get(label);
    if (i == null) { i = runs.size; runs.set(label, i); }
    let ds = c.chart.data.datasets.find((d) => d.label === label);
    if (!ds) {
      ds = { label, data: [], borderColor: seriesColor(i), borderWidth: 2, pointRadius: 0, tension: 0.15, spanGaps: true, backgroundColor: seriesColor(i) };
      c.chart.data.datasets.push(ds);
    }
    return ds;
  };
  const targetDs = (c) => {
    let ds = c.chart.data.datasets.find((d) => d.label === 'target rate');
    if (!ds) {
      ds = { label: 'target rate', data: [], borderColor: css('--muted'), borderDash: [4, 4], borderWidth: 1, pointRadius: 0, backgroundColor: css('--muted') };
      c.chart.data.datasets.unshift(ds);
    }
    return ds;
  };
  return {
    el: grid,
    addPoint(label, p, redraw = true) {
      ensure();
      for (const c of Object.values(charts)) {
        if (!c.chart) continue;
        datasetFor(c, label).data.push({ x: p.sec, y: c.m.get(p) });
        if (c.m.target) {
          const t = targetDs(c);
          if (!t.data.some((d) => d.x === p.sec)) t.data.push({ x: p.sec, y: p.targetRps });
        }
        c.chart.options.plugins.legend.display = c.chart.data.datasets.length > 1;
        if (redraw) c.chart.update('none');
      }
    },
    redraw() { for (const c of Object.values(charts)) c.chart?.update('none'); },
  };
}

function outcomeStack(s) {
  const attempted = Math.max(1, s.attempted);
  const parts = [
    ['withinSlo', s.okWithinSlo], ['slow', s.ok - s.okWithinSlo], ['rejected', s.rejected], ['timeout', s.timeouts], ['error', s.errors + s.clientDropped],
  ];
  return h('div', { class: 'stack', role: 'img', 'aria-label': parts.map(([k, v]) => `${STATUS[k].label}: ${v}`).join(', ') },
    parts.filter(([, v]) => v > 0).map(([k, v]) => {
      const d = h('div', { title: `${STATUS[k].label}: ${v.toLocaleString()} (${((v / attempted) * 100).toFixed(1)}%)` });
      d.style.width = `${(v / attempted) * 100}%`;
      d.style.background = STATUS[k].color();
      return d;
    }));
}

function legendForOutcomes() {
  return h('div', { class: 'legend' }, Object.values(STATUS).map((s) => {
    const sw = h('span', { class: 'swatch' });
    sw.style.background = s.color();
    return h('span', {}, sw, s.label);
  }));
}

export function renderStressResult(r, { context }) {
  const out = h('div', {});
  if (!r) { out.append(h('div', { class: 'card' }, resultHeader(r))); return out; }
  const it = r.interpretation;
  out.append(h('div', { class: 'card' },
    h('h3', {}, 'Result'), resultHeader(r),
    bulletCallout('Validity', it.caveats, 'bad'),
    bulletCallout('Headline (measured, not assumed)', it.headline),
    bulletCallout('What this means for an e-commerce platform', it.ecommerce, 'good'),
    h('details', {}, h('summary', {}, 'All findings'), h('ul', {}, it.details.map((d) => h('li', { class: 'ink2' }, d)))),
  ));

  // Outcome funnel for the overload phase - "don't look only at accepted requests"
  const funnel = h('div', { class: 'card' }, h('h3', {}, 'Overload phase: what happened to every request'), h('p', { class: 'muted' }, 'Attempted → accepted (not rejected) → succeeded → succeeded within SLO. Accepted is not the goal: a request that is accepted and then times out is worse for the shopper than a fast rejection they can retry.'), legendForOutcomes());
  for (const run of r.runs) {
    const s = run.byPhase.overload ?? Object.values(run.byPhase).at(-1);
    funnel.append(h('div', { class: 'funnel-row' }, h('div', { class: 'label' }, run.label), outcomeStack(s)));
  }
  funnel.append(table([
    { label: 'run', value: (x) => x.label },
    { label: 'attempted', num: true, value: (x) => fmt.n(x.attempted) },
    { label: 'accepted', num: true, value: (x) => fmt.n(x.accepted) },
    { label: 'succeeded', num: true, value: (x) => fmt.n(x.succeeded) },
    { label: `< ${r.sloMs} ms`, num: true, value: (x) => fmt.n(x.succeededWithinSlo) },
    { label: 'SLO %', num: true, value: (x) => fmt.pct(x.sloCompliancePct) },
    { label: 'rejected', num: true, value: (x) => fmt.n(x.rejected) },
    { label: 'timeouts', num: true, value: (x) => fmt.n(x.timeouts) },
    { label: 'errors', num: true, value: (x) => fmt.n(x.errors + x.clientDropped) },
    { label: 'goodput', num: true, value: (x) => fmt.rate(x.goodputPerSec) },
    { label: 'critical p99', num: true, value: (x) => fmt.ms(x.criticalP99) },
    { label: 'recovery', num: true, value: (x) => (x.recoveredAfterSec == null ? 'not within window' : `${x.recoveredAfterSec} s`) },
    { label: 'canary p50 / max', num: true, value: (x) => `${fmt.ms(x.canaryP50)} / ${fmt.ms(x.canaryMax)}` },
    { label: 'peak CPU', num: true, value: (x) => fmt.pct(x.peakCpuPct) },
    { label: 'valid', value: (x) => (x.valid ? (x.overloadReached ? h('span', { class: 'badge good' }, 'yes') : h('span', { class: 'badge warn' }, 'not overloaded')) : h('span', { class: 'badge bad' }, 'client-bound')) },
  ], r.summary.overload));
  out.append(funnel);

  // Timelines
  const total = Math.max(...r.runs.map((x) => x.timeline.length));
  const dash = createDashboard(r.schedule.phases, total);
  out.append(h('div', { class: 'card' }, h('h3', {}, 'Over time'), h('p', { class: 'muted' }, 'Shaded: overload phase. Dashed: target arrival rate. Hover for every run at that second.'), dash.el));
  requestAnimationFrame(() => {
    for (const run of r.runs) for (const p of run.timeline) dash.addPoint(run.label, p, false);
    dash.redraw();
  });

  // Per-phase, per-run detail
  const phases = h('div', { class: 'card' }, h('h3', {}, 'By phase'));
  for (const run of r.runs) {
    phases.append(h('h4', { class: 'section' }, `${run.label} `, h('span', { class: 'badge' }, `${run.server.version ?? '?'} · ${run.server.location} · retry=${run.retryMode}`)));
    phases.append(table([
      { label: 'phase', value: ([k]) => k },
      { label: 'attempted', num: true, value: ([, s]) => fmt.n(s.attempted) },
      { label: 'ok', num: true, value: ([, s]) => fmt.n(s.ok) },
      { label: 'SLO %', num: true, value: ([, s]) => fmt.pct(s.sloCompliancePct) },
      { label: 'rejected', num: true, value: ([, s]) => fmt.n(s.rejected) },
      { label: 'timeouts', num: true, value: ([, s]) => fmt.n(s.timeouts) },
      { label: 'errors', num: true, value: ([, s]) => fmt.n(s.errors + s.clientDropped) },
      { label: 'p50', num: true, value: ([, s]) => fmt.ms(s.latency.p50) },
      { label: 'p95', num: true, value: ([, s]) => fmt.ms(s.latency.p95) },
      { label: 'p99', num: true, value: ([, s]) => fmt.ms(s.latency.p99) },
      { label: 'retries', num: true, value: ([, s]) => fmt.n(s.retries) },
    ], Object.entries(run.byPhase)));
    const classes = run.byPhase.overload?.byClass;
    if (classes) {
      phases.append(h('details', {}, h('summary', {}, 'Overload phase by operation class'), table([
        { label: 'class', value: ([k]) => k },
        { label: 'attempted', num: true, value: ([, s]) => fmt.n(s.attempted) },
        { label: 'SLO %', num: true, value: ([, s]) => fmt.pct(s.sloCompliancePct) },
        { label: 'rejected', num: true, value: ([, s]) => fmt.n(s.rejected) },
        { label: 'timeouts', num: true, value: ([, s]) => fmt.n(s.timeouts) },
        { label: 'p50', num: true, value: ([, s]) => fmt.ms(s.latency.p50) },
        { label: 'p99', num: true, value: ([, s]) => fmt.ms(s.latency.p99) },
      ], Object.entries(classes))));
    }
    if (run.validity.warnings.length) phases.append(bulletCallout('Warnings', run.validity.warnings, 'warn'));
    if (Object.keys(run.errorCodes).length) phases.append(h('p', { class: 'muted' }, `Error codes: ${Object.entries(run.errorCodes).map(([k, v]) => `${k} ×${v}`).join(', ')}`));
  }
  out.append(phases);

  if (context === 'mongo8-vs-9' || context === 'iwm') out.append(versionFacts(r));
  return out;
}

function versionFacts(r) {
  return h('div', { class: 'card' }, h('h3', {}, 'What each server reported'),
    table([
      { label: 'run', value: (x) => x.label },
      { label: 'version', value: (x) => x.server.version },
      { label: 'execution control', value: (x) => (x.server.executionControl ? Object.entries(x.server.executionControl).map(([k, v]) => `${k}=${v}`).join(' ') : 'not readable') },
      { label: 'ingress request limiter', value: (x) => (x.server.ingressRateLimiter ? `enabled=${x.server.ingressRateLimiter.enabled} rate=${x.server.ingressRateLimiter.admissionRatePerSec}/s maxQueue=${x.server.ingressRateLimiter.maxQueueDepth}` : 'not reported') },
      { label: 'labels (from .env)', value: (x) => `IWM=${x.server.configuredIwm ?? '–'} LS=${x.server.configuredLoadShedding ?? '–'}` },
    ], r.runs),
    h('p', { class: 'muted' }, 'On Atlas the limiter parameters are managed by IWM and may not be readable; serverStatus counters (ingress rejected/queued) are recorded per second in the timeline.'));
}

function conceptCard() {
  return h('div', { class: 'card' },
    h('div', { class: 'grid two' },
      h('div', {}, h('h4', {}, 'Without Load Shedding'), flow(['more accepted requests', 'more queued work', 'higher latency', 'resource exhaustion', 'cluster becomes unhealthy']), h('p', { class: 'muted' }, 'IWM still queues, slows down and prioritises - it does not reject.')),
      h('div', {}, h('h4', {}, 'With Load Shedding'), flow(['too much work', 'reject excess (SystemOverloadedError)', 'bounded pressure', 'healthy requests continue', 'client retries with backoff'])),
    ),
  );
}

function stressTab({ id, title, benchmark, context, intro, defaultEnvs, extraFields = [] }) {
  return {
    id, title,
    render(el) {
      const live = h('div', {});
      const resultBox = h('div', {});
      const show = async () => resultBox.replaceChildren(renderStressResult(await loadResult(benchmark), { context }));
      let dash = null;
      const configured = (state.overview?.environments ?? []).map((e) => e.id);
      let envs = defaultEnvs.filter((e) => configured.includes(e));
      if (!envs.length && configured.includes('local')) envs = ['local'];
      const s = state.overview?.settings ?? {};
      el.append(
        h('div', { class: 'card' }, h('h2', {}, title), ...intro()),
        context !== 'mongo8-vs-9' ? conceptCard() : null,
        jobPanel({
          benchmark,
          defaultEnvs: envs,
          note: 'Runs one environment at a time with a cooldown in between. The load generator must not be the bottleneck - watch for CLIENT-BOUND warnings and run it from a VM in the same region as the clusters.',
          fields: [
            { key: 'BASE_RPS', label: 'Base req/s', value: String(s.baseRps ?? 1000) },
            { key: 'PEAK_RPS', label: 'Peak req/s', value: String(s.peakRps ?? 8000) },
            { key: 'RAMP_STEPS', label: 'Ramp steps (opt.)', value: '', placeholder: '2000,4000,8000', size: 14 },
            { key: 'OVERLOAD_SECONDS', label: 'Overload s', value: '60', size: 5 },
            { key: 'RECOVERY_SECONDS', label: 'Recovery s', value: '30', size: 5 },
            { key: 'SLO_MS', label: 'SLO ms', value: String(s.sloMs ?? 500), size: 5 },
            { key: 'WORKERS', label: 'Workers', value: String(s.workers ?? 4), size: 3 },
            ...extraFields,
          ],
          onProgress: (e) => {
            if (!dash) {
              dash = createDashboard(e.phases ?? [], e.totalSec);
              live.replaceChildren(h('div', { class: 'card' }, h('h3', {}, 'Live'), h('p', { class: 'muted' }, 'Updating every second while the benchmark runs.'), dash.el));
            }
            dash.addPoint(e.label, e.point);
          },
          onDone: () => { dash = null; live.replaceChildren(); show(); },
        }),
        live,
        resultBox,
      );
      show();
    },
  };
}

export const iwmTab = stressTab({
  id: 'iwm', title: 'IWM Stress Test', benchmark: 'iwm', context: 'iwm',
  defaultEnvs: ['mongo8', 'mongo9', 'mongo9iwm', 'mongo9iwmls'],
  intro: () => [
    h('p', { class: 'ink2' }, 'Normal traffic → ramp → sustained overload → recovery, with the same open-loop arrival schedule against each deployment. Requests keep arriving when the database slows down; nothing stops early.'),
    h('p', { class: 'muted' }, 'IWM in 9.0 (Atlas Dedicated) queues surplus requests, keeps short operations moving and long ones stable, and throttles only as a last resort. It does not add capacity. Use "npm run calibrate" first to pick BASE/PEAK rates for your tier.'),
  ],
  extraFields: [{ key: 'CLIENT_RETRY_MODE', label: 'Client retries', value: 'none', options: ['none', 'app', 'driver'] }],
});

export const loadSheddingTab = stressTab({
  id: 'load-shedding', title: 'Load Shedding', benchmark: 'load-shedding', context: 'load-shedding',
  defaultEnvs: ['mongo9iwm', 'mongo9iwmls'],
  intro: () => [
    h('p', { class: 'ink2' }, 'MongoDB 9 + IWM with Load Shedding disabled vs enabled, each run twice: a client that does not retry (what the server did) and one that retries overload errors with exponential backoff (what a well-behaved application experiences).'),
    h('p', { class: 'muted' }, 'Load Shedding only takes effect on M30+ replica sets running 9.0+; check the "Effective state" in Atlas → cluster → Additional Settings. Rejections return SystemOverloadedError with RetryableError when nothing was executed.'),
  ],
  extraFields: [{ key: 'LS_RETRY_MODES', label: 'Client modes', value: 'none,app', size: 10 }],
});

export const versionsTab = stressTab({
  id: 'versions', title: 'MongoDB 8 vs 9', benchmark: 'mongo8-vs-9', context: 'mongo8-vs-9',
  defaultEnvs: ['mongo8', 'mongo9', 'mongo9iwm'],
  intro: () => [
    h('p', { class: 'ink2' }, 'A realistic store mix (default 60% reads incl. search, 20% writes, 10% aggregations, 10% deliberately expensive reports) at steady traffic, then one spike. Normal traffic usually looks the same on 8 and 9 - that is expected.'),
    bulletCallout('Why 8 and 9 may not look dramatically different', [
      '8.x already has throughput-probing execution control and heuristic deprioritisation of long-running operations (visible in the server facts below).',
      'An ingress request rate limiter and the SystemOverloadedError category reached the 8.0 line (8.0.20 changelog); ingress connection rate limiting is in 8.2 and was backported to 8.0.12.',
      'What 9.0 adds on Atlas is IWM as a managed system: adaptive admission control tuned from CPU, queue depth and latency, prioritisation, and optional Load Shedding.',
      'So the difference depends on the 8.x patch release, tier, workload and whether the test actually saturates the cluster.',
    ], 'warn'),
  ],
  extraFields: [{ key: 'WORKLOAD_MIX', label: 'Mix', value: '', placeholder: 'product-page:40,…', size: 22 }],
});

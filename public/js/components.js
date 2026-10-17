import { api, bus, fmt, h, refreshOverview, state } from './app.js';

export const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Fixed categorical order: a run keeps its colour by position in the result file, never by rank. */
export const seriesColor = (i) => css(`--series-${(i % 8) + 1}`);

export const STATUS = {
  withinSlo: { label: 'Succeeded within SLO', color: () => css('--good') },
  slow: { label: 'Succeeded, slower than SLO', color: () => css('--warning') },
  rejected: { label: 'Rejected (overload error)', color: () => css('--serious') },
  timeout: { label: 'Timed out', color: () => css('--critical') },
  error: { label: 'Other error / app queue full', color: () => css('--muted') },
};

// -------------------------------------------------------------------- charts

/** Shade the overload phase and mark where it begins - drawn under the data. */
const phasePlugin = {
  id: 'phases',
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: a, scales: { x } } = chart;
    if (!opts?.phases?.length || !x) return;
    ctx.save();
    for (const p of opts.phases) {
      const x0 = x.getPixelForValue(p.startSec);
      const x1 = x.getPixelForValue(p.endSec);
      if (p.kind === 'overload') {
        ctx.fillStyle = css('--overload-band');
        ctx.fillRect(Math.max(x0, a.left), a.top, Math.min(x1, a.right) - Math.max(x0, a.left), a.bottom - a.top);
      }
    }
    const first = opts.phases.find((p) => p.kind === 'overload');
    if (first) {
      const px = x.getPixelForValue(first.startSec);
      ctx.strokeStyle = css('--critical');
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = css('--ink-2');
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('overload begins', px + 4, a.top + 12);
    }
    ctx.restore();
  },
};

export function lineChart(canvas, { yLabel, phases = [], datasets = [], yMax, xMax }) {
  const grid = css('--grid');
  const muted = css('--muted');
  return new Chart(canvas, {
    type: 'line',
    data: { datasets: datasets.map(styleLine) },
    options: {
      animation: false,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      scales: {
        x: { type: 'linear', min: 0, max: xMax, title: { display: true, text: 'seconds', color: muted }, grid: { color: grid }, ticks: { color: muted } },
        y: { beginAtZero: true, max: yMax, title: { display: Boolean(yLabel), text: yLabel, color: muted }, grid: { color: grid }, ticks: { color: muted } },
      },
      plugins: {
        legend: { display: datasets.length > 1, labels: { color: css('--ink-2'), boxWidth: 14, boxHeight: 3 } },
        tooltip: { callbacks: { title: (items) => `t = ${items[0]?.parsed.x}s` } },
        phases: { phases },
      },
    },
    plugins: [phasePlugin],
  });
}

export function styleLine(ds) {
  return { borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.15, spanGaps: true, fill: false, ...ds, backgroundColor: ds.borderColor };
}

/** Category line chart (x = labels), used for the selectivity sweep. */
export function categoryLineChart(canvas, { labels, datasets, yLabel, logY }) {
  const grid = css('--grid');
  const muted = css('--muted');
  return new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: datasets.map((d) => ({ ...styleLine(d), pointRadius: 4 })) },
    options: {
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { grid: { color: grid }, ticks: { color: muted } },
        y: { type: logY ? 'logarithmic' : 'linear', beginAtZero: !logY, title: { display: true, text: yLabel, color: muted }, grid: { color: grid }, ticks: { color: muted } },
      },
      plugins: { legend: { labels: { color: css('--ink-2'), boxWidth: 14, boxHeight: 3 } } },
    },
  });
}

export function chartCard(title, sub) {
  const canvas = h('canvas');
  const card = h('div', { class: 'card' }, h('div', { class: 'chart-title' }, title), sub ? h('div', { class: 'chart-sub' }, sub) : null, h('div', { class: 'chart-box' }, canvas));
  return { card, canvas };
}

// -------------------------------------------------------------------- tables

export function table(columns, rows) {
  return h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => {
      const v = c.value(r);
      return h('td', { class: c.num ? 'num' : '' }, v instanceof Node ? v : v ?? '–');
    })))),
  ));
}

export function bulletCallout(title, items, kind = '') {
  if (!items?.length) return null;
  return h('div', { class: `callout ${kind}` }, h('strong', {}, title), h('ul', {}, items.map((i) => h('li', {}, i))));
}

export function flow(steps) {
  const out = h('div', { class: 'flow' });
  steps.forEach((s, i) => { if (i) out.append(h('i', {}, '→')); out.append(h('span', {}, s)); });
  return out;
}

// --------------------------------------------------------------- job runner

/**
 * Run controls for a benchmark: environment picker, overrides, live log.
 * `fields` are extra numeric/text overrides shown as inputs.
 */
export function jobPanel({ benchmark, defaultEnvs = [], fields = [], onDone, onProgress, allowEnvPick = true, note }) {
  const envs = state.overview?.environments ?? [];
  const envChecks = envs.map((e) => h('label', {}, h('input', { type: 'checkbox', value: e.id, checked: defaultEnvs.includes(e.id) || (defaultEnvs.length === 0) }), `${e.name}`));
  const inputs = fields.map((f) => {
    const input = f.options
      ? h('select', { name: f.key }, f.options.map((o) => h('option', { value: o, selected: o === f.value }, o)))
      : h('input', { name: f.key, value: f.value ?? '', type: f.type ?? 'text', size: f.size ?? 8, placeholder: f.placeholder ?? '' });
    return h('label', {}, f.label, input);
  });
  const log = h('div', { class: 'log', hidden: true });
  const status = h('span', { class: 'muted' });
  const button = h('button', { type: 'button' }, 'Run benchmark');
  button.addEventListener('click', async () => {
    const chosen = envChecks.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value);
    const overrides = Object.fromEntries(inputs.map((l) => { const i = l.querySelector('input,select'); return [i.name, i.value]; }));
    log.hidden = false;
    log.textContent = '';
    try {
      await api.post('/api/jobs', { benchmark, env: allowEnvPick && chosen.length ? chosen.join(',') : undefined, overrides });
      status.textContent = 'running…';
      button.disabled = true;
    } catch (e) {
      status.textContent = e.message;
    }
  });
  const handler = (e) => {
    if (!log.isConnected && !button.isConnected) { bus.off(handler); return; } // tab was closed
    if (e.type === 'log') { log.textContent += e.line + '\n'; log.scrollTop = log.scrollHeight; }
    if (e.type === 'stress-progress') onProgress?.(e);
    if (e.type === 'job' && e.job.benchmark === benchmark && e.job.state !== 'running') {
      button.disabled = false;
      status.textContent = e.job.state === 'done' ? 'finished' : `failed: ${e.job.error}`;
      refreshOverview().catch(() => undefined);
      if (e.job.state === 'done') onDone?.();
    }
  };
  bus.on(handler);
  const running = state.overview?.job?.state === 'running';
  if (running) { button.disabled = true; status.textContent = `${state.overview.job.benchmark} is running…`; }
  return h('div', { class: 'card' },
    h('h3', {}, 'Run'),
    note ? h('p', { class: 'muted' }, note) : null,
    allowEnvPick && envs.length ? h('div', { class: 'checks' }, envChecks) : null,
    !envs.length ? h('div', { class: 'callout warn' }, 'No environments configured. Copy .env.example to .env and set MONGO_8_URI / MONGO_9_IWM_URI / … (or LOCAL_URI).') : null,
    h('div', { class: 'controls section' }, inputs, button, status),
    log,
  );
}

export async function loadResult(name) {
  try { return await api.get(`/api/results/${name}`); } catch { return null; }
}

export function resultHeader(result) {
  if (!result) return h('p', { class: 'muted' }, 'No saved results yet - run the benchmark.');
  return h('p', { class: 'muted' }, `Results saved ${new Date(result.savedAt).toLocaleString()} · driver ${result.driver ?? '?'}`);
}

export function serverBadge(s) {
  if (!s) return '';
  return `${s.version ?? '?'} · ${s.location}${s.tier ? ' · ' + s.tier : ''}`;
}

export { fmt, h };

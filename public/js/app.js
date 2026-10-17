// Tab shell, API helpers and the live event bus shared by every tab.
// Each tab lives in js/tabs/<name>.js and exports { id, title, render(el, ctx) }.
import overview from './tabs/overview.js';
import searchDemo from './tabs/search.js';
import facets from './tabs/facets.js';
import aggregation from './tabs/aggregation.js';
import { iwmTab, loadSheddingTab, versionsTab } from './tabs/stress.js';
import queryableEncryption from './tabs/queryable-encryption.js';

const TABS = [overview, searchDemo, facets, aggregation, iwmTab, loadSheddingTab, versionsTab, queryableEncryption];

export const api = {
  async get(path) {
    const r = await fetch(path);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  },
  async post(path, data) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || r.statusText);
    return body;
  },
};

/** Minimal DOM builder: h('div', {class: 'x'}, child, 'text'). Text always goes through textContent. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v; // only used with static, trusted markup
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const fmt = {
  ms: (v) => (v == null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : v >= 10 ? `${Math.round(v)} ms` : `${Number(v).toFixed(1)} ms`),
  n: (v) => (v == null ? '–' : Number(v).toLocaleString()),
  pct: (v) => (v == null ? '–' : `${v}%`),
  rate: (v) => (v == null ? '–' : `${Math.round(v).toLocaleString()}/s`),
  money: (v) => (v == null ? '–' : `€${Number(v).toFixed(2)}`),
};

// ---------------------------------------------------------------- live events
const listeners = new Set();
export const bus = { on: (f) => listeners.add(f), off: (f) => listeners.delete(f) };
const source = new EventSource('/api/events');
source.onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.type === 'job') updateJobIndicator(e.job);
  for (const f of listeners) f(e);
};

function updateJobIndicator(job) {
  const el = document.getElementById('job-indicator');
  if (job && job.state === 'running') {
    el.hidden = false;
    el.textContent = `running: ${job.benchmark}`;
  } else el.hidden = true;
}

// ---------------------------------------------------------------- state & tabs
export const state = { overview: null };

export async function refreshOverview() {
  state.overview = await api.get('/api/overview');
  updateJobIndicator(state.overview.job);
  return state.overview;
}

function selectTab(id) {
  const tab = TABS.find((t) => t.id === id) ?? TABS[0];
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.id === tab.id));
  const content = document.getElementById('content');
  content.replaceChildren();
  bus.off(currentListener);
  currentListener = null;
  tab.render(content, { onEvent: (f) => { currentListener = f; bus.on(f); } });
  try { localStorage.setItem('9runner.tab', tab.id); } catch { /* storage may be unavailable */ }
  if (location.hash !== `#${tab.id}`) history.replaceState(null, '', `#${tab.id}`);
}
let currentListener = null;

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('9runner.theme'); } catch { /* ignore */ }
  if (saved) document.documentElement.dataset.theme = saved;
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'light' : 'dark';
    try { localStorage.setItem('9runner.theme', document.documentElement.dataset.theme); } catch { /* ignore */ }
    selectTab(document.querySelector('#tabs button[aria-selected="true"]')?.dataset.id);
  });
}

async function init() {
  initTheme();
  const nav = document.getElementById('tabs');
  for (const t of TABS) {
    nav.append(h('button', { role: 'tab', 'data-id': t.id, onclick: () => selectTab(t.id) }, t.title, t.tag ? h('span', { class: 'tag' }, t.tag) : null));
  }
  await refreshOverview().catch(() => undefined);
  let initial = location.hash.slice(1);
  if (!initial) try { initial = localStorage.getItem('9runner.tab'); } catch { /* ignore */ }
  selectTab(initial);
  addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && document.querySelector('#tabs button[aria-selected="true"]')?.dataset.id !== id) selectTab(id);
  });
}

init();

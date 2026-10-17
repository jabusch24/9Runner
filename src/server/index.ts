import express, { Router } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostOf, isLocalUri, loadEnvironments } from '../config/environments.js';
import { settings } from '../config/settings.js';
import { exportCsv } from '../benchmark/csv.js';
import { driverVersion, probe } from '../benchmark/jobs.js';
import { BENCHMARKS, BenchmarkName, listResults, loadResult } from '../benchmark/results.js';
import { closeAll } from '../utils/mongo.js';
import { JobManager, summary } from './jobManager.js';
import { searchRouter } from './routes/search.js';

const app = express();
app.use(express.json());
const jobs = new JobManager();

// --- Feature modules --------------------------------------------------------
// Each demo feature mounts its own router under /api/<feature> and has a
// matching tab in public/js/tabs/. To add Queryable Encryption: create
// src/server/routes/qe.ts exporting `qeRouter`, add it here, and replace the
// placeholder tab public/js/tabs/queryable-encryption.js.
const features: { mount: string; router: Router }[] = [
  { mount: '/api/search', router: searchRouter },
  // { mount: '/api/qe', router: qeRouter },
];
for (const f of features) app.use(f.mount, f.router);

app.get('/api/overview', async (_req, res) => {
  res.json({
    environments: loadEnvironments().map((e) => ({
      id: e.id, name: e.name, host: hostOf(e.uri), location: isLocalUri(e.uri) ? 'local' : 'remote',
      tier: e.tier ?? null, iwm: e.iwm ?? null, loadShedding: e.loadShedding ?? null, emulation: Boolean(e.emulation),
    })),
    results: await listResults(),
    driver: driverVersion(),
    settings: {
      dbName: settings.dbName, sloMs: settings.sloMs, opTimeoutMs: settings.opTimeoutMs, workers: settings.workers,
      retryMode: settings.clientRetryMode, baseRps: Number(process.env.BASE_RPS ?? 1000), peakRps: Number(process.env.PEAK_RPS ?? 8000),
    },
    job: jobs.current ? summary(jobs.current) : null,
  });
});

let probeCache: { at: number; data: unknown } | null = null;
app.get('/api/probe', async (req, res) => {
  if (probeCache && Date.now() - probeCache.at < 60_000 && req.query.refresh !== 'true') return res.json(probeCache.data);
  const lines: string[] = [];
  const data = { envs: await probe('all', (m) => lines.push(m)).catch((e) => ({ error: (e as Error).message })), text: lines.join('\n') };
  probeCache = { at: Date.now(), data };
  res.json(data);
});

app.get('/api/results/:name', async (req, res) => {
  const r = await loadResult(req.params.name);
  if (!r) return res.status(404).json({ error: `No results for ${req.params.name} yet - run the benchmark first.` });
  res.json(r);
});

app.get('/api/export.csv', async (_req, res) => {
  const file = await exportCsv();
  res.download(path.resolve(file), 'summary.csv');
});

app.post('/api/jobs', (req, res) => {
  const { benchmark, env, overrides } = req.body ?? {};
  if (![...BENCHMARKS, 'all'].includes(benchmark)) return res.status(400).json({ error: `Unknown benchmark ${benchmark}` });
  try {
    const job = jobs.start(benchmark as BenchmarkName | 'all', env || undefined, overrides ?? {});
    res.json(summary(job));
  } catch (e) {
    res.status(409).json({ error: (e as Error).message });
  }
});

app.get('/api/jobs/current', (_req, res) => {
  res.json(jobs.current ? { ...summary(jobs.current), log: jobs.current.log } : null);
});

/** Server-sent events: job lifecycle, log lines and per-second stress-test points for live charts. */
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  const onEvent = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  jobs.on('event', onEvent);
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    jobs.off('event', onEvent);
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.resolve(here, '../../../public')));
// Chart.js is served from node_modules so the demo works without internet access.
app.use('/vendor', express.static(path.resolve(here, '../../../node_modules/chart.js/dist')));

const server = app.listen(settings.port, () => {
  console.log(`9Runner demo UI: http://localhost:${settings.port}`);
  const envs = loadEnvironments();
  console.log(envs.length ? `environments: ${envs.map((e) => e.id).join(', ')}` : 'No environments configured - copy .env.example to .env');
});

process.on('SIGINT', () => {
  server.close();
  void closeAll().finally(() => process.exit(0));
});

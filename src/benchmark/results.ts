import fs from 'node:fs/promises';
import path from 'node:path';
import { settings } from '../config/settings.js';

export const BENCHMARKS = ['search', 'facets', 'aggregation', 'iwm', 'load-shedding', 'mongo8-vs-9', 'calibrate'] as const;
export type BenchmarkName = (typeof BENCHMARKS)[number];

/**
 * results/<name>.json always holds the latest run (what the UI shows);
 * results/history/<name>-<timestamp>.json keeps every run for later comparison.
 */
export async function saveResult(name: BenchmarkName, payload: object): Promise<string> {
  const dir = settings.resultsDir;
  await fs.mkdir(path.join(dir, 'history'), { recursive: true });
  const body = JSON.stringify({ benchmark: name, savedAt: new Date().toISOString(), ...payload }, null, 2);
  const latest = path.join(dir, `${name}.json`);
  await fs.writeFile(latest, body);
  await fs.writeFile(path.join(dir, 'history', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), body);
  return latest;
}

export async function loadResult(name: string): Promise<Record<string, any> | null> {
  if (!(BENCHMARKS as readonly string[]).includes(name)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(settings.resultsDir, `${name}.json`), 'utf8'));
  } catch {
    return null;
  }
}

export async function listResults() {
  const out: { name: string; savedAt: string | null }[] = [];
  for (const name of BENCHMARKS) {
    const r = await loadResult(name);
    out.push({ name, savedAt: r?.savedAt ?? null });
  }
  return out;
}

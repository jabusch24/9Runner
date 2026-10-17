import fs from 'node:fs/promises';
import path from 'node:path';
import { settings } from '../config/settings.js';
import { loadResult } from './results.js';

type Row = Record<string, string | number | boolean | null | undefined>;

const COLUMNS = [
  'benchmark', 'environment', 'server_version', 'location', 'item', 'variant', 'phase', 'matched_pct',
  'p50_ms', 'p95_ms', 'p99_ms', 'mean_ms', 'samples', 'throughput_ops_s',
  'attempted', 'accepted', 'succeeded', 'succeeded_within_slo', 'slo_compliance_pct', 'goodput_per_s',
  'rejected', 'timeouts', 'errors', 'client_dropped', 'critical_p99_ms', 'recovered_after_s', 'valid', 'notes',
];

/** One flat CSV across all saved results, for spreadsheets and slides. */
export async function exportCsv(): Promise<string> {
  const rows: Row[] = [];
  for (const name of ['search', 'facets'] as const) {
    const r = await loadResult(name);
    for (const e of r?.perEnv ?? []) {
      for (const v of e.queries ?? e.variants ?? []) {
        rows.push({
          benchmark: name, environment: e.envName, server_version: e.server?.version, location: e.server?.location, item: v.label, variant: v.id,
          p50_ms: v.latency?.p50, p95_ms: v.latency?.p95, p99_ms: v.latency?.p99, mean_ms: v.latency?.mean, samples: v.latency?.count,
          throughput_ops_s: v.throughput?.opsPerSec, notes: v.supported === false ? `unsupported: ${v.unsupportedReason}` : '',
        });
      }
    }
  }
  const agg = await loadResult('aggregation');
  for (const e of agg?.perEnv ?? []) {
    for (const q of e.queries ?? []) {
      const parityFailed = Object.entries(q.parity ?? {}).filter(([, p]: any) => !p.ok).map(([k]) => k);
      for (const v of q.variants ?? []) {
        rows.push({
          benchmark: 'aggregation', environment: e.envName, server_version: e.server?.version, location: e.server?.location, item: q.label, variant: v.label,
          matched_pct: q.matchedPct, p50_ms: v.latency?.p50, p95_ms: v.latency?.p95, p99_ms: v.latency?.p99, mean_ms: v.latency?.mean, samples: v.latency?.count,
          throughput_ops_s: v.throughput?.opsPerSec,
          notes: [v.supported === false ? `unsupported: ${v.unsupportedReason}` : '', parityFailed.length ? `parity failed: ${parityFailed.join('; ')}` : ''].filter(Boolean).join(' | '),
        });
      }
    }
  }
  for (const name of ['iwm', 'load-shedding', 'mongo8-vs-9'] as const) {
    const r = await loadResult(name);
    for (const run of r?.runs ?? []) {
      for (const [phase, s] of Object.entries<any>(run.byPhase ?? {})) {
        const crit = Object.entries<any>(s.byClass ?? {}).filter(([c]) => ['product-page', 'category-listing', 'search', 'checkout', 'inventory'].includes(c));
        rows.push({
          benchmark: name, environment: run.label, server_version: run.server?.version, location: run.server?.location, phase,
          p50_ms: s.latency?.p50, p95_ms: s.latency?.p95, p99_ms: s.latency?.p99, mean_ms: s.latency?.mean, samples: s.latency?.count,
          attempted: s.attempted, accepted: s.accepted, succeeded: s.ok, succeeded_within_slo: s.okWithinSlo, slo_compliance_pct: s.sloCompliancePct,
          goodput_per_s: s.goodputPerSec, rejected: s.rejected, timeouts: s.timeouts, errors: s.errors, client_dropped: s.clientDropped,
          critical_p99_ms: crit.length ? Math.max(...crit.map(([, v]) => v.latency?.p99 ?? 0)) : null,
          recovered_after_s: phase === 'recovery' ? run.recovery?.recoveredAfterSec : null,
          valid: run.validity?.valid, notes: (run.validity?.warnings ?? []).join(' | '),
        });
      }
    }
  }
  const esc = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => esc(r[c])).join(','))].join('\n');
  const file = path.join(settings.resultsDir, 'summary.csv');
  await fs.mkdir(settings.resultsDir, { recursive: true });
  await fs.writeFile(file, csv + '\n');
  return file;
}

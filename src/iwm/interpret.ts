import { settings } from '../config/settings.js';
import type { OutcomeSummary, StressRun } from './stressTest.js';

/**
 * Turn measured numbers into sentences. Every statement is conditional on
 * the data - nothing here assumes MongoDB 9 wins. Differences under
 * SIMILAR_PCT are reported as "similar".
 */
const SIMILAR_PCT = 15;
/** Latency differences smaller than this are noise at any percentage. */
const SIMILAR_ABS_MS = 5;

export type RunRow = {
  label: string;
  envId: string;
  retryMode: string;
  version: string | null;
  phase: string;
  attempted: number;
  accepted: number;
  succeeded: number;
  succeededWithinSlo: number;
  rejected: number;
  timeouts: number;
  errors: number;
  clientDropped: number;
  serverRejectedAttempts: number;
  sloCompliancePct: number | null;
  goodputPerSec: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  criticalP99: number | null;
  heavyP99: number | null;
  recoveredAfterSec: number | null;
  canaryP50: number | null;
  canaryMax: number | null;
  canaryFailures: number;
  peakCpuPct: number | null;
  peakConnections: number | null;
  valid: boolean;
  overloadReached: boolean;
};

const CRITICAL = ['product-page', 'category-listing', 'search', 'checkout', 'inventory'];

function classP99(s: OutcomeSummary & { byClass?: Record<string, OutcomeSummary> }, critical: boolean) {
  const vals = Object.entries(s.byClass ?? {}).filter(([c]) => CRITICAL.includes(c) === critical).map(([, v]) => v.latency.p99 ?? 0);
  return vals.length ? Math.max(...vals) : null;
}

export function summaryRows(runs: StressRun[], phaseName = 'overload'): RunRow[] {
  return runs.map((r) => {
    const s = r.byPhase[phaseName] ?? Object.values(r.byPhase).at(-1)!;
    const canary = r.canary[phaseName] ?? { p50: null, maxMs: null, failures: 0 };
    return {
      label: r.label, envId: r.envId, retryMode: r.retryMode, version: r.server.version, phase: phaseName,
      attempted: s.attempted, accepted: s.accepted, succeeded: s.ok, succeededWithinSlo: s.okWithinSlo,
      rejected: s.rejected, timeouts: s.timeouts, errors: s.errors, clientDropped: s.clientDropped, serverRejectedAttempts: s.serverRejectedAttempts,
      sloCompliancePct: s.sloCompliancePct, goodputPerSec: s.goodputPerSec, p50: s.latency.p50, p95: s.latency.p95, p99: s.latency.p99,
      criticalP99: classP99(s, true), heavyP99: classP99(s, false),
      recoveredAfterSec: r.recovery.recoveredAfterSec, canaryP50: canary.p50, canaryMax: canary.maxMs, canaryFailures: canary.failures,
      peakCpuPct: r.serverPeaks.cpuPct, peakConnections: r.serverPeaks.connections, valid: r.validity.valid, overloadReached: r.validity.overloadReached,
    };
  });
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
const ms = (v: number | null) => (v == null ? 'n/a' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

function relDiff(a: number | null, b: number | null): number | null {
  if (a == null || b == null || (a === 0 && b === 0)) return null;
  return ((b - a) / Math.max(Math.abs(a), 1e-9)) * 100;
}

function compareWord(baseLabel: string, candLabel: string, metric: string, a: number | null, b: number | null, lowerIsBetter: boolean, unit: (v: number | null) => string, absFloor = 0) {
  if (a == null || b == null) return `${metric}: not measured for both runs (${baseLabel} ${unit(a)}, ${candLabel} ${unit(b)}).`;
  if (a === 0 || b === 0) {
    if (a === b) return `${metric}: zero for both ${baseLabel} and ${candLabel}.`;
    const better = lowerIsBetter ? b < a : b > a;
    return `${metric}: ${candLabel} ${unit(b)} vs ${baseLabel} ${unit(a)} (${better ? 'better' : 'worse'}).`;
  }
  const d = relDiff(a, b)!;
  if (Math.abs(d) < SIMILAR_PCT || Math.abs(b - a) < absFloor) return `${metric} is similar (${baseLabel} ${unit(a)}, ${candLabel} ${unit(b)}).`;
  const better = lowerIsBetter ? d < 0 : d > 0;
  return `${metric}: ${candLabel} ${unit(b)} vs ${baseLabel} ${unit(a)} (${better ? 'better' : 'worse'} by ${Math.abs(Math.round(d))}%).`;
}

export function interpretStress(runs: StressRun[], context: 'iwm' | 'load-shedding' | 'mongo8-vs-9'): { headline: string[]; details: string[]; ecommerce: string[]; caveats: string[] } {
  const headline: string[] = [];
  const details: string[] = [];
  const caveats: string[] = [];
  if (runs.length === 0) return { headline: ['No runs.'], details, ecommerce: [], caveats };

  for (const r of runs) {
    if (!r.validity.valid) caveats.push(`${r.label}: run is CLIENT-BOUND - the load generator, not the database, limited the result. Do not draw conclusions from it.`);
    if (!r.validity.overloadReached) caveats.push(`${r.label}: overload was not reached, so this run says nothing about overload protection (only about normal operation).`);
  }

  const overload = summaryRows(runs, 'overload');
  const firstPhase = runs[0].schedule.phases[0]?.name ?? 'baseline';
  const normal = summaryRows(runs, firstPhase);
  const [base, ...rest] = overload;

  // 1. Normal traffic
  for (let i = 1; i < normal.length; i++) {
    details.push(`Normal traffic ("${firstPhase}"): ${compareWord(normal[0].label, normal[i].label, 'p95 latency', normal[0].p95, normal[i].p95, true, ms, SIMILAR_ABS_MS)}`);
  }

  // 2. Overload: the accepted / successful / within-SLO distinction
  for (const r of overload) {
    details.push(`${r.label} during overload: ${r.attempted.toLocaleString()} attempted → ${r.accepted.toLocaleString()} accepted (${pct(r.accepted, r.attempted)}%) → ${r.succeeded.toLocaleString()} succeeded → ${r.succeededWithinSlo.toLocaleString()} within ${settings.sloMs} ms (${r.sloCompliancePct ?? 0}%). Rejected ${r.rejected.toLocaleString()}, timed out ${r.timeouts.toLocaleString()}, other errors ${r.errors.toLocaleString()}${r.serverRejectedAttempts ? `, server rejections absorbed by driver retries ${r.serverRejectedAttempts.toLocaleString()}` : ''}.`);
  }

  for (const c of rest) {
    headline.push(compareWord(base.label, c.label, 'Goodput (requests/s completed within SLO) during overload', base.goodputPerSec, c.goodputPerSec, false, (v) => (v == null ? 'n/a' : `${Math.round(v)}/s`)));
    headline.push(compareWord(base.label, c.label, 'Critical-path p99 (product page, listing, search, checkout, inventory) during overload', base.criticalP99, c.criticalP99, true, ms, SIMILAR_ABS_MS));
    if (base.recoveredAfterSec !== c.recoveredAfterSec) {
      const f = (v: number | null) => (v == null ? 'did not recover within the recovery window' : `recovered ${v} s after load dropped`);
      headline.push(`Recovery: ${base.label} ${f(base.recoveredAfterSec)}; ${c.label} ${f(c.recoveredAfterSec)}.`);
    } else {
      headline.push(`Recovery: both ${base.recoveredAfterSec == null ? 'did not recover within the recovery window' : `recovered after ${base.recoveredAfterSec} s`}.`);
    }
    if (c.rejected > 0 || base.rejected > 0) {
      headline.push(`Rejections: ${base.label} rejected ${pct(base.rejected, base.attempted)}% of requests, ${c.label} ${pct(c.rejected, c.attempted)}%. A rejected request failed fast and can be retried with backoff; compare that with timeouts (${pct(base.timeouts, base.attempted)}% vs ${pct(c.timeouts, c.attempted)}%), which held a connection for ${settings.opTimeoutMs / 1000} s before failing.`);
    }
    details.push(`Canary product-page reads during overload: ${base.label} p50 ${ms(base.canaryP50)} / max ${ms(base.canaryMax)} / ${base.canaryFailures} failures; ${c.label} p50 ${ms(c.canaryP50)} / max ${ms(c.canaryMax)} / ${c.canaryFailures} failures.`);
  }

  const versions = new Set(runs.map((r) => r.server.major));
  if (context !== 'load-shedding' && versions.size > 1) {
    const allSimilar = rest.every((c) => {
      const g = relDiff(base.goodputPerSec, c.goodputPerSec);
      const p = relDiff(base.criticalP99, c.criticalP99);
      return (g == null || Math.abs(g) < SIMILAR_PCT) && (p == null || Math.abs(p) < SIMILAR_PCT);
    });
    if (allSimilar) {
      headline.push('MongoDB 8 and 9 behaved similarly in this run. That is a legitimate outcome: 8.x already ships throughput-probing execution control, heuristic deprioritization of long-running operations and (8.0.20+/8.2+) an ingress request rate limiter. The 9.0/Atlas-specific part is the adaptive, Atlas-managed tuning of those limits plus optional Load Shedding - a workload that never saturates the cluster, or saturates it with uniform cheap operations, does not exercise it.');
    }
    for (const r of runs) {
      const ing = r.server.ingressRateLimiter as Record<string, unknown> | null | undefined;
      if (ing) details.push(`${r.label} (${r.server.version}): ingress request rate limiter enabled=${String(ing.enabled ?? 'unknown')}, admission rate ${String(ing.admissionRatePerSec ?? 'n/a')}/s, max queue depth ${String(ing.maxQueueDepth ?? 'n/a')}.`);
    }
  }

  const ecommerce = ecommerceNarrative(overload, normal, context);
  return { headline, details, ecommerce, caveats };
}

function ecommerceNarrative(overload: RunRow[], normal: RunRow[], context: string): string[] {
  const lines: string[] = [];
  const normalSimilar = normal.length > 1 && normal.slice(1).every((n) => {
    const d = relDiff(normal[0].p95, n.p95);
    return d == null || Math.abs(d) < SIMILAR_PCT || Math.abs((n.p95 ?? 0) - (normal[0].p95 ?? 0)) < SIMILAR_ABS_MS;
  });
  lines.push(normalSimilar
    ? 'During normal traffic the deployments are indistinguishable for shoppers - workload management only matters when demand exceeds capacity.'
    : 'Even during normal traffic latency differed between deployments; check tier/region/version before attributing this to workload management.');
  const best = overload.slice().sort((a, b) => (b.goodputPerSec ?? 0) - (a.goodputPerSec ?? 0))[0];
  if (best) lines.push(`During the spike, ${best.label} served the most shoppers within the ${settings.sloMs} ms SLO (${Math.round(best.goodputPerSec ?? 0)} requests/s). That - not the number of accepted requests - is what converts into revenue.`);
  const shedder = overload.find((r) => r.rejected > 0);
  if (shedder) {
    lines.push(`${shedder.label} turned away ${pct(shedder.rejected, shedder.attempted)}% of requests during the spike. For a store with retry/backoff in the client (or a "please try again" page for the product-listing API) a fast rejection is cheaper than a request that hangs: the checkout path stays responsive and the backlog doesn't spill into the recovery period.`);
  } else if (context === 'load-shedding') {
    lines.push('No requests were rejected: either Load Shedding was not effectively enabled (check "Effective state" in the Atlas UI; M10/M20 never shed) or the overload was not sustained/severe enough to trigger it.');
  }
  const noRecovery = overload.filter((r) => r.recoveredAfterSec == null);
  if (noRecovery.length) lines.push(`${noRecovery.map((r) => r.label).join(', ')} still had not recovered by the end of the run: queued work kept the site slow after the traffic spike was over - the "long tail" of an incident.`);
  return lines;
}

import { DemoEnvironment, EnvironmentId } from '../config/environments.js';
import { num, settings, str } from '../config/settings.js';
import { fetchAtlasMetrics } from '../metrics/atlasApi.js';
import { RetryMode } from '../utils/mongo.js';
import { EmulationMode, setLocalEmulation } from './localEmulation.js';
import { interpretStress, summaryRows } from './interpret.js';
import { calibrationSchedule, defaultComparisonSchedule, defaultOverloadSchedule, Schedule } from './schedule.js';
import { ProgressEvent, runStressTest, StressRun } from './stressTest.js';

type Log = (m: string) => void;
type Progress = (e: ProgressEvent) => void;

export const IWM_DEFAULT_ENVS: EnvironmentId[] = ['mongo8', 'mongo9', 'mongo9iwm', 'mongo9iwmls'];
export const LS_DEFAULT_ENVS: EnvironmentId[] = ['mongo9iwm', 'mongo9iwmls'];
export const V8V9_DEFAULT_ENVS: EnvironmentId[] = ['mongo8', 'mongo9', 'mongo9iwm'];

type PlanItem = { env: DemoEnvironment; label: string; retryMode: RetryMode; emulation?: EmulationMode };

async function runSequence(plan: PlanItem[], schedule: Schedule, log: Log, onProgress?: Progress): Promise<StressRun[]> {
  const runs: StressRun[] = [];
  for (let i = 0; i < plan.length; i++) {
    const { env, label, retryMode, emulation } = plan[i];
    if (i > 0 && settings.cooldownSeconds > 0) {
      log(`cooling down ${settings.cooldownSeconds}s so queued work from the previous run doesn't leak into the next`);
      await new Promise((r) => setTimeout(r, settings.cooldownSeconds * 1000));
    }
    if (emulation) await setLocalEmulation(env, emulation, log);
    const run = await runStressTest(env, { label, schedule, retryMode, log, onProgress });
    if (emulation) await setLocalEmulation(env, 'off', log);
    run.atlasMetrics = await fetchAtlasMetrics(env, new Date(run.startedAt), run.durationSec, log).catch((e) => ({ error: (e as Error).message }));
    runs.push(run);
    const o = run.byPhase['overload'] ?? Object.values(run.byPhase).at(-1)!;
    log(`[${env.id}] done: ${o.attempted} attempted, ${o.ok} ok (${o.sloCompliancePct}% within SLO), ${o.rejected} rejected, ${o.timeouts} timeouts, ${o.errors} errors in the overload phase`);
  }
  return runs;
}

function retryModesFor(spec: string | undefined, fallback: RetryMode[]): RetryMode[] {
  if (!spec) return fallback;
  return spec.split(',').map((s) => s.trim() as RetryMode).filter((m) => ['none', 'driver', 'app'].includes(m));
}

function report(runs: StressRun[], context: 'iwm' | 'load-shedding' | 'mongo8-vs-9', schedule: Schedule) {
  return {
    schedule,
    sloMs: settings.sloMs,
    runs,
    summary: { overload: summaryRows(runs, 'overload'), baseline: summaryRows(runs, schedule.phases[0]?.name ?? 'baseline') },
    interpretation: interpretStress(runs, context),
  };
}

const EMULATION_LABEL: Record<EmulationMode, string> = { off: 'no limiter', queue: 'IWM-style queueing', shed: 'Load-Shedding-style rejection' };

/**
 * With only the local environment selected, run it once per emulation mode
 * (LOCAL_EMULATION_MODES) so the full comparison can be rehearsed offline.
 */
function expandLocal(envs: DemoEnvironment[], modes: EmulationMode[], retryMode: RetryMode): PlanItem[] | null {
  if (envs.length !== 1 || !envs[0].emulation) return null;
  const configured = str('LOCAL_EMULATION_MODES', '').split(',').map((s) => s.trim()).filter(Boolean) as EmulationMode[];
  return (configured.length ? configured : modes).map((m) => ({ env: envs[0], retryMode, emulation: m, label: `Local ${envs[0].name.replace(/^Local\s*/, '')} · EMULATED ${EMULATION_LABEL[m]}` }));
}

/** Demo Part E: same overload profile against 8, 9, 9+IWM, 9+IWM+LS. */
export async function benchmarkIwm(envs: DemoEnvironment[], log: Log, onProgress?: Progress) {
  const schedule = defaultOverloadSchedule();
  const mode = settings.clientRetryMode;
  const plan = expandLocal(envs, ['off', 'queue', 'shed'], mode) ?? envs.map((env) => ({ env, label: env.name, retryMode: mode }));
  const runs = await runSequence(plan, schedule, log, onProgress);
  return report(runs, 'iwm', schedule);
}

/**
 * Demo Part F: IWM with vs without Load Shedding, each with a client that does
 * not retry ("what the server did") and one that retries with backoff
 * ("what a well-behaved application experiences").
 */
export async function benchmarkLoadShedding(envs: DemoEnvironment[], log: Log, onProgress?: Progress) {
  const schedule = defaultOverloadSchedule();
  const modes = retryModesFor(process.env.LS_RETRY_MODES, ['none', 'app']);
  const retryLabel = (m: RetryMode) => (m === 'none' ? 'no retries' : m === 'app' ? 'retry + backoff' : 'driver retries');
  const local = expandLocal(envs, ['queue', 'shed'], 'none');
  const plan = local
    ? local.flatMap((p) => modes.map((m) => ({ ...p, retryMode: m, label: `${p.label} · ${retryLabel(m)}` })))
    : envs.flatMap((env) => modes.map((m) => ({ env, retryMode: m, label: `${env.name} · ${retryLabel(m)}` })));
  const runs = await runSequence(plan, schedule, log, onProgress);
  return report(runs, 'load-shedding', schedule);
}

/** Demo Part D: realistic steady mix plus one spike, MongoDB 8 vs 9. */
export async function benchmarkMongo8vs9(envs: DemoEnvironment[], log: Log, onProgress?: Progress) {
  const schedule = defaultComparisonSchedule();
  const runs = await runSequence(envs.map((env) => ({ env, label: env.name, retryMode: settings.clientRetryMode })), schedule, log, onProgress);
  return report(runs, 'mongo8-vs-9', schedule);
}

/**
 * Find the knee: double the request rate every step and watch where goodput
 * stops growing or critical latency breaks the SLO. Suggests BASE/PEAK_RPS
 * for the overload tests, because the right numbers depend entirely on tier,
 * dataset size and workload mix.
 */
export async function calibrate(env: DemoEnvironment, log: Log, onProgress?: Progress) {
  const schedule = calibrationSchedule();
  const run = await runStressTest(env, { label: `${env.name} calibration`, schedule, retryMode: 'none', log, onProgress });
  const steps = schedule.phases.map((p) => {
    const s = run.byPhase[p.name];
    const crit = Object.entries(s?.byClass ?? {}).filter(([c]) => ['product-page', 'category-listing', 'checkout', 'inventory', 'search'].includes(c));
    return {
      step: p.name,
      targetRps: p.rpsStart,
      achievedRps: s ? Math.round(s.attempted / p.durationSec) : 0,
      goodputPerSec: s?.goodputPerSec ?? 0,
      p95: s?.latency.p95 ?? null,
      criticalP95: crit.length ? Math.max(...crit.map(([, v]) => v.latency.p95 ?? 0)) : null,
      failurePct: s && s.attempted ? Math.round(((s.rejected + s.timeouts + s.errors + s.clientDropped) / s.attempted) * 1000) / 10 : 0,
    };
  });
  let knee = steps.findIndex((s, i) => (s.criticalP95 ?? 0) > settings.sloMs || s.failurePct > 1 || (i > 0 && s.goodputPerSec < steps[i - 1].goodputPerSec * 1.3));
  if (knee === -1) knee = steps.length - 1;
  const kneeRps = steps[Math.max(0, knee - 1)].targetRps;
  const suggestion = {
    BASE_RPS: Math.max(50, Math.round(kneeRps * 0.5)),
    PEAK_RPS: Math.round(kneeRps * num('CALIBRATE_OVERLOAD_FACTOR', 3)),
    note: knee === steps.length - 1 && steps[knee].failurePct <= 1 && (steps[knee].criticalP95 ?? 0) <= settings.sloMs
      ? 'The cluster never saturated - raise CALIBRATE_MAX_RPS, add WORKERS/load generators, or increase the heavy-report share.'
      : `Saturation starts around ${steps[knee].targetRps} req/s. The suggested PEAK_RPS overloads by ~${num('CALIBRATE_OVERLOAD_FACTOR', 3)}x the last healthy step.`,
  };
  log(`calibration: ${suggestion.note} Suggested BASE_RPS=${suggestion.BASE_RPS} PEAK_RPS=${suggestion.PEAK_RPS}`);
  return { env: env.id, steps, suggestion, run };
}

export function stressBenchmarkDefaults() {
  return {
    sloMs: settings.sloMs,
    baseRps: num('BASE_RPS', 1000),
    peakRps: num('PEAK_RPS', 8000),
    workers: settings.workers,
    retryMode: settings.clientRetryMode,
    mix: str('WORKLOAD_MIX', ''),
  };
}

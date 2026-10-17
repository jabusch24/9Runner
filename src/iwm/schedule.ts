import { num, str } from '../config/settings.js';

export type PhaseKind = 'baseline' | 'ramp' | 'overload' | 'recovery' | 'step' | 'steady';

export type Phase = {
  name: string;
  kind: PhaseKind;
  durationSec: number;
  rpsStart: number;
  rpsEnd: number;
  /** seconds since run start */
  startSec: number;
  endSec: number;
};

export type Schedule = { phases: Phase[]; totalSec: number; overloadStartSec: number | null; overloadEndSec: number | null };

/**
 * LOAD_PHASES="baseline:30:1000,ramp:30:1000-8000,overload:60:8000,recovery:30:1000"
 *   name:durationSeconds:rps or rpsStart-rpsEnd (linear ramp)
 *   The phase name doubles as its kind when it is one of the known kinds.
 * RAMP_STEPS="2000,4000,8000" turns the ramp into a staircase (each step RAMP_SECONDS / n).
 */
export function parseSchedule(spec: string): Schedule {
  const phases: Phase[] = [];
  let t = 0;
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, dur, rps] = part.split(':');
    const durationSec = Number(dur);
    const [a, b] = rps.split('-').map(Number);
    if (!name || !Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(a)) {
      throw new Error(`Bad phase "${part}" - expected name:seconds:rps or name:seconds:rpsStart-rpsEnd`);
    }
    const kind = (['baseline', 'ramp', 'overload', 'recovery', 'step', 'steady'].includes(name.replace(/-\d+$/, '')) ? name.replace(/-\d+$/, '') : 'step') as PhaseKind;
    phases.push({ name, kind, durationSec, rpsStart: a, rpsEnd: Number.isFinite(b) ? b : a, startSec: t, endSec: t + durationSec });
    t += durationSec;
  }
  const overload = phases.filter((p) => p.kind === 'overload');
  return {
    phases,
    totalSec: t,
    overloadStartSec: overload.length ? overload[0].startSec : null,
    overloadEndSec: overload.length ? overload[overload.length - 1].endSec : null,
  };
}

/** The IWM profile: normal traffic, a ramp, sustained overload, then recovery. */
export function defaultOverloadSchedule(): Schedule {
  const custom = process.env.LOAD_PHASES;
  if (custom) return parseSchedule(custom);
  const base = num('BASE_RPS', 1000);
  const peak = num('PEAK_RPS', 8000);
  const baseline = num('BASELINE_SECONDS', 30);
  const ramp = num('RAMP_SECONDS', 30);
  const overload = num('OVERLOAD_SECONDS', 60);
  const recovery = num('RECOVERY_SECONDS', 30);
  const steps = str('RAMP_STEPS', '').split(',').map(Number).filter((x) => x > 0);
  const parts = [`baseline:${baseline}:${base}`];
  if (steps.length) {
    const each = Math.max(1, Math.round(ramp / steps.length));
    steps.forEach((s, i) => parts.push(`ramp-${i + 1}:${each}:${s}`));
  } else if (ramp > 0) {
    parts.push(`ramp:${ramp}:${base}-${peak}`);
  }
  parts.push(`overload:${overload}:${peak}`, `recovery:${recovery}:${base}`);
  return parseSchedule(parts.join(','));
}

/** The 8 vs 9 profile: realistic steady traffic followed by a traffic spike. */
export function defaultComparisonSchedule(): Schedule {
  const custom = process.env.COMPARISON_PHASES;
  if (custom) return parseSchedule(custom);
  const base = num('BASE_RPS', 1000);
  const peak = num('PEAK_RPS', 8000);
  return parseSchedule(`steady:${num('STEADY_SECONDS', 60)}:${base},overload:${num('OVERLOAD_SECONDS', 60)}:${peak},recovery:${num('RECOVERY_SECONDS', 30)}:${base}`);
}

/** Calibration: a staircase that keeps doubling until the cluster saturates. */
export function calibrationSchedule(): Schedule {
  const start = num('CALIBRATE_START_RPS', 250);
  const max = num('CALIBRATE_MAX_RPS', 32_000);
  const stepSec = num('CALIBRATE_STEP_SECONDS', 20);
  const parts: string[] = [];
  let i = 1;
  for (let r = start; r <= max; r *= 2) parts.push(`step-${i++}:${stepSec}:${r}`);
  return parseSchedule(parts.join(','));
}

export function rpsAt(schedule: Schedule, tSec: number): number {
  for (const p of schedule.phases) {
    if (tSec < p.endSec) return p.rpsStart + (p.rpsEnd - p.rpsStart) * ((tSec - p.startSec) / p.durationSec);
  }
  return 0;
}

/** Number of requests that should have been issued by time t (integral of rps). */
export function expectedCount(schedule: Schedule, tSec: number): number {
  let total = 0;
  for (const p of schedule.phases) {
    if (tSec <= p.startSec) break;
    const d = Math.min(tSec, p.endSec) - p.startSec;
    const rEnd = p.rpsStart + (p.rpsEnd - p.rpsStart) * (d / p.durationSec);
    total += ((p.rpsStart + rEnd) / 2) * d;
  }
  return total;
}

export function phaseAt(schedule: Schedule, tSec: number): Phase | undefined {
  return schedule.phases.find((p) => tSec >= p.startSec && tSec < p.endSec);
}

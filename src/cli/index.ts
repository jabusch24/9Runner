#!/usr/bin/env node
import { getEnvironment, selectEnvironments } from '../config/environments.js';
import { settings } from '../config/settings.js';
import { exportCsv } from '../benchmark/csv.js';
import { probe, runBenchmark } from '../benchmark/jobs.js';
import { BENCHMARKS, BenchmarkName } from '../benchmark/results.js';
import { EmulationMode, setLocalEmulation } from '../iwm/localEmulation.js';
import type { ProgressEvent } from '../iwm/stressTest.js';
import { ensureSearchIndex } from '../search/indexDefinition.js';
import { seedEnvironment } from '../seed/seed.js';
import { closeAll, getDb } from '../utils/mongo.js';

const HELP = `9Runner - MongoDB 8 vs 9: IWM, Load Shedding and Search facet aggregations

Usage: npm run <script> [-- --env <ids> --<setting> <value> ...]

  probe                       what each environment really is (version, limiter, index, facet aggs)
  seed                        generate the e-commerce dataset (+ indexes + Search index)
  search-index                create/update the Search index only
  benchmark <name>            ${[...BENCHMARKS.filter((b) => b !== 'calibrate'), 'all'].join(' | ')}
  calibrate                   find the request rate where a cluster saturates
  local-emulation <mode>      off | queue | shed   (local 8.3+ container only)
  export-csv                  results/*.json -> results/summary.csv

Environments (--env): mongo8, mongo9, mongo9iwm, mongo9iwmls, local, all
Any setting can be passed as a flag: --peak-rps 6000 is the same as PEAK_RPS=6000.`;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=');
      const v = inline ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
      flags[k] = v;
    } else positional.push(a);
  }
  // --peak-rps 6000 -> PEAK_RPS=6000 (everything reads settings from the environment)
  for (const [k, v] of Object.entries(flags)) if (k !== 'env') process.env[k.replace(/-/g, '_').toUpperCase()] = v;
  return { positional, env: flags.env };
}

const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

let lastPrint = 0;
function printProgress(e: ProgressEvent) {
  const p = e.point;
  if (Date.now() - lastPrint < 4_000 && p.sec % 10 !== 0) return;
  lastPrint = Date.now();
  const s = p.server;
  const srv = s?.ok ? ` | srv cpu ${s.cpuPct ?? '?'}% conns ${s.connections} q ${(s.executionQueue?.readQueued ?? 0) + (s.executionQueue?.writeQueued ?? 0)} ingress-rej ${s.ingress?.rejected ?? '-'} canary p50 ${s.canary?.p50 ?? '-'}ms` : s ? ' | srv poll failed' : '';
  log(`  [${e.envId}] t=${String(p.sec).padStart(3)}s/${e.totalSec} ${p.phase.padEnd(9)} target ${String(p.targetRps).padStart(6)}/s sent ${String(p.attempted).padStart(6)} ok ${String(p.ok).padStart(6)} (<SLO ${String(p.okWithinSlo).padStart(6)}) rej ${p.rejected} t/o ${p.timeouts} err ${p.errors} | p95 ${p.p95 ?? '-'}ms crit-p95 ${p.criticalP95 ?? '-'}ms${srv}`);
}

async function main() {
  const { positional, env } = parseArgs(process.argv.slice(2));
  const [cmd, arg] = positional;
  switch (cmd) {
    case 'probe':
      await probe(env, log);
      break;
    case 'seed': {
      const envs = selectEnvironments(env ?? 'all', []);
      for (const e of envs) await seedEnvironment(e, log, { skipSearchIndex: process.env.SKIP_SEARCH_INDEX === 'true' });
      break;
    }
    case 'search-index': {
      for (const e of selectEnvironments(env ?? 'all', [])) {
        const db = await getDb(e, 'seed');
        await ensureSearchIndex(db.collection('products'), settings.searchIndexName, (m) => log(`[${e.id}] ${m}`)).catch((err) => log(`[${e.id}] ${(err as Error).message}`));
      }
      break;
    }
    case 'benchmark': {
      if (!arg || ![...BENCHMARKS, 'all'].includes(arg)) throw new Error(`benchmark needs one of: ${[...BENCHMARKS, 'all'].join(', ')}`);
      await runBenchmark(arg as BenchmarkName | 'all', env, log, printProgress);
      log('Next: npm run export:csv, or npm run demo to see charts');
      break;
    }
    case 'calibrate':
      await runBenchmark('calibrate', env, log, printProgress);
      break;
    case 'local-emulation': {
      if (!['off', 'queue', 'shed'].includes(arg)) throw new Error('local-emulation needs off | queue | shed');
      await setLocalEmulation(getEnvironment(env ?? 'local'), arg as EmulationMode, log);
      break;
    }
    case 'export-csv':
      log(`wrote ${await exportCsv()}`);
      break;
    default:
      console.log(HELP);
  }
}

main()
  .catch((e) => {
    console.error(`\nERROR: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => closeAll());

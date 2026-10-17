import { MongoClient } from 'mongodb';
import { DemoEnvironment } from '../config/environments.js';
import { num } from '../config/settings.js';

/**
 * LOCAL ONLY. Emulates the two IWM behaviours on a self-managed 8.3+ server
 * (e.g. the mongodb-atlas-local container) with *static* server parameters:
 *
 *   queue - ingress rate limiter with a deep queue: excess requests wait
 *           (like IWM's always-on queueing)
 *   shed  - same rate, shallow queue: excess requests are rejected with
 *           SystemOverloadedError (like Load Shedding)
 *   off   - limiter effectively unlimited (the default)
 *
 * Atlas IWM tunes the admission rate adaptively from CPU, queue depth and
 * latency; a fixed rate is a stand-in to rehearse the demo and validate the
 * harness, not a reproduction of Atlas behaviour. Results are labelled.
 */
export type EmulationMode = 'off' | 'queue' | 'shed';

const UNLIMITED = 2147483647;
const EXEMPT_APPS = ['9runner-monitor', '9runner-admin', '9runner-seed', '9runner-demo', '9runner-bench'];

export async function setLocalEmulation(env: DemoEnvironment, mode: EmulationMode, log: (m: string) => void) {
  if (!env.emulation) throw new Error(`Emulation is only allowed on the "local" environment (got ${env.id}).`);
  const rate = num('EMULATION_RATE_PER_SEC', 1500);
  const burstSecs = num('EMULATION_BURST_SECONDS', 1);
  const queueDepth = mode === 'queue' ? num('EMULATION_QUEUE_DEPTH', 100_000) : num('EMULATION_SHED_QUEUE_DEPTH', 50);
  const client = new MongoClient(env.uri, { appName: '9runner-admin', serverSelectionTimeoutMS: 5_000 });
  await client.connect();
  const admin = client.db('admin');
  try {
    // Exempt tooling first so the monitor/UI keep working while the limiter is tight.
    await admin.command({ setParameter: 1, ingressRequestRateLimiterApplicationExemptions: { appNames: EXEMPT_APPS } });
    if (mode === 'off') {
      await admin.command({ setParameter: 1, ingressRequestAdmissionRatePerSec: UNLIMITED });
      await admin.command({ setParameter: 1, ingressRequestAdmissionBurstCapacitySecs: Number.MAX_VALUE });
    } else {
      await admin.command({ setParameter: 1, ingressRequestRateLimiterEnabled: true });
      await admin.command({ setParameter: 1, ingressRequestAdmissionMaxQueueDepth: queueDepth });
      await admin.command({ setParameter: 1, ingressRequestAdmissionBurstCapacitySecs: burstSecs });
      await admin.command({ setParameter: 1, ingressRequestAdmissionRatePerSec: rate });
    }
    const p = await admin.command({ getParameter: 1, ingressRequestRateLimiterEnabled: 1, ingressRequestAdmissionRatePerSec: 1, ingressRequestAdmissionMaxQueueDepth: 1, ingressRequestAdmissionBurstCapacitySecs: 1 });
    log(`local emulation "${mode}": rate=${p.ingressRequestAdmissionRatePerSec}/s burst=${p.ingressRequestAdmissionBurstCapacitySecs}s maxQueueDepth=${p.ingressRequestAdmissionMaxQueueDepth} (exempt: ${EXEMPT_APPS.join(', ')})`);
  } catch (e) {
    throw new Error(`Could not set ingress limiter parameters (needs MongoDB 8.3+ self-managed with setParameter privileges): ${(e as Error).message}`);
  } finally {
    await client.close();
  }
}

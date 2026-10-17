import { DemoEnvironment } from '../config/environments.js';
import { str } from '../config/settings.js';

/**
 * OPTIONAL: pull host metrics for the run window from the Atlas
 * Administration API, to complement serverStatus (Atlas has CPU steal,
 * normalized CPU, disk and its own IWM charts). Needs a service account:
 *   ATLAS_CLIENT_ID, ATLAS_CLIENT_SECRET, ATLAS_GROUP_ID
 * and per environment MONGO_<X>_ATLAS_CLUSTER=<cluster name>.
 * Missing configuration just skips this step.
 */
const BASE = 'https://cloud.mongodb.com';
const DEFAULT_MEASUREMENTS = [
  'PROCESS_NORMALIZED_CPU_USER',
  'SYSTEM_NORMALIZED_CPU_USER',
  'SYSTEM_NORMALIZED_CPU_STEAL',
  'CONNECTIONS',
  'OPCOUNTER_QUERY',
  'OPCOUNTER_INSERT',
  'OPCOUNTER_UPDATE',
  'OP_EXECUTION_TIME_READS',
  'OP_EXECUTION_TIME_WRITES',
  'QUERY_TARGETING_SCANNED_OBJECTS_PER_RETURNED',
];

let cachedToken: { token: string; expires: number } | null = null;

async function token(): Promise<string | null> {
  const id = process.env.ATLAS_CLIENT_ID;
  const secret = process.env.ATLAS_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const res = await fetch(`${BASE}/api/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Atlas token request failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expires: Date.now() + body.expires_in * 1000 };
  return cachedToken.token;
}

async function api(path: string, accept: string) {
  const t = await token();
  const res = await fetch(`${BASE}/api/atlas/v2${path}`, { headers: { Authorization: `Bearer ${t}`, Accept: accept } });
  if (!res.ok) throw new Error(`${res.status} ${path}: ${(await res.text()).slice(0, 300)}`);
  return res.json() as Promise<any>;
}

export async function describeAtlasCluster(env: DemoEnvironment) {
  const group = process.env.ATLAS_GROUP_ID;
  if (!env.atlasClusterName || !group || !(await token())) return null;
  const c = await api(`/groups/${group}/clusters/${encodeURIComponent(env.atlasClusterName)}`, 'application/vnd.atlas.2024-08-05+json');
  const region = c.replicationSpecs?.[0]?.regionConfigs?.[0];
  return {
    name: c.name,
    mongoDBVersion: c.mongoDBVersion,
    versionReleaseSystem: c.versionReleaseSystem,
    clusterType: c.clusterType,
    instanceSize: region?.electableSpecs?.instanceSize,
    provider: region?.providerName,
    region: region?.regionName,
    nodeCount: region?.electableSpecs?.nodeCount,
  };
}

export async function fetchAtlasMetrics(env: DemoEnvironment, start: Date, durationSec: number, log: (m: string) => void) {
  const group = process.env.ATLAS_GROUP_ID;
  if (!env.atlasClusterName || !group || !process.env.ATLAS_CLIENT_ID) return null;
  const cluster = await describeAtlasCluster(env).catch((e) => ({ error: (e as Error).message }));
  const processes = await api(`/groups/${group}/processes?itemsPerPage=500`, 'application/vnd.atlas.2023-01-01+json');
  const prefix = env.atlasClusterName.toLowerCase();
  const primary = (processes.results as any[]).find((p) => p.hostname?.toLowerCase().startsWith(prefix) && p.typeName === 'REPLICA_PRIMARY');
  if (!primary) {
    log(`[${env.id}] Atlas metrics: no primary process found for cluster "${env.atlasClusterName}"`);
    return { cluster, error: 'primary not found' };
  }
  const measurements = str('ATLAS_MEASUREMENTS', DEFAULT_MEASUREMENTS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  const end = new Date(start.getTime() + (durationSec + 30) * 1000);
  const granularity = str('ATLAS_GRANULARITY', 'PT10S');
  const query = (ms: string[]) => `/groups/${group}/processes/${encodeURIComponent(primary.id)}/measurements?granularity=${granularity}&start=${new Date(start.getTime() - 30_000).toISOString()}&end=${end.toISOString()}&${ms.map((m) => `m=${m}`).join('&')}`;
  let series: any[] = [];
  try {
    series = (await api(query(measurements), 'application/vnd.atlas.2023-01-01+json')).measurements;
  } catch {
    // One unknown measurement name fails the whole request; fall back to one by one.
    for (const m of measurements) {
      try {
        series.push(...(await api(query([m]), 'application/vnd.atlas.2023-01-01+json')).measurements);
      } catch (e) {
        log(`[${env.id}] Atlas metric ${m} unavailable: ${(e as Error).message.slice(0, 120)}`);
      }
    }
  }
  log(`[${env.id}] Atlas metrics: ${series.length} series for ${primary.id}`);
  return { cluster, process: primary.id, granularity, series: series.map((s) => ({ name: s.name, units: s.units, points: s.dataPoints })) };
}

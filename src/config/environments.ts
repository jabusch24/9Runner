import 'dotenv/config';

/**
 * A MongoDB deployment the demo can run workloads against.
 *
 * The flags (`iwm`, `loadShedding`) describe what the operator *configured*.
 * They are labels, not facts: every benchmark also records what the server
 * actually reports (version, ingress limiter state, ...) so a mislabelled
 * cluster is visible in the results.
 */
export type DemoEnvironment = {
  id: EnvironmentId;
  name: string;
  uri: string;
  /** Major version the operator expects. Compared with buildInfo at runtime. */
  expectedMajor?: number;
  iwm?: boolean;
  loadShedding?: boolean;
  /** Free-text tier/config label, e.g. "M30, AWS eu-central-1, 3-node RS". */
  tier?: string;
  /** Atlas cluster name, only needed for the optional Atlas Admin API metrics. */
  atlasClusterName?: string;
  /** Local deployments using setParameter to emulate IWM behaviour. */
  emulation?: boolean;
};

export type EnvironmentId = 'mongo8' | 'mongo9' | 'mongo9iwm' | 'mongo9iwmls' | 'local';

type EnvSpec = {
  id: EnvironmentId;
  uriVar: string;
  prefix: string;
  name: string;
  expectedMajor?: number;
  iwm?: boolean;
  loadShedding?: boolean;
  emulation?: boolean;
};

const SPECS: EnvSpec[] = [
  { id: 'mongo8', uriVar: 'MONGO_8_URI', prefix: 'MONGO_8', name: 'MongoDB 8', expectedMajor: 8, iwm: false, loadShedding: false },
  // On Atlas Dedicated 9.0+ the always-on IWM protections cannot be switched off,
  // so "MongoDB 9 without IWM" only exists outside Atlas Dedicated (self-managed, local).
  { id: 'mongo9', uriVar: 'MONGO_9_URI', prefix: 'MONGO_9', name: 'MongoDB 9 (no IWM)', expectedMajor: 9, iwm: false, loadShedding: false },
  { id: 'mongo9iwm', uriVar: 'MONGO_9_IWM_URI', prefix: 'MONGO_9_IWM', name: 'MongoDB 9 + IWM', expectedMajor: 9, iwm: true, loadShedding: false },
  { id: 'mongo9iwmls', uriVar: 'MONGO_9_IWM_LS_URI', prefix: 'MONGO_9_IWM_LS', name: 'MongoDB 9 + IWM + Load Shedding', expectedMajor: 9, iwm: true, loadShedding: true },
  { id: 'local', uriVar: 'LOCAL_URI', prefix: 'LOCAL', name: 'Local (atlas-local)', emulation: true },
];

export const ALL_ENV_IDS = SPECS.map((s) => s.id);

export function loadEnvironments(): DemoEnvironment[] {
  const envs: DemoEnvironment[] = [];
  for (const spec of SPECS) {
    const uri = process.env[spec.uriVar]?.trim();
    if (!uri) continue;
    envs.push({
      id: spec.id,
      name: process.env[`${spec.prefix}_NAME`] || spec.name,
      uri,
      expectedMajor: spec.expectedMajor,
      iwm: spec.iwm,
      loadShedding: spec.loadShedding,
      tier: process.env[`${spec.prefix}_TIER`],
      atlasClusterName: process.env[`${spec.prefix}_ATLAS_CLUSTER`],
      emulation: spec.emulation,
    });
  }
  return envs;
}

/** Resolve `--env a,b` (or "all") against the configured environments. */
export function selectEnvironments(requested: string | undefined, fallback: EnvironmentId[]): DemoEnvironment[] {
  const configured = loadEnvironments();
  const ids = !requested || requested === 'default'
    ? fallback
    : requested === 'all'
      ? configured.map((e) => e.id)
      : (requested.split(',').map((s) => s.trim()) as EnvironmentId[]);
  const selected = ids
    .map((id) => configured.find((e) => e.id === id))
    .filter((e): e is DemoEnvironment => Boolean(e));
  if (selected.length === 0) {
    const available = configured.map((e) => e.id).join(', ') || '(none - set MONGO_*_URI in .env)';
    throw new Error(`No configured environment matches "${requested ?? fallback.join(',')}". Configured: ${available}`);
  }
  return selected;
}

export function getEnvironment(id: string): DemoEnvironment {
  const env = loadEnvironments().find((e) => e.id === id);
  if (!env) throw new Error(`Environment "${id}" is not configured`);
  return env;
}

/** Hide credentials before a URI is logged, stored or sent to the UI. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^@/]+)@/, '//***@');
}

export function hostOf(uri: string): string {
  const m = uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@]*@/, '');
  return m.split(/[/?]/)[0];
}

export function isLocalUri(uri: string): boolean {
  return /(^|,|\/\/|@)(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal|mongodb-local)(:|\/|,|$)/.test(uri);
}

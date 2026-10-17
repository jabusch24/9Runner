# 9Runner - MongoDB 8 vs 9: IWM, Load Shedding and Search aggregations

A runnable Node.js/TypeScript demo that sends one realistic e-commerce workload to MongoDB 8 and
MongoDB 9 deployments and **measures** the differences:

- **Search facet aggregations vs `$group`**: facet counts and per-bucket metrics computed in the
  Search index, compared with `$search → $group`, `$search (storedSource) → $group` and
  `$match → $group`, across query selectivity, with result-parity checks.
- **Intelligent Workload Management (IWM)**: an open-loop ramp → overload → recovery test against
  MongoDB 8, MongoDB 9 + IWM, and MongoDB 9 + IWM + Load Shedding.
- **Load Shedding**: IWM with and without shedding, with a client that doesn't retry and one that
  retries with backoff.

It does **not** assume MongoDB 9 wins. It reports "similar" when the numbers are similar, flags runs
where the load generator was the bottleneck or the cluster was never overloaded, and explains which
capabilities MongoDB 8.x already has. The research behind every version-specific claim is in
[`docs/VERSION_RESEARCH.md`](docs/VERSION_RESEARCH.md).

One web UI with tabs: Overview · Search Demo · Facet Aggregation · Aggregation Comparison ·
IWM Stress Test · Load Shedding · MongoDB 8 vs 9 · Queryable Encryption (placeholder, see
[Merging Queryable Encryption](#merging-queryable-encryption)).

---

## Contents

1. [Quick start (local rehearsal)](#1-quick-start-local-rehearsal)
2. [Architecture](#2-architecture)
3. [Creating the Atlas environments](#3-creating-the-atlas-environments)
4. [Seeding the data](#4-seeding-the-data)
5. [The Search index](#5-the-search-index)
6. [Configuring IWM and Load Shedding](#6-configuring-iwm-and-load-shedding)
7. [Running the benchmarks](#7-running-the-benchmarks)
8. [Reading the charts](#8-reading-the-charts)
9. [Valid and invalid conclusions](#9-valid-and-invalid-conclusions)
10. [Why don't MongoDB 8 and 9 always look dramatically different?](#10-why-dont-mongodb-8-and-9-always-look-dramatically-different)
11. [MongoDB 9-specific capabilities](#11-mongodb-9-specific-capabilities)
12. [Search version caveats](#12-search-version-caveats)
13. [Atlas vs self-managed](#13-atlas-vs-self-managed)
14. [Configuration reference](#14-configuration-reference)
15. [Demo script](#15-demo-script)

---

## 1. Quick start (local rehearsal)

Requirements: Node.js 20+, Docker.

```bash
npm install
cp .env.example .env            # LOCAL_URI is pre-filled
docker compose up -d            # MongoDB 8.3 + Search (mongodb-atlas-local)
PRODUCT_COUNT=50000 REVIEW_COUNT=200000 ORDER_COUNT=20000 npm run seed -- --env local
npm run probe
npm run demo                    # http://localhost:3000
```

Locally there is no IWM. The `local` environment **emulates** it with static server parameters
(`ingressRequestAdmissionRatePerSec` / `ingressRequestAdmissionMaxQueueDepth`, available in
self-managed 8.3+). When only `local` is selected, `benchmark:iwm` runs it three times - limiter off,
deep queue ("IWM-style queueing") and shallow queue ("Load-Shedding-style rejection"). Every label says
**EMULATED**. That rehearses the demo and validates the harness, but **it is not Atlas IWM**: Atlas
adapts the admission rate from CPU, queue depth and latency, while a static rate either
under-admits (and queueing only adds waiting) or over-admits. Set `EMULATION_RATE_PER_SEC` just below
the knee reported by `npm run calibrate -- --env local`.

## 2. Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the diagram and data flow.

```
src/
  config/      environments (MONGO_8_URI, ...) and settings (all env-overridable)
  seed/        deterministic catalogue generator (Zipf popularity, log-normal prices, skewed ratings)
  search/      Search index definition, query builders, search/facet/aggregation benchmarks
  iwm/         load schedule, operation mix, worker threads, monitor, stress coordinator, interpretation
  benchmark/   generic variant runner (warm-up, interleaving, throughput), results, CSV, jobs
  metrics/     optional Atlas Admin API metrics
  server/      Express API + SSE for the web UI
  cli/         npm run ... entry point
public/        the web UI (no build step; Chart.js served from node_modules)
docs/          architecture, version research, demo script
test/          unit tests (npm test)
```

## 3. Creating the Atlas environments

Create clusters in the **same project, provider, region and tier**, and run the load generator on a
VM in that region (an M30+ cluster can easily out-run a laptop on a home connection).

| env var | cluster | notes |
|---|---|---|
| `MONGO_8_URI` | Dedicated **M30+**, MongoDB **8.0** (or the 8.x you want to compare) | record the exact patch version - backports matter |
| `MONGO_9_IWM_URI` | Dedicated **M30+**, MongoDB **9.0**, Load Shedding **Disabled** | IWM's always-on protections are active automatically |
| `MONGO_9_IWM_LS_URI` | Dedicated **M30+**, MongoDB **9.0**, Load Shedding **Enabled** | must be M30+ replica set for shedding to take effect |
| `MONGO_9_URI` | *optional*: self-managed 9.0 without IWM | Not possible on Atlas Dedicated - leave empty |

MongoDB 9.0 was rolled out first to clusters on *Latest Version With Auto Upgrades*. If 9.0 isn't
selectable in your project yet, choose that release option when creating the cluster.

To save money you can use **two** 9.0 clusters, or even one and toggle Load Shedding between runs
(then point both `MONGO_9_IWM_URI` and `MONGO_9_IWM_LS_URI` at it and run the two benchmarks
separately, flipping the setting in between).

Database user: **Atlas admin** (or `readWriteAnyDatabase` + `clusterMonitor`). Without
`clusterMonitor`, the cluster-health metrics are empty and you'll see a warning in `npm run probe`.
Add the load-generator VM's IP to the project's IP access list.

Fill in `.env`, including the `*_TIER` labels (they're printed on every chart). Optionally set
`ATLAS_CLIENT_ID/SECRET/GROUP_ID` (a service account with Project Read Only) and `*_ATLAS_CLUSTER` to
attach Atlas host metrics (normalized CPU, CPU steal, …) to each stress run.

## 4. Seeding the data

```bash
npm run seed                    # all configured environments
npm run seed -- --env mongo8,mongo9iwm
```

Default size: 500,000 products, 2,000,000 reviews, 200,000 orders (roughly 1 GB of data plus indexes; seeding takes ~5–15 min from a VM in-region). Generation is
deterministic (`SEED`), so every cluster gets byte-identical documents. Re-running with the same
parameters is a no-op; `SEED_FORCE=true` reseeds. The seed also creates the B-tree indexes and the
Search index. Distributions: Zipf product popularity, skewed brand/category popularity, log-normal
prices per category with brand premiums, ratings centred at ~4.2 with a 7% "bad product" tail,
reviews concentrated on popular products, 8% out-of-stock items.

Deliberately **not** indexed: reviews by date and product descriptions - the heavy-report operations
are supposed to be expensive.

## 5. The Search index

Defined in [`src/search/indexDefinition.ts`](src/search/indexDefinition.ts) (`products_search`):
full-text `lucene.english` on name/description/tags, `token` on brand/category/subcategory/color/
gender (facets + filters), `number` on price/rating/stock/reviewCount, `date` on createdAt, plus
`storedSource` for brand/category/price/rating/stock. `npm run search:index` creates or updates it and
waits until it's queryable. `npm run probe` reports its status and whether facet aggregations work.

## 6. Configuring IWM and Load Shedding

- **IWM**: nothing to configure. On Atlas Dedicated clusters running 9.0+ the always-on protections
  are applied automatically and can't be disabled.
- **Load Shedding**: Atlas UI → cluster → *Edit Configuration* → *Additional Settings* →
  **Load Shedding**: `Atlas Managed` (default), `Enabled`, `Disabled`. Check the **Effective state**
  shown next to it - on M10/M20 it stays Disabled whatever you choose. (Atlas CLI:
  `atlas clusters advancedSettings update --help` on a current CLI.)
- **Client behaviour** (`CLIENT_RETRY_MODE`):
  - `none` (default) - no driver retries: you see exactly what the server did
  - `app` - the workload retries overload errors itself with full-jitter exponential backoff
    (up to `APP_MAX_RETRIES`) **within a retry budget** (`APP_RETRY_BUDGET=0.1`: retries add at
    most ~10% load), and every retry is counted. Without a budget, retries under *sustained*
    overload multiply the load - in local tests unbudgeted retries tripled the request volume and
    made everything worse. Set `APP_RETRY_BUDGET=100` to demonstrate that retry storm deliberately.
  - `driver` - driver defaults. Node.js driver 7.x retries `SystemOverloadedError` up to
    `maxAdaptiveRetries` (2) times, which hides rejections inside slower successes. Server rejections
    are still counted through command monitoring ("server rejections absorbed by driver retries").

## 7. Running the benchmarks

```bash
npm run probe                      # sanity check: versions, limiter, dataset, index, facet aggs
npm run calibrate -- --env mongo9iwm   # find the knee -> suggested BASE_RPS / PEAK_RPS

npm run benchmark:search           # Part A  - ranked search
npm run benchmark:facets           # Part B  - facet panel, Search-side aggregations
npm run benchmark:aggregation      # Part C  - Search facets vs $group across selectivity
npm run benchmark:mongo8-vs-9      # Part D  - realistic mix, steady + spike
npm run benchmark:iwm              # Part E  - ramp → overload → recovery on 8 / 9+IWM / 9+IWM+LS
npm run benchmark:load-shedding    # Part F  - 9+IWM vs 9+IWM+LS, no-retry vs retry+backoff
npm run benchmark:all              # everything except calibrate
npm run export:csv                 # results/*.json -> results/summary.csv
npm run demo                       # UI on :3000 (benchmarks can be started from the UI too)
```

Pick environments with `--env mongo8,mongo9iwm` and override any setting with a flag:
`npm run benchmark:iwm -- --peak-rps 12000 --ramp-steps 2000,4000,8000,12000 --overload-seconds 90`.

**Sizing the stress test.** The right rates depend on tier, dataset and mix, so calibrate first. The
calibrator doubles the rate every step and reports where goodput stops growing or critical latency
breaks the SLO; it suggests `BASE_RPS` ≈ 50% and `PEAK_RPS` ≈ 3× the last healthy step. The overload
must be *sustained* (60 s+) for Load Shedding to engage. One Node.js worker thread comfortably issues
a few thousand requests/s; use `WORKERS` ≈ vCPUs of the load-generator VM and watch for CLIENT-BOUND
warnings. Each worker opens up to `POOL_SIZE_PER_WORKER` connections.

**Fairness built in.** Same seed and dataset everywhere; same arrival schedule and operation
sequence (deterministic per worker); environments run one after another with a cooldown; warm-up is
discarded; variants are interleaved in shuffled order; every request has the same deadline
(`OP_TIMEOUT_MS`, enforced with driver `timeoutMS` so abandoned requests are never sent late).

Results go to `results/<benchmark>.json` (latest) and `results/history/` (every run). Each file records
server version, topology, local/remote, tier label, dataset, Search index definition/status, client
host, driver version and all settings.

## 8. Reading the charts

**Stress tests** (one chart per measure, one line per run, overload phase shaded, dashed = target rate):

| chart | question it answers |
|---|---|
| Goodput (within SLO / s) | how many shoppers got a fast answer - the headline metric |
| Successful / s | includes slow successes |
| Rejected / s | fast, retryable failures (Load Shedding) |
| Timeouts + errors / s | slow failures that held a connection until the deadline |
| Critical-path p95 | product page, listing, search, checkout, inventory - what IWM tries to protect |
| All requests p99 | measured from scheduled send time, so client-side queueing counts |
| Server CPU | serverStatus user+system time / cores on the primary |
| Canary p50 | independent product-page probe: "is the site usable right now?" |

The **funnel** separates *attempted → accepted → succeeded → within SLO*, with rejected / timed
out / error shares. **Recovery** is the time after the overload ends until critical p95 ≤ SLO with
< 1% failures for 3 consecutive seconds.

**Aggregation comparison:** x = share of the catalogue the query matches, y = p50 (log). Each
variant keeps one colour. The per-query tables show p50/p95/p99, throughput, the bootstrap
comparison ("1.6x faster, 95% CI …" or "statistically similar") and a parity badge.

### Effects you may see that are not bugs

- **`MongoPoolClearedError`**: when requests hit their deadline the driver closes those connections
  (CSOT). Replacement connections must handshake; if the handshake itself is rejected under overload,
  the driver marks the server unknown and clears the pool, failing other in-flight requests. Observed
  with local emulation (where the ingress limiter also limits handshakes); counted as "errors".
- **APP QUEUE FULL**: more than `MAX_INFLIGHT_PER_WORKER` requests were waiting in the application.
  That is a consequence of a slow server, counted as failed requests, and does not invalidate a run.
- **CLIENT-BOUND**: the load generator's event loop stalled or it could not issue the scheduled
  rate. This *does* invalidate the run. Locally it is common because mongod and the load generator
  share CPUs.

## 9. Valid and invalid conclusions

**Valid**
- "Under this sustained overload on M30, cluster X completed N requests/s within the 500 ms SLO vs
  M for cluster Y" - for the measured tier, mix and rates.
- "With Load Shedding, P% of requests were rejected fast; critical-path p99 stayed at Z ms and the
  cluster recovered in S s." Rejections are a designed outcome, not an error rate.
- "For queries matching ~50% of the catalogue, Search facets answered the facet panel in X ms vs
  Y ms for `$search → $group`, with identical results."
- "During normal traffic there was no measurable difference."

**Not valid**
- "MongoDB 9 is faster." The demo doesn't measure that, and normal-traffic latencies are usually similar.
- "Load Shedding loses requests." Compare goodput and the retry+backoff run, not acceptance.
- Anything from a run flagged **CLIENT-BOUND** (the load generator was the bottleneck) or **NOT
  OVERLOADED** for overload claims.
- "MongoDB 9 made Search faster." Search runs in mongot; differences come from the Search engine
  version and deployment, not the server version.
- Extrapolating local (docker) numbers to Atlas, or one tier's knee to another tier.
- Comparing variants whose parity check failed.

## 10. Why don't MongoDB 8 and 9 always look dramatically different?

Because much of the underlying machinery already exists in the 8.x line (see
[`docs/VERSION_RESEARCH.md`](docs/VERSION_RESEARCH.md) for sources and what was observed directly):

- **Execution control with throughput probing** (dynamic concurrency, since 7.0) and **heuristic
  deprioritisation of long-running operations** - both on by default in 8.x (visible in `npm run probe`).
- **Ingress connection establishment rate limiting** - 8.2, backported to 8.1.1 and 8.0.12.
- **Ingress request admission control** and the **`SystemOverloaded` error category** - in the 8.0
  changelog (8.0.20); on self-managed 8.3 the ingress request rate limiter queues or rejects with
  error 462 `IngressRequestRateLimitExceeded` labelled `SystemOverloadedError` + `RetryableError`.
- **Atlas Adaptive Operation Rate Limiting** - available from 8.3, disabled by default.

So an experiment can show little difference when the workload never saturates the cluster, when the
overload consists of uniformly cheap operations, or when the 8.x patch already has the relevant
protections. The difference also depends on tier, deployment and configuration. When the interpretation
says "similar", explain which 8.x capability covers the case and why the workload doesn't exercise the
9-specific part.

## 11. MongoDB 9-specific capabilities

- **IWM as a managed system** on every Atlas Dedicated 9.0+ cluster. Atlas tunes per-mongod admission
  adaptively from CPU utilisation, queue depth, operations/s and latency, queues transient spikes,
  keeps short operations moving and long ones stable, and throttles excess only as a last resort.
  Always on, no application changes.
- **Load Shedding** (optional, M30+ replica sets, 9.0+): bounds the ingress queue and rejects
  operations during *sustained* overload with `SystemOverloadedError`.
- **Backpressure-aware drivers** (Node.js 7.x: `maxAdaptiveRetries`, `enableOverloadRetargeting`)
  retry overload errors with backoff and jitter, documented as working with Atlas 9.0+.
- Not demonstrated here: other 9.0 changes such as the per-operation memory limit
  (1 GB or 20% of RAM).

IWM does not add capacity. It is not a replacement for auto-scaling or capacity planning.

## 12. Search version caveats

- `$search`/`$searchMeta` execute in **mongot**, which Atlas versions and deploys independently of
  the MongoDB server (co-located or on dedicated Search Nodes). The Search tabs label the execution path.
- **Facet counts** are long-standing. **Facet aggregations** (per-bucket `sum/avg/min/max/first/last`,
  explicit `count`, nested facets with aggregations on leaf facets only) are documented as **Preview**
  ("Accelerated Search Aggregations", Search changelog Sept 2026). They depend on the mongot version.
  The demo probes support and shows "not supported on this deployment" instead of failing. For example,
  mongot in `mongodb-atlas-local` (server 8.3.13) rejects `aggregations`.
- The **benchmark measures the execution path**: Search facets do the work in the index and return
  one document. `$search → $group` moves every match through mongod (with full-document lookup, or
  from stored source). `$match → $group` uses no Search at all. Parity checks prove they compute the same thing.
- Facet aggregations and nested facets increase Search index memory and disk.
- A cross-environment Search comparison measures the mongot version, Search Nodes vs co-located,
  tier and network, **not "MongoDB 9 vs 8"**. The UI says so next to every such comparison.

## 13. Atlas vs self-managed

| | Atlas Dedicated 9.0 | self-managed 9.0 / 8.3 |
|---|---|---|
| IWM always-on protections | automatic, cannot disable | the building blocks (ingress rate limiter, execution control) exist as server parameters you tune yourself |
| Load Shedding | UI setting, M30+ | bounded `ingressRequestAdmissionMaxQueueDepth` gives rejection, but static, not adaptive |
| Adaptive rate limiting | managed by Atlas (8.3+ policy, 9.0 IWM) | not available as a managed policy |
| Metrics | Atlas charts (Operation Rate Limiting) + serverStatus | serverStatus (`network.ingressRequestRateLimiter`, `queues.*`) |
| Search | mongot managed by Atlas (Search Nodes optional) | mongot (Community/Enterprise Search, 8.2+) |

## 14. Configuration reference

All settings are documented in [`.env.example`](.env.example). The most important ones:

| variable | default | meaning |
|---|---|---|
| `PRODUCT_COUNT` / `REVIEW_COUNT` / `ORDER_COUNT` | 500k / 2M / 200k | dataset size |
| `SEED` | `mongodb-9-demo` | deterministic data |
| `WARMUP_ITERATIONS` / `MEASURED_ITERATIONS` | 10 / 100 | request/response benchmarks |
| `BENCH_CONCURRENCY` / `THROUGHPUT_SECONDS` | 4 / 10 | throughput phase per variant |
| `BASE_RPS` / `PEAK_RPS` | 1000 / 8000 | stress rates (calibrate!) |
| `BASELINE/RAMP/OVERLOAD/RECOVERY_SECONDS` | 30/30/60/30 | phase lengths |
| `RAMP_STEPS` | - | staircase ramp, e.g. `2000,4000,8000,12000` |
| `LOAD_PHASES` | - | full custom profile, `name:sec:rps[-rpsEnd],...` |
| `WORKLOAD_MIX` | see `.env.example` | op-class weights |
| `SLO_MS` / `OP_TIMEOUT_MS` | 500 / 5000 | SLO and per-request deadline |
| `WORKERS` / `POOL_SIZE_PER_WORKER` | 4 / 250 | load-generator parallelism |
| `CLIENT_RETRY_MODE` | `none` | `none` / `app` / `driver` |
| `APP_RETRY_BUDGET` | 0.1 | retries per original request in `app` mode (token bucket) |

## 15. Demo script

A 10–15 minute click-by-click script is in [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## Merging Queryable Encryption

The app is organised by feature: each feature has a server router mounted in
`src/server/index.ts` (`features` list) and a tab module in `public/js/tabs/`. The Queryable
Encryption tab is registered as a placeholder (`public/js/tabs/queryable-encryption.js`). Mount a
`qeRouter` at `/api/qe`, replace the placeholder, and keep customers in the same `DB_NAME` -
`orders.customerId` (1–250,000) is the join key.

## Development

```bash
npm run typecheck
npm test          # unit tests: histogram accuracy, determinism, schedule maths, error classification, parity
```

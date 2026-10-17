# Version research: what is really new in MongoDB 9?

Checked against MongoDB documentation, release notes and announcements in **October 2026**
(MongoDB 9.0 GA was announced 29 Sept 2026; 9.0.4 was the latest patch on 13 Oct 2026).
Where something could only be confirmed by observing a server, it says so. Re-check before a
customer presentation - these pages change quickly.

## Intelligent Workload Management (IWM)

| Claim | Status | Source |
|---|---|---|
| IWM is the overload-protection system Atlas applies to **all Dedicated clusters running MongoDB 9.0+**. | Documented | Atlas docs: *Intelligent Workload Management* |
| Always-on protections (queue, slow down, prioritise) run at all times, even with Load Shedding disabled, and **cannot be turned off**. | Documented | same |
| Each mongod has an **ingress request rate limiter**; operations above the admitted rate go into an **ingress queue**. Atlas charts it as *Operation Rate Limiting: Queued operations*. | Documented | same |
| Under overload IWM "queues transient traffic spikes, keeps short-running operations moving and long-running operations stable, and throttles excess requests only as a last resort". It does **not add capacity** and does not replace auto-scaling. | Announcement | MongoDB 9.0 / IWM blog posts |
| **Load Shedding** is optional: `Atlas Managed` (default) / `Enabled` / `Disabled`. When enabled it bounds the ingress queue and rejects operations in response to *sustained* overload. | Documented | Atlas docs: IWM, *Configure Additional Settings* |
| Load Shedding only takes effect on **M30+ replica sets on 9.0+**. On M10/M20 the setting is shown but the effective state stays Disabled. | Documented | same |
| Rejected operations return an overload error labelled **`SystemOverloadedError`** (Atlas docs example: code 463 `IngressOperationRateLimitExceeded`). Safe-to-retry is indicated by **`RetryableError`** (+ `NoWritesPerformed`), not by `SystemOverloadedError` alone. | Documented | Atlas docs: *Handle Overload Errors from Load Shedding* |
| Load shedding can be tested on Atlas with the resilience tooling (M30+ replica set, 9.0+, test clusters only). | Documented | Atlas docs: *Test Cluster Load Shedding* |
| Exact Admin API field name for the Load Shedding setting | **Not confirmed** - set it in the Atlas UI (or the Atlas CLI `clusters advancedSettings update`; check `--help`). | |

## What MongoDB 8.x already has (why 8 vs 9 may look similar)

| Capability | Where | Evidence |
|---|---|---|
| Throughput-probing execution control (dynamic concurrency, default since 7.0) | 7.0+ | Observed on 8.3.13: `queues.execution.usesThroughputProbing: true`, `executionControlConcurrencyAdjustmentAlgorithm: "throughputProbing"` |
| Heuristic deprioritisation of long-running operations | 8.x | Observed on 8.3.13: `executionControlHeuristicDeprioritization: true`, `queues.execution.totalDeprioritizations` |
| Ingress connection establishment rate limiter | 8.2; backported to 8.1.1 and 8.0.12 | Server parameters reference (`ingressConnectionEstablishmentRateLimiterEnabled`) |
| `SystemOverloaded` error category, admission rate limiter on the mongod ingress path | 8.0.20 (SERVER-96975, SERVER-104933) | 8.0 changelog |
| Ingress request rate limiter with a bounded queue, rejecting with **462 `IngressRequestRateLimitExceeded`** + `SystemOverloadedError`, `RetryableError`, `NoWritesPerformed` | 8.3 (self-managed) | **Observed** on 8.3.13 with `ingressRequestAdmissionRatePerSec` / `ingressRequestAdmissionMaxQueueDepth` |
| Atlas *Adaptive Operation Rate Limiting* policy | 8.3+, disabled by default | Atlas docs: *Adaptive Operation Rate Limiting* |
| `ingressRequestRateLimiterApplicationExemptions` parameter | 8.3 | 8.3 release notes; observed format `{ appNames: [...] }` |

**Conclusion:** the server-side mechanisms (admission control, queueing, deprioritisation, the
overload error category) largely exist in the 8.x line - some only in recent patches. What 9.0 on
Atlas adds is IWM as a *managed* system: Atlas tunes admission adaptively from CPU, queue depth,
ops/s and latency, applies it to every Dedicated 9.0 cluster, and offers Load Shedding. A test that
does not saturate the cluster - or runs an 8.x patch that already has the relevant protections
switched on - can legitimately show little difference.

## Drivers

| Fact | Source |
|---|---|
| Node.js driver 7.7.0 exposes `maxAdaptiveRetries` ("maximum number of retries during server overload … Defaults to 2", "works with Atlas 9.0+") and `enableOverloadRetargeting` (default false). | `mongodb@7.7.0` type definitions |
| The driver retries `SystemOverloadedError`+`RetryableError` with exponential backoff and jitter, but only if `retryReads`/`retryWrites` allow it. | `lib/operations/execute_operation.js` in 7.7.0 |
| Consequence for benchmarks: with driver defaults, rejections are partly hidden inside slower successes. This demo sets `maxAdaptiveRetries: 0` and disables retries unless `CLIENT_RETRY_MODE=driver`, and counts server rejections via command monitoring in `driver` mode. | this repo |
| Go-driver based tools (mongodump/restore/import) need a newer Go driver to retry load-shedding errors (TOOLS-4329). | MongoDB Jira |

## Search

| Claim | Status | Source |
|---|---|---|
| `$search`/`$searchMeta` run in **mongot**, which Atlas versions and deploys independently of the server (co-located or on dedicated Search Nodes). | Documented | MongoDB Search docs |
| Facet counts (`string`/`number`/`date` facets) have been available for years; `$searchMeta` + `count: {type: 'total'}` gives exact totals. | Documented | `$searchMeta`, facet operator docs |
| **Facet aggregations** - per-bucket `sum`, `avg`, `min`, `max`, `first`, `last`, plus explicit `count`, and nested facets (aggregations only on leaf facets) - are documented as **Preview** ("Accelerated Search Aggregations", public preview; Search changelog entry 29 Sept 2026). | Documented (Preview) | facet operator docs, Search changelog, product update page |
| Metric paths must be indexed as `token`, `number` or `date`; aggregations and nested facets increase index memory/disk. | Documented | facet operator docs |
| The capability depends on the **mongot version**, not the server version. | **Observed**: mongot in `mongodb-atlas-local:latest` (server 8.3.13) rejects `aggregations` with `unrecognized field "aggregations"`. | |
| Self-managed Community/Enterprise Search requires 8.2+. | Documented | `$searchMeta` docs |

**Consequence for the demo:** a "MongoDB 8 vs MongoDB 9" Search comparison measures the Search
deployment (mongot version, Search Nodes vs co-located, tier, network), not the server version. The
UI labels every Search number with its execution path and probes facet-aggregation support at runtime.

## Sources

- Atlas: Intelligent Workload Management - https://www.mongodb.com/docs/atlas/intelligent-workload-management/
- Atlas: Handle Overload Errors from Load Shedding - https://www.mongodb.com/docs/atlas/overload-errors/
- Atlas: Adaptive Operation Rate Limiting - https://www.mongodb.com/docs/atlas/cluster-operation-rate-limiting/
- Atlas: Test Cluster Load Shedding - https://www.mongodb.com/docs/atlas/tutorial/test-resilience/test-load-shedding/
- Atlas: Configure Additional Settings - https://www.mongodb.com/docs/atlas/cluster-additional-settings/
- Blog: IWM - Keeping Your Clusters Available When It Matters - https://www.mongodb.com/company/blog/product-release-announcements/intelligent-workload-management-keeping-your-clusters-available-when-it-matters
- Blog: MongoDB 9.0 - https://www.mongodb.com/company/blog/product-release-announcements/mongodb-9-0-this-is-what-a-database-should-be
- MongoDB 9.0 release notes - https://www.mongodb.com/docs/manual/release-notes/9.0/
- MongoDB 8.0 changelog - https://www.mongodb.com/docs/v8.2/release-notes/8.0-changelog/
- MongoDB 8.3 release notes - https://www.mongodb.com/docs/v8.3/release-notes/8.3/
- Server parameters - https://www.mongodb.com/docs/manual/reference/parameters/
- Search facet operator - https://www.mongodb.com/docs/search/query/operators-collectors/facet/
- `$searchMeta` - https://www.mongodb.com/docs/search/query/aggregation-stages/searchmeta/
- Search changelog - https://www.mongodb.com/docs/atlas/search-changelog/
- Now in Public Preview: Accelerated Search Aggregations - https://www.mongodb.com/products/updates/now-in-public-preview-accelerated-search-aggregations/
- DRIVERS-3532 Client Backpressure for IWM - https://jira.mongodb.org/browse/DRIVERS-3532
- TOOLS-4329 - https://jira.mongodb.org/browse/TOOLS-4329

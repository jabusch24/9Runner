# Demo script (10–15 minutes)

**Before the meeting** (results are saved, so nothing has to run live except the search demo):

```bash
npm run probe                      # every environment reachable, seeded, index READY?
npm run benchmark:aggregation      # ~10-20 min on 500k products
npm run benchmark:facets
npm run benchmark:iwm              # ~10 min for 3-4 environments
npm run benchmark:load-shedding    # ~12 min (2 envs x 2 client modes)
npm run demo                       # http://localhost:3000
```

Check the **Validity** box on each stress result. If a run says CLIENT-BOUND or NOT OVERLOADED, fix
that first (bigger load-generator VM, `npm run calibrate`, higher `PEAK_RPS`) - do not present it.

---

## 0:00 - Overview tab (1 min)

> "Two things today: Search doing aggregation work inside the index, and how MongoDB 9 behaves when
> the workload gets difficult. Everything you'll see is measured on the same dataset, and where 8
> and 9 look the same, I'll tell you why."

Click **Probe environments**. Point at the version column and the ingress limiter / execution control
columns: "This is what each server says about itself - not what we labelled it."

## 1:00 - Search Demo tab (1.5 min)

Type `running shoes`, then add brand `Nike,Asics` and a price range.

> "Relevance ranking, filtering, and the facet counts on the left all come from the Search index.
> mongod only fetches the 24 products on the page."

## 2:30 - Facet Aggregation tab (2 min)

Click **Compute facets** for `running shoes`, then clear the box (whole catalogue).

> "A shop page wants more than counts: average and price range per brand. Search can compute those
> per bucket inside the index - facet aggregations, currently Preview."

If the yellow box says *not supported*: "This deployment's Search engine doesn't have it yet. That's a
Search (mongot) capability, not a MongoDB 9 server feature - a 9.0 cluster can lack it. The numbers
fall back to `$group`, and the badges show both paths returned identical answers."

## 4:30 - Aggregation Comparison tab (2.5 min)

Show the two charts (full-text, structured).

> "X-axis: how much of the catalogue the query matches. The blue line - Search facets - stays flat.
> The `$search → $group` lines climb, because every matching document travels through mongod before
> it's grouped. At 4% matched the difference is small; at 50–100% it is large."

Point at the `$match (B-tree)` line: "For simple structured filters a normal index is competitive -
that's a legitimate result. The advantage is for search-shaped pages that need facets."

Point at *returnStoredSource*: "That line shows how much of the cost is fetching full documents."

## 7:00 - IWM Stress Test tab (3 min)

Scroll to **Over time**. The shaded band is the overload phase.

> "Same open-loop traffic against each deployment: normal, ramp, then a sustained overload - and we
> keep sending. Shoppers don't stop arriving because the database is slow."

**Say it explicitly:** "**Don't look only at accepted requests.** Look at successful requests, latency,
SLO compliance and cluster health."

Walk the funnel: attempted → accepted → succeeded → within SLO. Then the *Goodput* chart (requests per
second completed within the SLO), the *Critical-path p95* chart, the *Canary* chart and *recovery*.

If MongoDB 8 and 9 look similar: "**That's not a failure of the demo.** 8.x already has throughput
probing, deprioritisation of long-running operations and, in recent patches, an ingress rate limiter -
see the server facts table. IWM's 9.0 contribution is managing that adaptively on Atlas and adding Load
Shedding; this workload [didn't saturate the cluster / used cheap uniform operations], so it didn't
exercise the difference."

## 10:00 - Load Shedding tab (2.5 min)

Show the two concept flows, then the funnel.

> "Without Load Shedding, more accepted requests means more queued work, higher latency, and the
> cluster getting unhealthy. With Load Shedding, excess work is rejected immediately with a retryable
> error - pressure stays bounded and healthy requests keep flowing."

Compare *no retries* vs *retry + backoff*: "Rejections aren't lost sales if the application retries
with backoff - that's what the second pair of runs shows."

## 12:30 - MongoDB 8 vs 9 tab (1 min) and close

> "MongoDB 9 isn't 'faster' as a blanket statement. It gives applications more mechanisms to stay
> predictable and available when the workload gets difficult, and newer Search capabilities move some
> aggregation work into the search index. MongoDB 8 already contains part of this, so the size of the
> difference depends on the exact 8.x release, the deployment, the workload and the configuration."

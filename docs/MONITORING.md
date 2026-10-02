# Monitoring plan

Companion to the [STRIDE threat model](../frontend/docs/pages/threat-model.mdx).
Together they are the SCF #46 tranche-2 (testnet) deliverable for the Build
Award. Submission deadline **8 November 2026**.

The threat model says what an attacker could do. This says how we would find
out that anything — attack, crash, quota, or a silent stall — had happened.

> **A monitoring plan describing metrics nothing emits is worse than none**: it
> reads as diligence while leaving the same blind spot. So every metric named
> below is marked with whether it is exported **today**. The aspirational ones
> are listed separately, with the issue that would make them real.

---

## 1. Why now

On **30 August 2026** all three backends were returning HTTP 503:

```
SUSP  503   1093 ms  wraith /healthz
SUSP  503    684 ms  wraith /status
SUSP  503    937 ms  lens /status
SUSP  503    685 ms  lens /metrics
SUSP  503    669 ms  agent /health
```

Nobody was paged. It surfaced because the wallet's prices and activity went
blank and a person clicked around. That is the definition of having no
monitoring, and it is the single fact this document exists to fix.

### What the 503 actually was

Not a cold start, not a crash. The response carries:

```
HTTP/1.1 503 Service Unavailable
x-render-routing: suspend
> This service has been suspended.
```

This distinction matters more than it looks:

| Failure | Signature | Self-heals? | Response |
|---|---|---|---|
| Free-tier cold start | slow (10–60 s) then **200** | yes | none needed |
| Crash / crash-loop | 502, or 503 from the app | sometimes | read logs, fix, redeploy |
| **Suspended** | **fast** 503 + `x-render-routing: suspend` | **no** | a human, in the Render dashboard |

An alert that reports all three as "down" is an alert people learn to ignore.
The probe classifies them separately.

**Leading hypothesis for the suspension — to confirm in the Render dashboard,
not yet verified:** Render's free tier allows a fixed pool of instance-hours per
month per account (wraith's [`docs/DUAL_NETWORK.md`](https://github.com/Miracle656/wraith/blob/main/docs/DUAL_NETWORK.md)
records this as **750 h/month**). Three services running always-on is roughly
`3 × 730 = 2,190` instance-hours — about **three times** the cap.

That has a consequence for this plan, and it is counter-intuitive:

> **Pinging a free-tier service every 5 minutes to keep it awake spends the very
> quota whose exhaustion suspends it.** The keep-warm strategy named in
> [wraith#166](https://github.com/Miracle656/wraith/issues/166) and
> [lens#120](https://github.com/Miracle656/lens/issues/120) works for *one*
> service, not three. Confirm the cause before re-enabling any keep-warm ping.

Alternative causes worth ruling out in the same visit: billing/payment state,
and manual suspension.

---

## 2. What is exported today

Verified by reading the source on 30 August 2026, not from the issue tracker.

### Lens — **has metrics** ✅

> **Correction to issue #631.** The issue states lens has "no `/metrics` route,
> no `prom-client` dependency … despite lens#16 and lens#33 both being closed as
> completed". That is wrong. Both are present and lens#16/#33 were closed
> correctly. No follow-up is needed for the endpoint; the gap is narrower (below).

- `GET /metrics` — public, Prometheus exposition (`src/index.ts`)
- `GET /status` — public: `ok`, `watchedPairs`, `lastIndexedLedger`, `lastProcessedAt`
- `prom-client ^15.1.3`, registry in `src/metrics.ts`, default label `app=lens`

| Metric | Type | Covers |
|---|---|---|
| `trades_ingested_total{pair}` | counter | ingest throughput |
| `amm_snapshots_total{pool}` | counter | ingest throughput |
| `price_snapshots_total` | counter | snapshot pipeline |
| `price_requests_total` | counter | API demand |
| `x402_payments_received_total` | counter | paid-call volume |
| `last_trade_timestamp{pair}` | gauge | **price staleness per pair** |
| `db_query_duration_seconds` | histogram | DB latency |

### Wraith — **no metrics endpoint**, but health is observable

- `GET /healthz` and `GET /status` (`src/api.ts`)
- `/status` already returns `status: healthy \| degraded \| down` **and
  `lagLedgers`** — so *ledger lag*, the headline indexer metric, is available
  today without Prometheus.
- No `prom-client`, no `/metrics`. Tracked by
  [wraith#39](https://github.com/Miracle656/wraith/issues/39).

### Agent

- `GET /health` (`packages/agent/src/server.ts`). No metrics.

### The real gap

Not "lens has no metrics". It is that **no service exports HTTP-level request
rate, error rate or latency** — the three the scope asks for. Lens counts
*price* requests but not requests overall, and nothing counts 5xx. Wraith
exports nothing.

So of the scope's list:

| Signal | Status |
|---|---|
| Liveness | ✅ all three, via health endpoints + the probe |
| Ledger lag | ✅ wraith `/status.lagLedgers`; lens `/status.lastProcessedAt` |
| Price staleness per pair | ✅ lens `last_trade_timestamp{pair}` |
| Events processed | ✅ lens counters; ❌ wraith |
| Request rate | ⚠️ lens partial (`price_requests_total`); ❌ wraith |
| **Error rate** | ❌ **nowhere** |
| **p95 latency** | ⚠️ lens DB only; ❌ no HTTP histogram anywhere |
| RPC failure rate | ❌ nowhere |
| Feed fallback rate | ❌ nowhere |

Follow-ups to close these are listed in §6. Nothing above is claimed as
monitored when it is not.

---

## 3. Thresholds — page, ticket, or noise

"Page" here means *interrupt a person*. With a team this size that is a
Telegram message, not PagerDuty. The test for a page is: **is there something a
human must do right now that the system will not do for itself?**

| Condition | Level | Why |
|---|---|---|
| Critical endpoint `SUSPENDED` | **Page** | Never self-heals. Only a person can fix it. This is the current outage. |
| Critical endpoint 5xx / unreachable ≥ 2 consecutive probes | **Page** | Wallet is broken for every user. |
| Lens `lastProcessedAt` older than 60 min | **Page** | Worse than down: the wallet renders a stale price as if it were live. |
| Wraith `status=down` | **Page** | Database unreachable. |
| Wraith `lagLedgers` > 1000 | Ticket | Falling behind, still serving; recoverable. |
| Wraith `status=degraded` (RPC down, stale flag set) | Ticket | Degrades deliberately, serves `X-Data-Stale`. |
| `/metrics` missing or empty | Ticket | Blinds downstream monitoring; users unaffected. |
| Agent `/health` down | Ticket | Chat degrades; wallet keeps working. |
| Single slow response (cold start, 10–60 s) | **Noise** | Expected on free tier. Explicitly not alerted. |
| One failed probe that the next one clears | **Noise** | Transient. Requires two in a row. |

**Deliberately not alerted:** cold starts, and non-critical targets. Alerting on
those would fire most days, and an alert that fires most days is not an alert.

---

## 4. Where it lives

Three layers, cheapest first. This is meant to *agree* with
[wraith#166](https://github.com/Miracle656/wraith/issues/166) and
[lens#120](https://github.com/Miracle656/lens/issues/120) rather than invent a
parallel stack.

### Layer 1 — GitHub Actions synthetic probe ✅ *shipped with this document*

[`.github/workflows/uptime.yml`](../.github/workflows/uptime.yml) runs
[`scripts/uptime-probe.mjs`](../scripts/uptime-probe.mjs) every 30 minutes.
Fails the job — and so notifies watchers — when a **critical** target is down or
stale.

It lives in the repo, needs no external account, is reviewable in a PR, and is
runnable by hand:

```bash
node scripts/uptime-probe.mjs            # exit 1 if a critical target is unhealthy
node scripts/uptime-probe.mjs --json     # machine-readable
node scripts/uptime-probe.mjs --warn-only
WRAITH_URL=http://localhost:3001 node scripts/uptime-probe.mjs   # against a local stack
```

Why 30 minutes rather than 5: GitHub throttles scheduled workflows and drops
runs under load, so a tighter cron buys less than it appears to — and each probe
wakes a free-tier instance, spending the quota discussed in §1.

**Limitation, stated plainly:** GitHub's scheduler is best-effort and can delay
or skip runs. This layer is a floor, not an SLA. Layer 2 exists for that reason.

### Layer 2 — UptimeRobot (external, to configure)

Independent of GitHub, and it can notify when GitHub itself is the problem.
Not committable as code, so it is configuration to be recorded here once done:

| Monitor | URL | Interval | Alert |
|---|---|---|---|
| wraith | `https://wraith-0jo1.onrender.com/healthz` | 5 min | 2 failures |
| lens | `https://lens-ldtu.onrender.com/status` | 5 min | 2 failures |
| agent | `https://veil-agent.onrender.com/health` | 15 min | 2 failures |

⚠️ Resolve the quota question in §1 **before** enabling these — at 5-minute
intervals they are also a keep-warm ping, with the cost that implies.

### Layer 3 — Prometheus scrape (later)

Once wraith#39 lands, both services expose `/metrics` and any hosted Prometheus
can scrape them for rate/latency/error alerting. Not needed to close this issue,
and not worth standing up while the services are suspended.

### Client side

Wallet-side error reporting is [veil#442](https://github.com/Miracle656/veil/issues/442)
(Sentry + error boundary) — referenced, not duplicated here. It catches what
users see; this document catches what the backends do. A user-visible failure
with all backends green is a #442 problem.

---

## 5. Runbook

### `SUSPENDED` — a service is suspended

1. Do **not** retry, redeploy, or ping. Suspension does not clear on its own.
2. Render dashboard → the service → check for a quota, billing or manual-suspend
   banner.
3. If it is instance-hours: only one free service can run always-on. Decide
   which (**wraith and lens are the two the wallet needs**; the agent is
   optional), and move the rest to on-demand, a second account, or paid.
4. Record the cause in this file so the next person does not re-derive it.

### `DOWN` / `TIMEOUT` — 5xx or no response

1. Confirm it is not a cold start: probe again after 90 s. A cold start ends in
   a slow **200**.
2. Render → Logs. Look for a crash loop.
3. Common cause on this stack: the database is unreachable. Wraith reports
   `status=down` with `error: "Database unavailable"` for exactly that.
4. Check the Postgres provider is alive and inside its own free limits. Neon
   suspends idle databases; Render's own free Postgres is **deleted after 90
   days** (see DUAL_NETWORK.md).

### `DEGRADED` — up, but the data is stale

1. This is the dangerous state: the wallet shows numbers, and they are wrong.
2. Lens: `lastProcessedAt` old ⇒ ingesters are not running. Check the ingest
   loop and upstream (Horizon / Soroswap / Aquarius / Reflector) reachability.
3. Wraith: high `lagLedgers` ⇒ indexer behind. Check RPC. Note mainnet has no
   free public Soroban RPC — an expired provider key looks exactly like this.
4. If it cannot be fixed quickly, consider taking the feature dark rather than
   serving stale prices. Wraith already signals this with `X-Data-Stale`.

### Cold start — slow but fine

No action. Documented so nobody chases it.

---

## 6. Follow-ups this plan depends on

| Item | Where | Closes which gap |
|---|---|---|
| `/metrics` + `prom-client` in wraith | [wraith#39](https://github.com/Miracle656/wraith/issues/39) | wraith exports nothing |
| HTTP request/error/latency metrics in lens | *needs an issue* | error rate + p95 — the largest gap |
| HTTP metrics in wraith | folds into wraith#39 | same |
| RPC failure-rate counter | *needs an issue* | RPC health invisible |
| Feed fallback-rate counter (lens) | *needs an issue* | oracle fallback invisible |
| Confirm the Render suspension cause | Render dashboard | §1 hypothesis |
| Record UptimeRobot monitors here once created | this file, §4 | layer 2 |

---

## 7. Acceptance

Against the issue's own criteria:

- [x] **A `docs/MONITORING.md` a reviewer can read alongside the threat model.**
- [x] **At least one alert that would have caught the current 503s.**
      `scripts/uptime-probe.mjs` catches them *right now* — the output in §1 is
      its real output, and it exits 1. Verified in all three directions against
      local stubs: healthy → exit 0; 200-but-stale → `DEGRADED`, exit 1;
      suspended → `SUSPENDED`, exit 1 with the correct diagnosis.
- [x] **Named metrics that map to something actually exported.** §2 lists the
      seven lens metrics by name from `src/metrics.ts`, and marks every
      unexported signal ❌ rather than listing it as monitored.

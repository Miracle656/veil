# Wave batch — the money rails are the least observable part of wraith (W092–W111)

Drafted 2026-10-21 by reading `Miracle656/wraith` at `main`. Checked against the
open wraith issues first; nothing here duplicates one.

Two findings drove the whole batch.

**One: the naira rails emit no metrics at all.** `src/metrics.ts` exports nine
metrics and every one of them is about the indexer, HTTP or the database:

```
db_query_duration_seconds   http_request_duration_seconds   http_requests_total
events_skipped_total        last_indexed_ledger             ledgers_indexed_total
ledgers_skipped_total       rpc_errors_total                transfers_stored_total
```

Grep `src/api/ngn.ts`, `src/api/offramp.ts` and `src/linq/` for `metrics` and
you get nothing. The part of this service that moves real money is the part we
cannot see. We know when a ledger is skipped and not when a payout fails.

**Two: reconciliation is webhook-driven only.** `reconcileNgnOrder` runs from
`POST /webhooks/linq` and nowhere else. There is no periodic sweep. If a webhook
is never delivered — Linq drops it, or our endpoint is down — the order keeps
whatever status it was created with, forever, and nothing notices.

That is not hypothetical. **wraith crash-looped for roughly forty minutes on
2026-10-20** after a startup validator rejected the deployed configuration. Any
webhook Linq sent in that window is gone, and the orders behind them are stuck
with no mechanism that will ever correct them.

## Shared with every issue

**Repo:** `Miracle656/wraith` (Express + TypeScript + Prisma). Run `npm test`
(jest) and `npm run typecheck`. Both must pass.

**This service moves real money, and Linq has no sandbox.** Every `/ngn` and
`/offramp` route is mainnet-gated at the router for that reason. Test against
the fake provider in `src/__tests__`, never against Linq. A single careless
integration test spends somebody's naira.

**The provider rate limit is shared and real.** All Veil users share one Linq
key. Four manual probes of `/ngn/onramp/rate` returned `429 rate_limited`
during a review. Do not poll the live provider while developing.

**A NIN is personal data under Nigeria's NDPA.** It must never be stored,
logged, or placed in a test fixture. The existing KYC fixtures contain error
codes and messages only — keep it that way.

**Metrics labels must be bounded.** Label by things drawn from a finite set:
rail, route, outcome, network, provider error code. Never by an order id, a
customer reference, an amount, a URL or a raw provider message. An unbounded
label makes `/metrics` grow until it cannot be scraped.

**A schema change needs a migration.** This repo commits migrations under
`prisma/migrations/`, and neither `build` nor `start` applies one. A
`schema.prisma` change merged without a migration file means the column never
exists in production. After changing the schema run `npx prisma generate`
before `typecheck`, or you will chase errors that are not real.

**Never elide an address, a contract id or a key** in code, comments or test
fixtures. A previous batch shortened a contract id in an issue text and five
contributors invented their own to fill the gap.

---

### W092 · Nothing measures whether a Linq call succeeded

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background

Every naira operation is an HTTP call to Linq, and none of them is counted.
`src/linq/http.ts` is the single transport all three rails go through — offramp,
onramp and bills — which makes it the one place that can see every provider
call without touching the rails themselves.

Today a Linq outage is invisible until a user reports a failure.

### What to build

- A counter of provider calls by **endpoint path and outcome**, incremented in
  `src/linq/http.ts` so no rail can forget to do it.
- A histogram of provider latency, bucketed for the real distribution. Their
  calls are not fast and the existing budget is 35 seconds; buckets that stop
  at one second will tell you nothing.
- Outcome must distinguish at least: success, a 4xx the request caused, a 5xx
  the provider caused, a 429 rate limit, and a timeout. Those four failures have
  four different responses and collapsing them loses the signal.

### Acceptance criteria

- [ ] Every call through `linqCall` is counted, with no per-rail opt-in
- [ ] Labels are bounded: endpoint path and outcome only, never a message or an id
- [ ] Latency is observed for failures as well as successes
- [ ] A timeout is recorded as a timeout, not as a generic failure
- [ ] Tests assert the counters move, against the fake provider

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W093 · A 429 from the shared provider key is not counted anywhere

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

All Veil users share one Linq API key, and it is rate limited. The retry logic
in `src/linq/http.ts` already recognises a 429 and waits — `RATE_LIMIT_RETRIES`
exists precisely because a user hit one and succeeded on a second tap.

So we know this happens, we handle it, and we have no idea how often. Four
manual probes during a review were enough to trigger one.

Approaching the provider's limit is the kind of thing that degrades slowly and
then fails everyone at once.

### What to build

- Count 429s by endpoint, separately from other failures.
- Count how many were resolved by the retry and how many reached the user: a
  429 the retry absorbed is a warning, a 429 the user saw is an incident.
- Record the wait the provider asked for, if it sends one.

### Acceptance criteria

- [ ] 429s are counted separately from other 4xx responses
- [ ] Absorbed-by-retry and surfaced-to-user are distinguishable
- [ ] Labels stay bounded
- [ ] A test drives the fake provider to 429 and asserts both counters

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W094 · Order outcomes are not counted, per rail

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background

`POST /offramp/orders`, `POST /ngn/onramp/orders` and `POST /ngn/bills` each
create an order that moves money. None of them records that it happened.

There is no way to answer "how many cash-outs did we create today, and how many
reached a terminal state" without reading the database by hand.

### What to build

- A counter of orders created, by rail.
- A counter of orders reaching a terminal state, by rail and terminal status.
- Keep the label set to the rail and the status. An order id is not a label.

### Acceptance criteria

- [ ] Creation is counted for all three rails
- [ ] Terminal outcomes are counted where the status is known
- [ ] The rail is a label, so one rail failing is visible against the others
- [ ] No order id, customer reference or amount appears in a label
- [ ] Tests cover at least one rail end to end against the fake provider

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W095 · KYC failures are fixtured but not measured

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

`src/__tests__/linq/kycErrorFixtures.test.ts` and `fixtures/linq/kyc-errors.json`
pin every documented KYC failure code — `invalid_nin_format`,
`nin_already_used`, `nin_verification_failed` and the rest. We know exactly what
can go wrong.

We do not count which ones actually do. A NIN rail where verification quietly
starts failing for everyone looks identical to one where nobody is signing up.

### What to build

- Count KYC attempts by result, labelled with the **provider's documented error
  code** — a finite set, already enumerated in the fixtures.
- Nothing else. The NIN itself, the customer reference and the provider's prose
  message must never reach a label or a log line.

### Acceptance criteria

- [ ] KYC outcomes are counted by documented code
- [ ] An undocumented code is bucketed as `other`, not used as a label verbatim
- [ ] No NIN appears in any metric, label, log or fixture
- [ ] Tests drive each fixtured code and assert the counter

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W096 · A dropped webhook strands an order forever

**Labels:** help wanted, Stellar Wave, area:api, difficulty:advanced

### Background

`reconcileNgnOrder` is called from `POST /webhooks/linq` and nowhere else. There
is no sweep, no poll, no retry. If the webhook never arrives, the order keeps
the status it was created with for the rest of time.

**wraith crash-looped for about forty minutes on 2026-10-20.** Anything Linq
sent during that window is gone. The orders behind those events are still
sitting in their initial state, and nothing in this codebase will ever correct
them.

`GET /offramp/status` and `GET /ngn/onramp/orders/:orderId` can both ask Linq
what actually happened. Nothing calls them on a schedule.

### What to build

- A periodic job that finds orders in a non-terminal state older than a
  threshold and asks Linq for their real status, in the style of
  `src/jobs/retention.ts`.
- Bound it: a page of orders per run, oldest first, with a ceiling on provider
  calls per run. The shared rate limit is the constraint, not the database.
- Make it idempotent with the webhook path. Reuse `reconcileNgnOrder` rather
  than writing a second reconciliation that can disagree with the first.
- Give up eventually and mark an order as needing a human, rather than polling
  it forever.

### Acceptance criteria

- [ ] Non-terminal orders past a configurable age are re-checked against Linq
- [ ] The job shares the webhook's reconciliation logic, not a copy
- [ ] Provider calls per run are bounded and configurable
- [ ] Running it twice over the same order changes nothing the second time
- [ ] An order that cannot be resolved after N attempts is flagged, not retried forever
- [ ] Tests cover: resolved, still pending, and provider-unavailable

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W097 · Nothing says how many orders are stuck

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

Even with W096 reconciling them, nobody would know how many orders are waiting.
A gauge of non-terminal orders by age is the single most useful number this
service could publish about itself: if it climbs, money is in limbo.

This is deliberately separate from W096 so it can land first. The count is worth
having even while the reconciliation is still being written — arguably more so.

### What to build

- A gauge of orders in a non-terminal state, by rail and by age bucket.
- Age buckets, not exact ages: under an hour, under a day, older. Three
  buckets is a dashboard; a thousand is a cardinality problem.
- Refresh it on a timer, not per request. One query for the whole gauge.

### Acceptance criteria

- [ ] A gauge reports non-terminal orders by rail and age bucket
- [ ] It refreshes on a timer and does not query per scrape
- [ ] Buckets are a fixed, small set
- [ ] A test asserts the gauge reflects seeded rows

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W098 · Webhook events are accepted or rejected with no record of which

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

`POST /webhooks/linq` verifies a signature, finds the order across two tables,
and reconciles. Each of those can fail, and the failures mean completely
different things:

- a bad signature is somebody forging events
- an unknown `orderId` is an event for an order we never stored
- a reconciliation error is our bug

Today they are all just a log line, and the comment in `linqWebhook.ts` already
notes that a failed reconciliation is "now missing and only the log records it".

### What to build

- Count webhook events by outcome: accepted, bad signature, unknown order,
  reconciliation failed.
- Keep the provider's event type as a label only if it is a known finite set;
  otherwise bucket it.

### Acceptance criteria

- [ ] All four outcomes are counted distinctly
- [ ] A bad signature is countable without logging the body
- [ ] Labels are bounded
- [ ] Tests cover each outcome

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W099 · A deploy is a person remembering to click something

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate

### Background

There is no deploy workflow in `.github/workflows/`, no `render.yaml`, and
`start` is `node dist/index.js`. Deploying is manual, and on 2026-10-20 the
running instance was found to be **nine commits behind `main`** — including a
route the mobile client had already shipped against, which it was receiving
404s for.

Work merges, nobody deploys, and the gap is invisible because nothing reports
which commit is running.

### What to build

- Report the running commit. An endpoint, or a field on `/status`, that says
  which SHA is live. Without it there is no way to tell deployed from merged.
- Then automate the deploy, or document the manual steps precisely in
  `docs/` — either is a real answer, and saying which was chosen matters more
  than which one it is.

### Acceptance criteria

- [ ] The running commit is reported somewhere a maintainer can read it
- [ ] The value comes from the build, not from a file someone updates by hand
- [ ] Either a deploy workflow exists, or the manual procedure is documented
- [ ] The PR states which approach was taken and why

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W100 · Nothing applies a migration, so a schema change is an outage

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate

### Background

This repo commits its migrations — there are nine under `prisma/migrations/` —
and nothing runs them. `build` is `tsc`, `start` is `node dist/index.js`.

So a PR that adds a column and its migration still leaves the column missing in
production until somebody runs it by hand. On the offramp that is worse than a
plain failure: `createOfframpOrder` calls Linq **before** writing our row, so a
failed insert leaves a real provider payout order with no record of ours.

This nearly happened: PR #210 added `requestHash` with no migration at all.

### What to build

- Apply migrations as part of starting or deploying, or fail loudly when the
  database is behind what the code expects. Either is defensible; silently
  running against an older schema is not.
- Be careful with `prisma migrate deploy` here: past use of `prisma db push`
  means `_prisma_migrations` may not record migrations that are in fact
  applied, so a naive deploy may try to recreate existing objects. Investigate
  the real state before choosing, and write down what you found.

### Acceptance criteria

- [ ] A schema newer than the database is detected, not ignored
- [ ] The chosen mechanism is documented, including why
- [ ] The `_prisma_migrations` state is checked and the finding recorded
- [ ] Nothing drops or rewrites an existing table

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W101 · Mainnet indexing has never run, and only `/status` quietly says so

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:easy

### Background

The deployed service reports this today:

```json
"mainnet": {
  "lastIndexedLedger": null,
  "running": false,
  "reason": "[wraith] SOROBAN_RPC_URL_MAINNET is required to index mainnet..."
}
```

`planNetworks()` handles it exactly right — it skips that network, keeps testnet
indexing and the whole HTTP API serving, and says why. That design is correct
and should not change.

But nothing draws attention to it. A network that has never indexed looks the
same as one that is merely behind, and `ok` is still `true`.

### What to build

- Make a configured-but-not-running network visible beyond a nested field:
  a metric, and a clear signal in the top-level status.
- Distinguish **never started** from **started and stalled**. They have
  different causes and different fixes.
- Do not make it fatal. The naira rails never touch Soroban RPC, and refusing
  to serve them over a missing mainnet endpoint is the bug that took the
  service down on 2026-10-20.

### Acceptance criteria

- [ ] A network that is enabled but not running is reported as a metric
- [ ] Never-started and stalled are distinguishable
- [ ] The HTTP API keeps serving regardless
- [ ] A test covers the enabled-but-unconfigured case

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W102 · The GraphQL cost limiter is the only module with no test at all

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`src/graphql/costLimit.ts` is referenced by **zero** test files. Every other
module in `src/` is reached by at least one.

It is also a denial-of-service control: it decides which queries are too
expensive to run. An untested limiter is a limiter nobody has watched refuse
anything, which is the same position the fuzz job was in when it was reporting
panics it never found.

### What to build

- Tests that a query over the cost ceiling is refused, and one under it runs.
- A test that the refusal names the cost and the ceiling, so a legitimate
  caller can tell what to change.
- Cover the edge the limiter exists for: a query that is cheap to write and
  expensive to run — deep nesting, wide field selection, or a large `first`.

### Acceptance criteria

- [ ] An over-cost query is refused and the refusal is asserted
- [ ] An under-cost query still runs
- [ ] The computed cost is asserted for at least one known query
- [ ] The error names both the cost and the limit

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W103 · A failed payout tells nobody

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background

When an offramp order fails, the user sees an error. Nothing else happens.

There is no alert, no queue of failures for somebody to look at, no count. The
`webhooks` worker exists for notifying *subscribers* about on-chain transfers —
it is not an operational alerting path.

A payout that fails after the user's crypto has been taken is the single worst
state this system can reach, and it currently has to be reported by the user.

### What to build

- A durable record of money-affecting failures: order failed, payout rejected,
  reconciliation gave up. Enough to answer "what broke today" without a log
  search.
- Keep it separate from ordinary request errors. A 400 for a malformed bank
  code is not an incident; a failed payout is.
- An operator-readable surface — an endpoint, a table, or both.

### Acceptance criteria

- [ ] Money-affecting failures are recorded durably, not only logged
- [ ] Ordinary validation errors are excluded
- [ ] The record names the rail, the order and what failed — never a NIN
- [ ] An operator can list recent failures without database access
- [ ] Tests cover at least two distinct failure kinds

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W104 · The offramp and the onramp answer "is this up?" differently

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

`GET /offramp/availability` exists and answers `{"available":true}` without
calling the provider — added because the mobile client had been using the
pricing endpoint as a health check, and a change to pricing semantics became a
feature outage for installed builds.

The naira rails have no equivalent. The mobile client probes
`GET /ngn/onramp/rate?coin=usdc` instead, which is a quoting endpoint that costs
a provider call and spends the shared rate allowance on a question that needs
no provider at all.

### What to build

- An availability endpoint for the `/ngn` surface, matching the offramp's shape
  and making no provider call.
- It must answer the question actually being asked: is this deployment
  configured and on a network where the rails work.

### Acceptance criteria

- [ ] An availability route exists for the naira rails
- [ ] It makes no call to Linq
- [ ] Its shape matches `/offramp/availability`
- [ ] It is documented in `docs/ngn-rails.md`
- [ ] Tests cover configured, unconfigured and wrong-network

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W105 · Nothing proves the fake provider still matches the real one

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

Linq has no sandbox, so the fake provider in `src/__tests__` is the only way
these rails are exercised. Everything we believe about the money paths rests on
it being an accurate imitation.

Nothing checks that it is. If Linq changes a field name or a status value, every
test still passes and production breaks.

### What to build

- Pin the provider's response shapes as fixtures, the way the KYC error codes
  already are, and have the fake serve those fixtures rather than hand-written
  objects.
- Record where each fixture came from — the documented shape, or an observed
  response with the date.
- A test that fails if the fake and the fixtures drift apart.

### Acceptance criteria

- [ ] The fake provider serves responses derived from fixtures
- [ ] Each fixture records its provenance
- [ ] Drift between fake and fixture fails a test
- [ ] No fixture contains a NIN, a key or a real customer reference

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W106 · `/status` cannot say whether the money rails can work

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

`/status` reports indexer health per network in detail. It says nothing about
the thing users actually touch: whether a cash-out or a bill payment could
succeed right now.

A deployment with no Linq key serves `/status` as healthy and fails every naira
request with a 503 from the router.

### What to build

- Report whether the naira rails are configured on this deployment, as part of
  `/status`.
- Configuration only — do not call the provider from a status endpoint, or
  `/status` becomes a way to spend the shared rate limit.
- Keep it distinct from indexer health: both can be true or false independently.

### Acceptance criteria

- [ ] `/status` reports whether the rails are configured
- [ ] No provider call is made
- [ ] Indexer health and rail configuration are separate fields
- [ ] A test covers configured and unconfigured

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W107 · Provider latency is invisible, so a slow Linq looks like a slow wraith

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

`http_request_duration_seconds` measures our own endpoints. When
`POST /ngn/bills` takes twelve seconds, that histogram says twelve seconds and
cannot say whether eleven of them were Linq.

The total budget for a provider call is 35 seconds. Without splitting our time
from theirs, no latency question about the money rails can be answered.

### What to build

- Record time spent inside the provider call separately from total request time.
- Make the two comparable on a dashboard, so "the provider is slow" and "we are
  slow" are distinguishable at a glance.

### Acceptance criteria

- [ ] Provider time is observed separately from total request time
- [ ] Both are available for the same request path
- [ ] Buckets suit a 35-second budget
- [ ] A test asserts provider time is recorded on a slow fake response

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W108 · A retry that silently doubles a budget is only caught by reading the code

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`retryOnProviderFailure` takes a `deadline` precisely because, without it, the
retry doubled the caller's whole budget — a 35-second ceiling silently became
70. The comment records this.

Nothing tests it. A future caller that forgets to pass `deadline` reintroduces
the same bug and no test notices.

The same file documents that onramp orders and bills carry **no idempotency
key**, so a retry after a lost answer places a second, unpaid order. That is
pinned in `docs/idempotency.md` but it is the kind of claim worth holding to a
test.

### What to build

- A test that the retry plus its wait cannot exceed the deadline.
- A test that a call made without a deadline is still bounded, or that it is
  impossible to make one.
- Tests that pin the three idempotency cases the retry sits in front of:
  keyed offramp, keyed customer, unkeyed onramp and bill.

### Acceptance criteria

- [ ] The retry pair is proven to stay inside the deadline
- [ ] Each of the three idempotency cases is pinned by a test
- [ ] Tests use the fake provider, never a real call
- [ ] The unkeyed case's risk is stated in the test, not just in docs

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W109 · The naira rails have no runbook

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy

### Background

`docs/ngn-rails.md` describes endpoints, guards and field shapes well. It does
not say what to do when something goes wrong.

When the service crash-looped on 2026-10-20 the questions were: which orders
are affected, what does Linq think happened to them, how do we reconcile by
hand. The answers existed only in somebody's head.

### What to build

- A runbook section covering, at minimum: a provider outage, a dropped webhook,
  an order stuck in a non-terminal state, and the rate limit being hit.
- For each: how to tell it is happening, what to check, and what is safe to do.
- Be explicit about what is **not** safe — re-creating an order that may
  already exist at the provider is how one payout becomes two.

### Acceptance criteria

- [ ] A runbook covers at least those four situations
- [ ] Each entry says how to detect it and what to check
- [ ] Unsafe actions are named as unsafe, with the reason
- [ ] Any command given is one a maintainer can actually run

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W110 · Errors from the provider reach the client in three different shapes

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background

`sendLinqError` exists to pass Linq's own message through, because their 400s
explain the real problem better than anything we would invent. Alongside it the
routes return hand-written shapes: `{ error }` in most places, `{ error, code }`
for the newer coin and idempotency refusals.

A client cannot tell reliably whether a failure carries a machine-readable
`code`. The mobile app already branches on `coin_not_available` and
`rate_out_of_date`, so the shape matters.

### What to build

- One error shape across `/ngn` and `/offramp`: a stable machine-readable
  `code`, a human `error`, and nothing that leaks provider internals.
- Keep passing Linq's message through where it is genuinely more useful — that
  reasoning is sound — but behind a code the client can switch on.
- Document the codes. A code a client cannot discover is not an API.

### Acceptance criteria

- [ ] Every error response on both surfaces carries a `code`
- [ ] Codes are documented in `docs/ngn-rails.md`
- [ ] Existing codes keep their current values — installed APKs branch on them
- [ ] No connection string, key or stack reaches a response body
- [ ] Tests assert the shape on at least one failure per rail

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W111 · Nobody can tell what a deployment is configured to do

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy

### Background

wraith's behaviour is almost entirely environment-driven: which networks index,
whether the naira rails exist, whether the candles route is mounted, which RPC
is used, what the retention window is. `.env.example` documents the variables
one at a time.

What it does not give is the shape of a *deployment*. The live instance runs
testnet indexing, mainnet-gated naira rails, and no mainnet RPC — a combination
that is entirely sensible and that nothing in the repo describes.

### What to build

- Document two or three real configurations end to end: what each is for, which
  variables it sets, and what it will and will not do.
- Include the live one, honestly, including the parts that are off.
- Say which variables are secrets and must never be committed.

### Acceptance criteria

- [ ] At least two complete configurations are documented
- [ ] The deployed configuration is among them and described accurately
- [ ] Each says explicitly what it does not do
- [ ] Secrets are marked as such
- [ ] No real key, URL with an embedded key, or connection string appears

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

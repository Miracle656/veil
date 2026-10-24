# Wave batch — Lens reliability & ops (L162–L186)

Drafted 2026-10-16 by reading `Divinity-Labs/Lens` at `8e966ef`. Every number
and line reference below was checked against that commit.

The theme: Lens is a price API that other people's money depends on. It is in
good shape on the surface — 57 test files, ~620 passing tests, a clean
typecheck, Prometheus metrics, OpenAPI. Underneath, the service has almost no
answer to the question "what happens when something goes wrong?". Five of six
outbound HTTP calls cannot time out. Nothing handles SIGTERM. A crash-looping
ingester is invisible. Four separate places turn a network failure into "this
venue has no liquidity", which is a wrong price rather than a missing one.

These 25 issues are deliberately small and independent. They touch different
files on purpose so they can be worked in parallel without fighting each other.

## Shared with every issue

**Repo:** `Divinity-Labs/Lens`. Node + TypeScript, Fastify, Prisma on Postgres,
Redis for queues, Prometheus via `prom-client`.

**Run the tests:** `npm test`. **The tests are vitest, not jest.** Running jest
against this repo reports "66 suites, 0 tests" and means nothing. A single file
is `npx vitest run src/__tests__/yourfile.test.ts`.

**`Load test (prices)` is already failing on `main`** and has been for some
time. It is not your PR that broke it. Every other check should be green.

**This service prices real assets on Stellar mainnet.** A number that is wrong
is worse than a number that is missing, because a caller cannot tell the
difference. Prefer failing loudly over returning a plausible value.

**Never elide an address, a contract id or a key in code, a comment or a test
fixture.** A previous batch wrote a shortened contract id in an issue text and
five contributors invented plausible-looking ids to fill the gap. Write the
whole thing or do not write it at all.

**The house pattern for an outbound deadline already exists** — see
`src/alerts/delivery.ts`, which passes `signal: AbortSignal.timeout(10_000)` to
`fetch`. Where an issue below asks for a timeout, copy that, do not invent a
second convention.

---

### L162 · Five of six outbound fetches cannot time out

**Labels:** help wanted, Stellar Wave, area:reliability, difficulty:intermediate

### Background

`src/alerts/delivery.ts` gets this right:

```ts
res = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Lens-Signature': signature },
  body: payload,
  signal: AbortSignal.timeout(10_000),
})
```

Every other outbound call in the service omits the signal entirely:

```
src/ingest/venues/aquarius.ts:54   await fetch(`${apiUrl}?${params.toString()}`)
src/ingesters/amm.ts:36            await fetch(`${horizon}/liquidity_pools?…`)
src/ingesters/amm.ts:133           await fetch(…)
src/ingesters/soroswap.ts:75       await fetch(tokenListUrl)
src/mcp/server.ts:83               await fetch(endpoint)
```

`fetch` has no default timeout in Node. A TCP connection that is accepted and
then never answered — which is exactly what a hung upstream or a dropped NAT
mapping looks like — leaves that `await` pending forever. The ingester holding
it does not crash, so `restartIngester` never fires: the venue simply stops
producing prices, silently, until someone redeploys.

### What to build

- A single helper that wraps `fetch` with a deadline, used by all five sites.
  Keep the existing `AbortSignal.timeout` approach — the point is one
  convention, not a new one.
- A timeout must be distinguishable from an empty response at the call site, so
  that L163's work can report it. Throw rather than returning a falsy value.
- The deadline should be configurable per call, because an MCP tool call and a
  Horizon page fetch do not deserve the same budget. Give it a sensible default.

### Acceptance criteria

- [ ] No `fetch(` call in `src/` is without a timeout
- [ ] One helper is used by every call site; `delivery.ts` keeps working
- [ ] A test proves a hung server causes a rejected promise within the deadline, not a pending one
- [ ] The timeout value is configurable and documented in `.env.example` if it becomes an env var

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L163 · A failed venue fetch is indistinguishable from an empty venue

**Labels:** help wanted, Stellar Wave, area:data-integrity, difficulty:intermediate

### Background

Four places turn a thrown error into "there is nothing here":

```
src/ingesters/amm.ts:43-44             console.error(…); return []
src/ingesters/soroswap.ts:80-81        console.error(…); return []
src/ingest/venues/aquarius.ts:59-60    console.error(…); return []
src/ingest/oracles/reflector.ts:91-92  } catch { return null }
```

The caller cannot tell a genuinely empty venue from an unreachable one. For a
price aggregator that distinction is the whole game: if Aquarius is down and we
report zero pools, the aggregate silently reweights onto the venues that did
answer and publishes a price that looks completely normal. Nobody is alerted,
because from the aggregator's point of view nothing failed.

`reflector.ts` is the sharpest case — it swallows the error without even
logging it, so there is no record that an oracle read failed at all.

### What to build

Make failure a distinct outcome from emptiness, all the way to the aggregate.

- Each of these functions should signal failure to its caller rather than
  returning an empty collection — a thrown error, or a result type carrying the
  distinction. Pick one shape and use it in all four.
- A venue that failed must be **excluded** from the aggregate, not counted as
  contributing zero.
- Record which venues failed on the aggregate, so `/status` and L167 can report it.
- No `catch {}` without at least a log line.

### Acceptance criteria

- [ ] A failing venue and an empty venue produce different results, asserted by a test
- [ ] A failing venue does not reweight the aggregate as though it answered with nothing
- [ ] `reflector.ts` logs its failures
- [ ] The set of failed sources for a given aggregate is retrievable, not just logged

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L164 · Nothing handles SIGTERM, so every deploy interrupts in-flight work

**Labels:** help wanted, Stellar Wave, area:reliability, difficulty:intermediate

### Background

There is no signal handler anywhere in `src/`. The only `process.on` match in
the tree is inside a comment in `src/api/websocket.ts`. So on every deploy the
platform sends SIGTERM, Node's default handler exits immediately, and whatever
was in flight stops where it stood: a half-written batch of price points, an
open Prisma transaction, a Redis job claimed but not acknowledged, and every
websocket client dropped without a close frame.

Lens runs ingesters as infinite background loops started from `src/index.ts`,
which makes this worse than it would be for a plain request/response service —
there is always something in flight.

### What to build

- A shutdown handler for `SIGTERM` and `SIGINT` that stops accepting new work,
  lets in-flight work finish within a bounded grace period, then exits.
- Order matters: stop the ingester loops and the HTTP listener first, drain, then
  close Prisma and Redis.
- A hard deadline so a stuck drain cannot hang the deploy forever. Log loudly if
  the deadline is hit rather than exiting silently.
- Make it idempotent — a second SIGTERM during shutdown must not start a second drain.

### Acceptance criteria

- [ ] `SIGTERM` and `SIGINT` both trigger a graceful shutdown
- [ ] The HTTP server stops accepting connections before dependencies close
- [ ] Prisma and Redis are closed explicitly
- [ ] A bounded grace period exists and is configurable; exceeding it is logged
- [ ] A test proves a second signal during shutdown does not re-enter the drain

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L165 · A crash-looping ingester is invisible

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:intermediate

### Background

`src/index.ts` restarts a crashed ingester like this:

```ts
const restartIngester = (name: string, network: NetworkName, fn: () => Promise<void>) => {
  fn().catch(err => {
    console.error(`[lens] ${name}/${network} ingester crashed, restarting in 10s:`, err.message)
    setTimeout(() => restartIngester(name, network, fn), 10_000)
  })
}
```

The fault isolation is good and the comment above it explains the design well.
What is missing is any awareness of *how often* this happens. An ingester that
crashes immediately on start will restart every ten seconds forever. There is no
backoff, no cap, no metric, and `/status` does not mention it — so the service
reports itself healthy while one venue has produced nothing for a week.

### What to build

- Exponential backoff with a ceiling, instead of a flat ten seconds.
- A counter metric of restarts, labelled by ingester name and network, exported
  through the existing `prom-client` registry in `src/metrics.ts`.
- A record of the last crash — time and message — per `(ingester, network)`, so
  L167 can surface it on `/status`.
- Reset the backoff once an ingester has run healthily for some period, so a
  nightly blip does not permanently slow restarts.

### Acceptance criteria

- [ ] Restart delay grows on repeated failure and is capped
- [ ] Backoff resets after a sustained healthy run
- [ ] A Prometheus counter exposes restarts per ingester and network
- [ ] Last crash time and message are retrievable per ingester
- [ ] The existing fault isolation is preserved — one venue crashing still cannot affect another

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L166 · Sixty-five console calls and no structured logger

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:intermediate

### Background

`src/` contains 65 `console.log` / `console.warn` / `console.error` calls
outside tests, and zero uses of a logger. Fastify ships pino and already has a
configured logger on every request as `req.log`, so the dependency is present
and unused.

Practical consequences: no log levels, so nothing can be turned down in
production; no JSON, so a log aggregator cannot index fields; and no correlation
between a line and the request that caused it. When a caller reports a bad price
at 14:03, there is no way to find the work that produced it.

### What to build

- Route logging through pino — `req.log` inside request handlers, a module-level
  child logger for ingesters and jobs.
- Give each child logger a stable component name (`ingester:amm`, `job:retention`)
  so lines can be filtered by subsystem.
- Keep the existing `[lens]` / `[amm]` prefixes as structured fields rather than
  interpolated text.
- Make the level configurable by environment variable, defaulting to `info`.
- Never log a secret, an API key or a full connection string. This repo has
  leaked a connection string through an error message before.

### Acceptance criteria

- [ ] No `console.*` calls remain in `src/` outside tests
- [ ] Log level is configurable and documented in `.env.example`
- [ ] Logs are JSON in production and human-readable in development
- [ ] Component name is a field, not part of the message text
- [ ] A test asserts that no logger call includes `DATABASE_URL` or an API key value

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L167 · /status does not say whether ingestion is actually working

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:intermediate

### Background

`/status` is defined at `src/api/rest.ts:72` and is the endpoint an uptime
monitor will poll. It answers from the process's own point of view. It does not
report whether any ingester is running, when each venue last produced a price,
or whether an ingester has been crash-looping — which means a service with every
ingester dead still returns a healthy `/status` and a green uptime check.

This is the issue that makes L163 and L165 useful: both produce information that
currently has nowhere to go.

### What to build

Extend `/status` with per-venue, per-network ingestion health:

- Last successful write time per `(venue, network)`, and the age of it.
- Whether that age exceeds an expected interval for that venue.
- Restart count and last crash message, if L165 has landed; design for it being absent.
- An overall verdict that an uptime monitor can alert on.

Keep the existing fields — callers depend on them. The route is `public: true`
and allow-listed from rate limiting in `src/app.ts`, so it must stay cheap: no
unbounded queries, and do not add a Horizon round-trip to it.

### Acceptance criteria

- [ ] `/status` reports last-write age per venue and network
- [ ] A stale venue is visibly distinct from a healthy one
- [ ] Existing response fields are unchanged
- [ ] The handler issues a bounded, small number of queries regardless of how many pairs exist
- [ ] A test asserts the stale case is reported as unhealthy

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L168 · There is no readiness check, only a status page

**Labels:** help wanted, Stellar Wave, area:reliability, difficulty:easy

### Background

`/status` is the only health-ish endpoint. A platform needs two different
answers and they are not the same question:

- **liveness** — is this process wedged and in need of a kill? Must not depend on
  Postgres or Redis, or a database blip restarts healthy processes in a loop.
- **readiness** — should this process receive traffic yet? Must check that
  migrations are applied and dependencies are reachable, so a starting instance
  is not sent requests it will fail.

Lens starts ingesters, a Redis-backed retention worker and a websocket fanout
before it is genuinely able to serve, so the gap is real.

### What to build

- `/live` — no dependency checks, returns healthy if the event loop is turning.
- `/ready` — checks Postgres and, where configured, Redis; returns unhealthy
  until the app has finished booting.
- Both `public: true` and allow-listed from rate limiting, as `/status` is.
- Neither should be expensive enough to matter when polled every few seconds.

### Acceptance criteria

- [ ] `/live` returns healthy without touching Postgres or Redis
- [ ] `/ready` returns unhealthy before boot completes and healthy after
- [ ] `/ready` reports unhealthy when Postgres is unreachable
- [ ] Both are excluded from rate limiting and from `httpMetrics` route cardinality
- [ ] `/status` is unchanged

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L169 · One slow websocket client can grow the server's memory without limit

**Labels:** help wanted, Stellar Wave, area:websocket, difficulty:intermediate

### Background

`src/ws/fanout.ts` sends to a client like this:

```ts
private sendToClient(client: InternalClient, payload: string): void {
  try {
    client.socket.send(payload)
    ws_messages_sent_total.labels(client.pairKey).inc()
    ws_messages_sent_total.labels('*').inc()
  } catch {
    this.unregister(client.id)
  }
}
```

`send()` does not block and does not throw when the peer is merely slow — it
queues. A client on a bad mobile connection, or one that has stopped reading,
accumulates payloads in the socket's internal buffer. Nothing inspects
`bufferedAmount`, so there is no upper bound on that growth, and the metric
counts the message as sent when it has only been queued.

With a price feed pushing updates continuously, one stuck subscriber is enough
to grow the process until it is OOM-killed, taking every other subscriber with it.

### What to build

- Check `bufferedAmount` before sending. Past a threshold, treat the client as
  unable to keep up.
- Decide and document the policy: drop the slow client with a close code, or
  drop intermediate updates and send only the newest. For a price feed the
  newest value is usually the only one that matters, and `fanout.ts` already has
  a `pendingUpdate` coalescing concept to build on.
- Count the outcome in a metric so slow clients are visible rather than silent.
- Only count a message as sent when it was actually written.

### Acceptance criteria

- [ ] A client whose buffer exceeds the threshold is handled by a documented policy, not ignored
- [ ] The threshold is configurable
- [ ] A test with a stalled socket proves memory does not grow without bound
- [ ] Dropped or coalesced updates are counted in a metric
- [ ] A slow client cannot affect delivery to other clients

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L170 · Dead websocket connections are never reaped

**Labels:** help wanted, Stellar Wave, area:websocket, difficulty:easy

### Background

Neither `src/api/websocket.ts` nor `src/ws/fanout.ts` contains any ping, pong or
heartbeat handling. A TCP connection that dies without a close frame — a laptop
lid closing, a phone losing signal, a NAT mapping expiring — stays in the
`clients` map indefinitely. The server keeps serialising and queueing updates
for a peer that is gone.

`fanout.ts` keeps two maps keyed by client id, so every such ghost also holds a
subscription entry that makes every fanout loop slightly more expensive, forever.

### What to build

- A periodic ping to every connected client.
- Track pong responses; a client that misses a configurable number of
  consecutive pings is closed and unregistered.
- Make sure unregistering cleans up **both** `clients` and `pairClients`, so no
  subscription entry is orphaned.
- A gauge of currently connected clients, so a leak is visible on the dashboard.

### Acceptance criteria

- [ ] Clients are pinged on a configurable interval
- [ ] A client that stops responding is closed and removed
- [ ] Both internal maps are cleaned up on removal, asserted by a test
- [ ] A connected-clients gauge is exported
- [ ] A normal client with a slow but live connection is not disconnected

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L171 · The websocket metric's label grows without bound

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:intermediate

### Background

`src/ws/fanout.ts` increments:

```ts
ws_messages_sent_total.labels(client.pairKey).inc()
```

`pairKey` is user-supplied through the subscription — it is whatever pair a
client asked for. Prometheus creates a new time series for every distinct label
value and keeps it for the lifetime of the process, so the number of series
grows with the number of distinct pairs ever subscribed to, not with the number
of pairs that exist.

A client subscribing to randomly generated pair keys can grow the `/metrics`
response without limit. Even without malice, a screener that walks every pair
produces thousands of permanent series. This is the standard Prometheus
cardinality failure, and it ends with `/metrics` too slow to scrape.

### What to build

- Only label with a pair that is known — validate `pairKey` against the pairs
  the service actually tracks before using it as a label value.
- Unknown pairs should either be rejected at subscribe time or folded into a
  single `other` label.
- Audit the rest of `src/metrics.ts` and `src/middleware/httpMetrics.ts` for the
  same pattern; any label value derived from user input is a candidate.
- Document the rule in `src/metrics.ts` so the next metric does not reintroduce it.

### Acceptance criteria

- [ ] No metric label can take an unbounded set of values from user input
- [ ] A test subscribing to many unknown pairs does not create a series per pair
- [ ] The existing `*` aggregate label keeps working
- [ ] The rule is written down next to the registry definition

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L172 · Fourteen files read process.env directly, and nothing validates it

**Labels:** help wanted, Stellar Wave, area:config, difficulty:intermediate

### Background

`src/config.ts` exists and is 333 lines, reading `process.env` 34 times. It does
no validation — no schema, no zod, despite zod already being a dependency used
for route validation. And 14 other files under `src/` read `process.env`
directly, bypassing it entirely, among them `src/db.ts`, `src/app.ts`,
`src/index.ts`, `src/api/admin.ts` and `src/bazaar/rateLimit.ts`.

The failure mode is a misspelled or missing variable becoming `undefined`, then
a default, then a service that starts cleanly and behaves wrongly. A numeric
limit read as `undefined` silently becomes `NaN` in arithmetic. Nothing fails
until a price is wrong.

### What to build

- One validated config module as the single source: parse and validate the whole
  environment once at startup with zod, and fail to start on anything invalid.
- Types derived from the schema, so a typo in a config key is a compile error.
- Replace the 14 direct reads with imports from it.
- Every variable documented in `.env.example`. The repo has a drift guard that
  checks this — run it.
- Required-in-production variables must be required, not silently defaulted.

### Acceptance criteria

- [ ] `process.env` is read in exactly one module
- [ ] Invalid or missing required configuration fails at startup with a message naming the variable
- [ ] Config values are typed from the schema
- [ ] `.env.example` documents every variable and the drift guard passes
- [ ] A numeric variable that is not a number is rejected rather than becoming `NaN`

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L173 · The database connection pool is unconfigured and unmeasured

**Labels:** help wanted, Stellar Wave, area:database, difficulty:intermediate

### Background

Nothing in `src/` or `prisma/` sets `connection_limit` or `pool_timeout`, so
Prisma's defaults apply. Lens runs HTTP handlers, several ingester loops per
network and a retention worker in one process, all sharing one pool, and the
deployment runs more than one instance — so the real limit against Postgres is
the pool size multiplied by the instance count, which nobody has worked out.

When the pool is exhausted, requests queue inside Prisma and surface as slow
responses rather than as a pool problem, which is close to impossible to
diagnose from the outside.

### What to build

- Set the pool size and the acquisition timeout explicitly, with a comment
  giving the arithmetic: pool × instances against the Postgres `max_connections`.
- Export pool metrics — in use, idle, waiting — through the existing registry.
- Make pool exhaustion diagnosable: a distinct log line and metric, not a generic
  timeout.
- Note in the README that the ingesters and the API share a pool, since that is
  the surprising part.

### Acceptance criteria

- [ ] Pool size and timeout are explicit and configurable
- [ ] A comment records the arithmetic against the database's connection limit
- [ ] Pool utilisation is exported as a metric
- [ ] Exhaustion produces a distinguishable error, asserted by a test
- [ ] `.env.example` documents any new variables

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L174 · Nothing measures how far behind ingestion is

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:intermediate

### Background

`src/metrics.ts` exports HTTP and websocket metrics. There is no metric for the
thing the service exists to do: how recently each venue produced a price, and
how long it took.

Without it, "prices are stale" is only discoverable by a human noticing a wrong
number. Lag is also the signal that distinguishes the three failure shapes this
batch is about — a hung fetch with no timeout (L162), a crash loop (L165) and a
venue returning empty on error (L163) all look identical from the outside but
have different lag signatures.

### What to build

- A gauge of seconds since the last successful write, labelled by venue and network.
- A histogram of ingestion cycle duration, labelled the same way. Choose buckets
  for this service as `src/metrics.ts` already does for HTTP rather than taking
  prom-client's defaults.
- A counter of ingestion errors by venue, network and a bounded error category.
- Keep label cardinality bounded — see L171.

### Acceptance criteria

- [ ] Lag per venue and network is exported as a gauge
- [ ] Cycle duration is a histogram with buckets chosen deliberately and a comment saying why
- [ ] Error counts are labelled with a bounded category set
- [ ] Metrics are registered on the existing registry and appear at `/metrics`
- [ ] A test asserts lag increases when no write occurs

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L175 · Webhook retries have no jitter, so failures synchronise

**Labels:** help wanted, Stellar Wave, area:reliability, difficulty:easy

### Background

`src/alerts/delivery.ts` backs off deterministically:

```ts
function retryDelayMs(attempt: number): number {
  return Math.pow(2, attempt - 1) * 1000
}
```

Every delivery that fails at the same moment retries at exactly the same moment
— 1s, then 2s, then 4s. A price movement is precisely the event that triggers
many alerts at once, so when a subscriber's endpoint has a wobble, Lens responds
by hitting it with a synchronised burst, three times, which is a good way to
turn a wobble into an outage.

### What to build

- Add jitter. Full jitter — a random value between zero and the computed delay —
  is the standard choice and is one line.
- Keep the existing retry count and the existing rule that 4xx is not retried,
  which is correct.
- Make the test deterministic by injecting the randomness rather than asserting
  on a range.

### Acceptance criteria

- [ ] Retry delays are jittered
- [ ] Two deliveries failing simultaneously retry at different times, asserted by a test
- [ ] 4xx responses are still not retried
- [ ] The attempt cap is unchanged
- [ ] The randomness source is injectable so the test is not flaky

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L176 · A webhook that fails three times disappears

**Labels:** help wanted, Stellar Wave, area:reliability, difficulty:intermediate

### Background

When `deliverJsonWithRetries` exhausts its attempts it does this:

```ts
console.warn(`[webhook] delivery failed after ${attempt} attempts to ${url}: HTTP ${res.status}`)
```

…and returns. The alert is gone. The subscriber never learns that an alert fired,
and the operator learns only if someone is reading warn-level logs at the moment
it happens. For an alerting product this is the worst possible failure, because
silence is indistinguishable from "nothing happened".

### What to build

- Persist failed deliveries — endpoint, payload, attempt count, last status, first
  and last attempt times.
- A counter metric of permanent delivery failures, labelled by a bounded category
  (not by URL — see L171).
- A way to see recent failures, either on an admin route or via `/status`.
- Do not store a delivery secret alongside the payload.
- Decide and document whether failed deliveries can be replayed; building replay
  is optional, but say which it is.

### Acceptance criteria

- [ ] An exhausted delivery is recorded durably, not only logged
- [ ] The record contains enough to diagnose without the original log line
- [ ] A metric counts permanent failures with bounded label values
- [ ] Secrets are not persisted
- [ ] Recent failures are retrievable through an endpoint

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L177 · A request cannot be traced from log line to log line

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:easy

### Background

There is no request id anywhere in the service. When a caller reports that
`/price` gave them a wrong number at a particular time, there is no way to find
the lines belonging to that request, and with more than one instance running the
lines are split across processes.

Fastify generates a request id for every request and exposes it as `req.id`
already — it is simply never used or returned.

### What to build

- Include `req.id` on every log line produced during a request. If L166 has
  landed, `req.log` already does this; if not, this issue can stand alone.
- Return it as a response header so a caller can quote it in a bug report.
- Accept an inbound correlation header if present and adopt it, so the id
  survives across a caller's own tracing.
- Include it in error response bodies, so a user-visible failure carries
  something searchable.

### Acceptance criteria

- [ ] Every request-scoped log line carries the request id
- [ ] The id is returned as a response header
- [ ] An inbound correlation header is honoured when supplied
- [ ] Error responses include the id
- [ ] A test asserts the header is present on both a success and an error

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L178 · An unhandled rejection takes the process down with no record

**Labels:** help wanted, Stellar Wave, area:reliability, difficulty:easy

### Background

There is no `process.on('unhandledRejection')` or `process.on('uncaughtException')`
handler. Node's default for an unhandled rejection is to terminate, so a single
missed `.catch()` anywhere — in an ingester, a job, a fanout timer — kills the
whole service, and the only evidence is whatever the platform happened to capture
on stderr.

This service is full of background work that is not awaited by anyone:
`restartIngester` calls `fn().catch(...)`, the retention fallback runs inside a
`setInterval`, and `fanout.ts` sends from timer callbacks.

### What to build

- Handlers for `unhandledRejection` and `uncaughtException` that log the error
  with its stack through the structured logger, then exit non-zero so the
  platform restarts cleanly.
- Do **not** swallow and continue — a process in an unknown state serving prices
  is worse than one that restarts.
- A counter metric so repeated crashes are visible after the fact.
- Make sure the graceful shutdown from L164 is not re-entered from this path.

### Acceptance criteria

- [ ] Both handlers are installed early in startup
- [ ] The full error and stack are logged before exit
- [ ] The process exits non-zero
- [ ] The handler does not attempt a normal graceful drain
- [ ] A test asserts the handler logs and exits rather than continuing

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L179 · Redis going away is noticed once and never again

**Labels:** help wanted, Stellar Wave, area:reliability, difficulty:intermediate

### Background

`src/index.ts` falls back when the Redis-backed retention worker cannot start:

```ts
} catch (err) {
  console.warn('[lens] Snapshot retention worker skipped (Redis unavailable):', (err as Error).message)
  console.warn('[lens] Falling back to an in-process hourly prune')
  await Promise.allSettled([retentionQueue?.close(), retentionWorker?.close()])
  setInterval(() => { void safePrune() }, 60 * 60 * 1000).unref()
}
```

The fallback itself is good design. The problem is that it is decided exactly
once, at boot, and never revisited. If Redis is briefly unavailable during a
deploy, the process spends its entire life on the in-process path — and because
every instance does its own hourly prune, with more than one instance they
overlap. `/status` says nothing about which path is in use, so the degraded mode
is invisible.

### What to build

- Expose which retention path is active, through `/status` and a gauge.
- Re-check Redis periodically and switch back to the queue when it returns,
  cancelling the interval cleanly.
- Make the in-process prune safe to run concurrently across instances, or guard
  it so only one instance prunes.
- Log the transition in both directions, at a level that is actually visible.

### Acceptance criteria

- [ ] The active retention path is visible without reading boot logs
- [ ] Redis returning causes a switch back, with the interval cleared
- [ ] Concurrent prunes across instances cannot corrupt or duplicate work
- [ ] Both transitions are logged
- [ ] A test covers the fallback and the recovery

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L180 · Nothing proves a deployed instance can actually answer

**Labels:** help wanted, Stellar Wave, area:testing, difficulty:intermediate

### Background

CI runs unit tests against mocks. Nothing checks that a *running* Lens answers
correctly — that `/price` returns a number with the right shape, that `/status`
is healthy, that the websocket accepts a subscription and pushes an update.

The failures in this batch are precisely the ones unit tests cannot catch: a
hung fetch, a dead ingester, an exhausted pool. All of them leave the process up
and the tests green.

### What to build

A smoke check that runs against a URL and exits non-zero on failure:

- `/status` and `/ready` report healthy.
- `/price` for a known pair returns a well-formed response within a time budget.
- The websocket accepts a connection, takes a subscription and delivers at least
  one message, or times out.
- Prices are fresher than a threshold, not merely present.

It must take the base URL as an argument so it works against local, staging and
production, and it must not require credentials beyond what a normal caller has.

### Acceptance criteria

- [ ] A single command runs the smoke check against any base URL
- [ ] It exits non-zero on any failure and prints which check failed
- [ ] It asserts freshness, not just presence
- [ ] It covers at least one websocket round-trip
- [ ] It runs in well under a minute and is documented in the README

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L181 · Websocket clients are dropped without a close frame on shutdown

**Labels:** help wanted, Stellar Wave, area:websocket, difficulty:easy

### Background

`FanoutManager.destroy()` exists in `src/ws/fanout.ts`, but with no signal
handler (L164) nothing calls it on shutdown. Clients therefore see the TCP
connection vanish rather than a close frame, which browsers surface as an error
rather than a normal closure — so a routine deploy looks to every connected
client like a fault, and reconnect logic that distinguishes clean from unclean
closes will take the pessimistic branch.

### What to build

- On shutdown, send every client a close frame with an appropriate code before
  the server exits, so clients can reconnect without treating it as an error.
- Give in-flight sends a brief window to flush before closing.
- Make `destroy()` idempotent and safe to call during an in-progress fanout.
- This complements L164 — it can be built independently and wired up when that lands.

### Acceptance criteria

- [ ] Clients receive a close frame with a deliberate code on shutdown
- [ ] In-flight sends are given a bounded window to flush
- [ ] `destroy()` is idempotent
- [ ] Calling it mid-fanout does not throw
- [ ] A test asserts a connected client observes a clean close

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L182 · Horizon rate limiting is not handled

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate

### Background

The AMM ingester calls Horizon directly:

```ts
const response = await fetch(
  `${getNetworkConfig(network).horizon.url}/liquidity_pools?${params.toString()}`
)
const data = await response.json() as any
if (!data._embedded?.records) return []
```

`response.ok` is never checked. A 429 from Horizon has no `_embedded.records`,
so it takes the same path as an empty result and the ingester reports that the
pair has no pools. Horizon publishes rate-limit headers and a `Retry-After`, and
none of them are read.

Under sustained rate limiting this ingester produces wrong data continuously
rather than backing off, and because of L163 the aggregate silently reweights
around it.

### What to build

- Check `response.ok` before parsing, everywhere Horizon is called.
- Treat 429 distinctly: honour `Retry-After` when present, otherwise back off
  exponentially with jitter.
- Surface remaining-quota headers as a gauge so approaching the limit is visible
  before it bites.
- A 429 must not be reported as an empty venue — coordinate with L163.

### Acceptance criteria

- [ ] Non-2xx responses are detected before the body is parsed
- [ ] 429 honours `Retry-After` when present and backs off otherwise
- [ ] A rate-limited fetch is not reported as an empty result
- [ ] Remaining quota is exported as a metric
- [ ] Tests cover 429 with and without `Retry-After`

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L183 · The MCP server's upstream call has no deadline and no error handling

**Labels:** help wanted, Stellar Wave, area:mcp, difficulty:easy

### Background

`src/mcp/server.ts:83` fetches an endpoint with no timeout and no status check.
MCP tools are called by agents, which typically have their own timeout and will
retry — so a hung call here becomes repeated hung calls, each holding a
connection, with no upper bound.

An agent is also the caller least able to interpret a malformed response: it
will take whatever shape comes back and reason over it, so a 502 HTML error page
parsed as JSON becomes a confident wrong answer in a conversation.

### What to build

- A deadline on the call, using the same helper as L162 if that has landed, or
  `AbortSignal.timeout` directly if not.
- Check the response status and content type before parsing.
- Return a structured MCP error on failure — a tool error the agent can act on,
  not a thrown exception or a half-parsed body.
- Make the failure message say which upstream failed and why.

### Acceptance criteria

- [ ] The call cannot hang indefinitely
- [ ] Non-2xx and non-JSON responses are rejected before parsing
- [ ] Failures surface as structured MCP tool errors
- [ ] The error names the upstream and the reason
- [ ] Tests cover timeout, non-2xx and non-JSON responses

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L184 · There is no runbook for the service

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy

### Background

Lens has ingesters, a websocket fanout, a Redis-backed retention worker with an
in-process fallback, multiple instances, and a Postgres database shared with
another service. None of that operational shape is written down. The knowledge
that the retention worker silently degrades when Redis is away, or that the
ingesters share a connection pool with the API, currently exists only in the
code and in whoever last read it.

### What to build

A runbook in the repo — `docs/RUNBOOK.md` — covering:

- The processes that run and what each one does.
- Every external dependency and what degrades when it is unavailable.
- How to tell whether ingestion is healthy, using `/status` and `/metrics`.
- The known failure modes in this batch and the symptom each presents.
- How to deploy, how to roll back, and what a deploy interrupts.
- That `Load test (prices)` is failing on `main` and is a known, unrelated red.

Write what is true today, including the ugly parts. A runbook describing an
aspirational system is worse than none.

### Acceptance criteria

- [ ] `docs/RUNBOOK.md` exists and is linked from the README
- [ ] Every external dependency is listed with its degraded behaviour
- [ ] Each documented symptom names the endpoint or metric that shows it
- [ ] Rollback is documented
- [ ] Nothing in it is aspirational — every claim is checkable against the code today

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L185 · Ingester loops have no upper bound on a single cycle

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate

### Background

Each ingester is an infinite loop restarted on crash by `restartIngester`. There
is no limit on how long one iteration may take. With L162's missing timeouts, a
single slow upstream can stretch one cycle indefinitely; the loop has not
crashed, so nothing restarts it, and the venue goes quiet without any error
being raised anywhere.

This is the most dangerous shape in this batch, because every monitoring signal
the service currently has reports it as healthy.

### What to build

- A per-cycle deadline. A cycle exceeding it is abandoned and the next one
  starts, rather than waiting forever.
- Count abandoned cycles in a metric, labelled by venue and network.
- Make sure abandoning a cycle cannot leave a partial write committed — check
  how each ingester writes before changing the control flow.
- Overlap must remain impossible: abandoning a cycle must not start a second
  concurrent one against the same venue.

### Acceptance criteria

- [ ] A cycle that exceeds its deadline is abandoned, not awaited indefinitely
- [ ] The deadline is configurable per ingester
- [ ] Abandoned cycles are counted in a metric
- [ ] No partial write survives an abandoned cycle
- [ ] A test with a slow upstream proves the loop keeps making progress

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L186 · Startup does not verify the database schema matches the code

**Labels:** help wanted, Stellar Wave, area:database, difficulty:advanced

### Background

`prisma/` contains only `schema.prisma` — there is no `migrations/` directory,
so every schema change this project has made has been a `prisma db push`. That
means there is no record of which schema version is deployed and no check at
startup that the database matches what the code expects.

The failure mode is a process that starts cleanly and then fails on the first
query touching a column that does not exist — at request time, in production,
on one instance of several if a deploy is partial.

### What to build

- A startup check that the schema the code expects is actually present, failing
  fast and naming what is missing.
- Report schema readiness through `/ready` (L168) so an instance with a stale
  database never receives traffic.
- Write down, in `docs/`, why there are no migrations and what the intended path
  is — adopting Prisma Migrate is a larger decision than this issue, but the
  current state should be a recorded choice rather than an accident.

### Acceptance criteria

- [ ] Startup fails fast and names the problem when the database does not match the schema
- [ ] `/ready` reflects schema readiness
- [ ] The check is cheap enough to run on every boot
- [ ] The absence of a migrations directory is documented with its rationale
- [ ] A test covers the mismatch case

> **Drips Wave** · Complexity: **Advanced** · **200 points**

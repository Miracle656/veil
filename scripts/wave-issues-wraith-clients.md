# Wave batch — three client SDKs that cannot spend money (W127–W146)

Drafted 2026-10-21 by reading `Miracle656/wraith` at `main`, comparing the three
client SDKs in `clients/` against the routes the API actually mounts, and
checking every workflow's last conclusion on `main`. Diffed against all 53 open
issues first; nothing here duplicates one.

Two seams, both verified rather than guessed.

**The clients stop where the money starts.** `src/api.ts` mounts `accounts`,
`assets`, `candles`, `fees`, `graphql`, `ngn`, `offramp`, `search` and
`webhooks`. The Go client has packages for accounts, assets, nfts, status,
transfers and webhooks. The react-query client has hooks for the same six plus
`hostFn`. The Python client has about seven public methods. So no client can
place an order, read a rate, fetch a candle or search — and the naira rails,
the reason this backend exists commercially, are reachable from none of them.

**Two scheduled workflows are red on `main` and one has never run.** `load.yml`
fails every time with a configuration error, `canary.yml` fails with nothing
useful in its log, and `publish-python-sdk.yml` has no recorded run at all. An
alarm that always rings is the same as no alarm, and we have two.

## Shared with every issue

**Repo:** `Miracle656/wraith`. Install with `npm ci`, typecheck with
`npx tsc --noEmit`, test with `npx jest --runInBand` — this repo uses **jest**,
not vitest. Regenerate the API spec with `npm run docs:openapi`; it must come
out byte-identical unless you meant to change it.

The clients live in `clients/go` (Go), `clients/python` (Python, pytest) and
`clients/react-query` (TypeScript). Each has its own workflow in
`.github/workflows/`. The react-query client generates `src/schema.d.ts` from
`openapi.json` and CI runs `git diff --exit-code` on it, so a stale generated
file fails the build.

**This backend carries live money.** The naira rails and the offramp run against
a real provider, and `src/api/linqWebhook.ts` verifies an HMAC over the raw
request body — it is mounted before `express.json()` for that reason. Anything
touching body parsing, route matching or middleware order must keep the webhook
tests green, not merely compile.

**A NIN, a phone number and a meter number are personal data** under Nigeria's
NDPA. Never stored, never logged, never in a fixture. `customerId` on the bills
route carries one of them.

**`npm run build` passing is not proof a field name is right.** TypeScript does
not excess-property-check properties introduced by a spread, so
`{ status, ...(c ? { typo: v } : {}) }` compiles clean against a Prisma input
type. This has already shipped a bug once — see #292.

**Do not weaken a test to make it pass.** If a guard fails, either the code is
wrong or the guard needs rewriting for a new reality. Say which in the PR.

---

### W127 · A scheduled load test that can only fail

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background

`load.yml` is red on `main`, and has been every run. The log says exactly why:

```
##[error]No staging URL configured. Set the STAGING_BASE_URL secret or pass
         base_url via workflow_dispatch.
##[error]Process completed with exit code 1.
```

So the k6 load test runs on a schedule, discovers it has nowhere to point, and
fails. Nothing is being load tested, and the failure notification is noise that
has been arriving long enough that nobody reads it.

Two separate problems sit behind that. The secret is not configured — which may
be deliberate, since there may be no staging environment to point at. And the
workflow treats "not configured" as a failure rather than as a reason to skip.

### What to build

- Make an unconfigured load test **skip cleanly**, not fail. A workflow that
  cannot run should say so and exit successfully, so a red result means
  something broke.
- Keep a real failure loud: if `STAGING_BASE_URL` is set and the test fails,
  that must still be red.
- Say in the PR whether a staging target exists. If one does, the follow-up is
  pointing this at it; if not, the honest state is a skipped job and that should
  be visible on the workflow summary rather than silent.

### Acceptance criteria

- [ ] With no `STAGING_BASE_URL`, the workflow succeeds and reports that it
      skipped, with the reason
- [ ] With one set, a genuine load-test failure is still red
- [ ] No other workflow is changed
- [ ] The PR states whether a staging environment exists

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W128 · The canary is red and will not say why

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate

### Background

`canary.yml` is failing on `main`. Fetching the failed steps' logs returns
nothing usable — no error line, no assertion, no exit message.

That is worse than a plain failure. A canary exists to be the first thing that
notices production is wrong, so a canary that is red for unknown reasons is a
detector we have switched off without deciding to. Nobody can tell today whether
production is fine and the canary is broken, or the reverse.

### What to build

- Find out why it fails, and say so in the PR. That is the deliverable; the fix
  follows from it.
- Then make the failure legible: whatever it checks should report what it
  checked, what it expected and what it got, in the job log. A canary whose
  output is empty cannot be triaged at the moment it matters.
- If it depends on an environment that no longer exists, the right outcome may
  be to retire or re-point it. Argue for that rather than leaving it red.

### Acceptance criteria

- [ ] The cause is identified and stated in the PR
- [ ] The job is green, or deliberately retired with reasoning
- [ ] A failure prints what was checked, expected and received
- [ ] A forced failure is demonstrated to produce a readable log, then reverted

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W129 · No client can place an order

**Labels:** help wanted, Stellar Wave, area:api, difficulty:advanced

### Background

The API mounts these route groups in `src/api.ts`:

```
accounts  assets  candles  fees  graphql  ngn  offramp  search  webhooks
```

plus transfers and the exports routes at the root.

The Go client (`clients/go/`) has packages for `accounts`, `assets`, `nfts`,
`status`, `transfers` and `webhooks`. The react-query client
(`clients/react-query/src/hooks/`) has hooks for `accounts`, `assets`,
`hostFn`, `nfts`, `status`, `transfers` and `webhooks`.

Neither has anything for `offramp`, `ngn`, `fees`, `candles` or `search`.

So the naira rails — the part of this backend that moves real money — cannot be
reached from any published client. Anyone integrating has to hand-roll HTTP
against routes that are partly undocumented (#291), which is exactly the
situation a client library exists to prevent.

Worth knowing: the generated `clients/react-query/src/schema.d.ts` **already
contains the types** — `/offramp/orders`, `/offramp/rate`,
`/offramp/availability`, `/offramp/trustline`, `/offramp/verify-bank`, `/fees`,
`/search` and `/ngn/customers/status` are all in there, because they are in
`openapi.json`. The types exist; the hooks were never written.

### What to build

Pick **one** client and cover the money rails in it properly. One finished
client beats three half-done ones, and the first one sets the shape the others
copy.

- Start from the generated types rather than hand-writing request shapes. They
  are already correct and already checked by CI.
- The offramp routes need the bearer token the order mints — see
  `src/api/offramp.ts`. A client that cannot carry that token cannot read back
  an order it created.
- The NGN read routes require **both** `customerRef` and `orderId`. That is a
  deliberate access-control property, not an inconvenience: a wallet address
  alone must not be enough to read someone's order. Do not add a convenience
  method that takes one without the other.
- Say in the PR which client you chose and why.

Note that seven NGN routes are missing from `openapi.json` entirely (#291), so
their types do not exist yet. Cover what is specified and leave the rest to
that issue rather than hand-writing types that will diverge.

### Acceptance criteria

- [ ] One client covers the offramp routes end to end, including the bearer token
- [ ] `fees`, `candles` and `search` are covered in that same client
- [ ] NGN reads require both identifiers, with no single-identifier shortcut
- [ ] Tests for each new call, against the fake provider where it helps
- [ ] The client's README lists what is and is not covered
- [ ] The PR names the chosen client and the reasoning

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W130 · The three clients disagree about what the API is

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:intermediate

### Background

Comparing the three clients against each other, not against the API:

| | accounts | assets | nfts | status | transfers | webhooks | hostFn |
|---|---|---|---|---|---|---|---|
| Go | yes | yes | yes | yes | yes | yes | — |
| react-query | yes | yes | yes | yes | yes | yes | yes |
| Python | summary only | popular only | — | — | yes | — | — |

The Python client has roughly seven public methods in
`clients/python/wraith/client.py`. The other two have six or seven whole
modules each. `hostFn` exists only in react-query; `nfts` is absent from
Python.

So a developer's experience of this API depends entirely on which language they
picked, and nothing records which differences are deliberate. Some may be —
there is no obligation for every client to reach parity — but that is a
decision nobody has written down, so every gap looks the same as an oversight.

### What to build

- One table in `docs/`, listing every route group the API serves and which
  clients cover it, marking each gap as deliberate or unclosed.
- Give each client's README the same table, narrowed to itself, so someone
  evaluating it knows before installing.
- Where a gap should close, link the issue. Where it should not, say why.

Keep it one table per file. The value is entirely in it staying current, and a
long document will not be.

### Acceptance criteria

- [ ] Every route group appears, with per-client coverage
- [ ] Each gap is marked deliberate or unclosed
- [ ] Each client README carries its own coverage statement
- [ ] It is short enough to maintain

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W131 · Nothing notices when a client falls behind the API

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:advanced

### Background

The react-query client regenerates `src/schema.d.ts` from `openapi.json` and CI
runs `git diff --exit-code` on the result, so a stale generated file fails the
build. That is a good guard and it catches type drift.

It does not catch coverage drift. A new route can be added to the API and the
spec, the schema regenerates to include it, CI stays green, and no client gains
a way to call it. That is how the clients ended up five route groups behind
without anyone noticing.

The Go and Python clients have no equivalent guard at all.

### What to build

- A check that compares each client's covered routes against the spec, and
  reports what is missing.
- It must not simply fail on any gap — the gaps are real and large today, and a
  check that is red from the first commit gets ignored. Use an explicit
  allow-list of known-uncovered routes, the way
  `src/__tests__/openapiCoverage.test.ts` uses `KNOWN_UNDOCUMENTED`, so adding a
  route to the API forces a deliberate decision about each client.
- Make the failure name the route and the client, not just the count.

That existing test is worth reading first: it already solves the same shape of
problem for the spec, including the trap where a broken walker makes everything
look covered. Its `guards the guard` case exists for exactly that reason.

### Acceptance criteria

- [ ] Each client's route coverage is compared against the spec in CI
- [ ] Today's gaps are allow-listed, so the check starts green
- [ ] Adding a route to the API fails the check until each client is decided
- [ ] Failures name the route and the client
- [ ] A deliberately-added fake route is shown to fail it, then reverted

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W132 · The Python client has never been published

**Labels:** help wanted, Stellar Wave, area:infra, difficulty:intermediate

### Background

`publish-python-sdk.yml` exists, builds with `python -m build`, runs `pytest`,
and has **no recorded run on `main`** — its last conclusion is `none`.

So there is a packaging workflow, a `pyproject.toml`, a `py.typed` marker and a
test suite for a package that does not exist anywhere a user can install it.
The Go client at least works via `go get` against the repository; the Python one
requires cloning.

A client nobody can install is a client nobody uses, and the effort already
spent on it is sitting idle.

### What to build

- Work out why it has never run — trigger conditions, a missing token, a
  disabled workflow — and say which in the PR.
- Get a release published, with the package metadata a user needs: description,
  repository link, homepage, license and the Python versions actually tested.
- Prefer trusted publishing over a long-lived token if the registry supports it.
  Do not put a token in the repository, and do not print one in a log.
- Confirm a clean `pip install` of the published artifact works in a fresh
  environment. Building is not publishing and publishing is not installing.

### Acceptance criteria

- [ ] The reason it never ran is identified and stated
- [ ] A version is published and installable with `pip install` in a clean env
- [ ] Package metadata includes repository, homepage, license and versions
- [ ] No credential appears in the repository or in any log
- [ ] The workflow's trigger conditions are documented

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W133 · The Python client is three endpoints of an API with twenty

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background

`clients/python/wraith/client.py` exposes, in total: `incoming_transfers`,
`outgoing_transfers`, `address_transfers`, `transaction_transfers`,
`account_summary`, `account_transfers` and `popular_assets`.

That is transfers, one account summary and one asset list. No status, no NFTs,
no candles, no search, no fees, no webhooks, and none of the money rails.

It does have the things that suggest it was meant to be taken seriously — a
`py.typed` marker, a typed `models.py`, its own `errors.py` and a test suite.
It was started well and then stopped.

### What to build

- Bring it to parity with the Go client first: `status`, `nfts` and `webhooks`.
  That is the smaller, better-defined half and it makes the three clients
  comparable.
- Keep the existing shape — typed models, its own error types, context-manager
  support. Do not introduce a second style alongside the first.
- Tests for each addition, following `tests/test_client.py`.
- Update the README's coverage statement as you go, so it never overstates what
  the client does.

Leave the money rails to #129, which decides how one client covers them
properly before the pattern is copied.

### Acceptance criteria

- [ ] `status`, `nfts` and `webhooks` are covered
- [ ] Typed models and the existing error types are used throughout
- [ ] Each addition has a test
- [ ] `pytest` passes and the README matches what is implemented

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W134 · Every route PR conflicts in the same file

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced

### Background

`src/api.ts` is 1,136 lines. It holds CORS, rate limiting, the HTTP metrics
middleware, the stale-read middleware, the webhook router mounted ahead of
`express.json()`, every route-group mount, the 404 handler and the error
handler.

The practical cost is that it is the single most conflict-prone file in the
repository. Across recent sweeps, essentially every pull request that adds a
route has conflicted here, and several arrived with duplicated blocks produced
by repeated base merges rather than by anything the author wrote. One of those
duplications — a second declaration of the same timer set — reached review.

That is a structural problem, not a contributor problem. A file that every
change has to touch will be conflicted by every change.

### What to build

- Split it along the seams that already exist in the comments: middleware setup,
  route mounting, error handling.
- The ordering constraints are load-bearing and must survive explicitly, not by
  luck. In particular the Linq webhook router **must** mount before
  `express.json()`, because Linq signs the raw body and re-serialising it breaks
  verification. Whatever shape you choose has to make that ordering obvious and
  hard to get wrong — a comment is what we have now and it is not enough.
- `/metrics` is deliberately exempt from the rate limiter and from the
  stale-read middleware, for stated reasons. Those exemptions must be preserved
  and still findable afterwards.
- No behaviour change. The suite passing is the bar, and the webhook signature
  tests are the ones that matter most.

### Acceptance criteria

- [ ] `src/api.ts` is substantially smaller, split along stated seams
- [ ] The webhook router still mounts before `express.json()`, enforced or
      asserted rather than commented
- [ ] The `/metrics` exemptions are preserved
- [ ] Every test passes, signature tests included
- [ ] No route changes path, method or behaviour, and the PR says how you checked

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W135 · One thousand lines of database access in one file

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced

### Background

`src/db.ts` is 1,073 lines, and coverage reports it at around 21% with roughly
3% branch coverage — the lowest-tested large module in the repository.

It is the layer every route reads through. A query that is subtly wrong here
produces a plausible number in an API response, which is the hardest class of
bug to notice: nothing throws, nothing logs, and the value looks like data.

Its size and its coverage are the same problem. Nobody tests a thousand-line
module because there is no seam to test against.

### What to build

- Split it by concern — transfers, accounts, assets, orders, whatever the real
  groupings are. Read it first and let the file tell you; do not impose a
  structure on it.
- Add tests as you split, rather than afterwards. The point of the split is to
  make them possible, so a split with no new tests has not banked the benefit.
- Prioritise the queries that produce numbers a user sees over the ones that
  only feed internal state.
- Keep the public surface identical so no route changes.

This is a large piece of work. It is fine to do it in stages — say in the PR
which part you took and what remains, and open a follow-up rather than leaving
a half-finished split with no record.

### Acceptance criteria

- [ ] `src/db.ts` is split along concerns described in the PR
- [ ] Each extracted module gains tests, with the numeric queries covered first
- [ ] The public surface is unchanged and every route still passes
- [ ] Coverage on the extracted code is materially above where it started
- [ ] Remaining work is written down, not left implied

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W136 · The GraphQL subscription layer is 376 lines with little behind it

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`src/graphql/subscriptions.ts` is 376 lines. The GraphQL tests are
`src/__tests__/graphql.test.ts` and
`src/__tests__/networkSelectorGraphqlWs.test.ts` — one general suite and one
about network selection.

Subscriptions are the hardest part of a GraphQL server to get right and the
easiest to leave untested, because testing them means driving a socket rather
than making a request. The failure modes are also the quiet kind: a filter that
leaks another subscriber's data, a client that stops receiving updates without
disconnecting, a subscription that survives the connection that created it.

### What to build

- Tests that drive a real socket, not the resolver in isolation.
- The leak case first: a subscriber to one pair must never receive another
  pair's updates. That is the assertion with a security flavour and it is worth
  having before the rest.
- Then lifecycle: unsubscribe stops delivery, a dropped connection cleans up,
  and a reconnect does not double-deliver.
- Cover the network argument, since an omitted one is documented as safe only
  if the client reads the `network` field on each message.

### Acceptance criteria

- [ ] Tests drive a real subscription over a socket
- [ ] A subscriber provably cannot receive another subscription's data
- [ ] Unsubscribe, disconnect and reconnect are covered
- [ ] The network field is asserted on delivered messages
- [ ] Coverage on `src/graphql/subscriptions.ts` rises materially

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W137 · Anyone can read the metrics

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

`/metrics` is public and un-gated, and `src/api.ts` says so deliberately. It is
also exempt from the rate limiter, with a good reason given in the code:

```ts
// /metrics is exempt: a scrape endpoint that starts 429ing goes blind exactly
skip: (req) => process.env.NODE_ENV === "test" || req.path === "/metrics",
```

Both choices are defensible in isolation. Together they mean an unauthenticated
endpoint with no rate limit that reports internal operational state, and the
observability work in #269–#288 is about to make that state considerably richer
— per-rail order outcomes, provider latency, KYC failures, payout failures.

Published as a public series, that is a live feed of how much business is
flowing through the naira rails and when it is failing. None of it is personal
data, and none of it is a vulnerability on its own. It is still more than we
would choose to publish if anyone had chosen.

`area:security` has one open issue.

### What to build

- Decide who should be able to scrape it, and make that explicit. A shared
  bearer token, an IP allow-list, or a separate port are all reasonable; the
  decision matters more than the mechanism.
- Keep the rate-limit exemption for whoever is allowed to scrape. The reasoning
  in that comment is correct and should survive.
- Do not break the existing scrape. If something is already collecting this,
  find out what before changing the contract, and say so in the PR.

### Acceptance criteria

- [ ] Scrape access is an explicit decision, implemented and documented
- [ ] Authorised scrapers remain exempt from rate limiting
- [ ] An unauthorised request is refused, with a test
- [ ] The PR states what currently scrapes this and how it was checked

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W138 · The OpenAPI schema file is 833 lines of hand-maintained duplication

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background

`src/openapi/schemas.ts` is 833 lines and `src/openapi/build.ts` is 641. Between
them they describe the API's shapes a second time, alongside the Zod schemas the
routes actually validate with.

The spec being generated from Zod was the whole point of that work, so where a
shape is declared twice there is somewhere for the two to drift — and the one
the route enforces is not the one the client is generated from. A client built
against a drifted spec fails at the moment someone tries to use it, not at
build time.

#300 asks for responses to be validated against the spec at test time, which
catches drift after the fact. This issue is the other direction: reduce the
places it can come from.

### What to build

- Find the shapes declared in `schemas.ts` that duplicate a Zod schema already
  used by a route, and derive them instead of restating them.
- Where a shape genuinely has no Zod counterpart — because the route does not
  validate it — say so, and consider whether the route should.
- The spec must stay byte-identical through this, or every difference must be
  explained. `npm run docs:openapi` is deterministic, so a diff is a real
  change and not noise.

### Acceptance criteria

- [ ] Duplicated shapes are derived from their Zod definitions
- [ ] `npm run docs:openapi` produces an identical spec, or every diff is
      explained in the PR
- [ ] Shapes with no Zod counterpart are listed, with a recommendation
- [ ] The full suite passes, `openapiCoverage` included

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W139 · The indexer is 693 lines and restarts itself

**Labels:** help wanted, Stellar Wave, area:indexer, difficulty:advanced

### Background

`src/indexer.ts` is 693 lines. It holds `planNetworks`, the per-network loops,
the restart timers, tombstone cycling and the shutdown path.

It is also the module with the most history behind it. `planNetworks` carries a
comment explaining that an unset mainnet RPC URL once killed the process, and
that degrading per network beats refusing to serve — a lesson learned from an
outage. A merged startup validator undid that in October and crash-looped the
service for about forty minutes.

That history is the argument for testing it rather than only reading it. The
behaviour the comments describe is correct and hard-won, and nothing pins it.

### What to build

- Tests that pin the degradation behaviour explicitly: one network unconfigured
  must not stop the other, and must not stop the API.
- Cover the restart timers — that they are cleared on shutdown, that a restart
  does not run two loops for one network, and that the timer set is not
  duplicated. That last one is not hypothetical; a duplicate declaration of it
  reached review this month after repeated base merges.
- Cover a clean shutdown leaving nothing running. #207 is open on start-up and
  shut-down tidiness and this is the part of it that can be tested.

Read the comments before changing anything. Several describe outages, and each
one is a test waiting to be written rather than a thing to tidy up.

### Acceptance criteria

- [ ] An unconfigured network is proven not to affect the other, or the API
- [ ] Restart timers are proven cleared on shutdown and never duplicated
- [ ] A clean shutdown leaves no running loop or timer
- [ ] Each test names the failure it prevents
- [ ] No behaviour described in an existing comment is changed without saying so

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W140 · The offramp is 683 lines and mints its own auth

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:advanced

### Background

`src/api/offramp.ts` is 683 lines and is the most security-sensitive route file
in the repository. It mints a bearer token per order by HMAC over the order's
identity:

```ts
return createHmac("sha256", process.env.LINQ_API_KEY ?? "")
```

and checks it on read with `bearerToken(req)`. That token is the only thing
standing between an order and anyone who can guess its public id.

Note the `?? ""` — with `LINQ_API_KEY` unset, every token is an HMAC under an
empty key, which is a key an attacker also has. The cash-out routes refuse to
operate without that variable, so this may be unreachable; "may be" is not what
you want on a token-minting path.

### What to build

- Tests for the token: a valid token reads its own order, a token for one order
  does not read another, a tampered token is refused, and a missing one is
  refused.
- Pin the empty-key case deliberately. Either prove it is unreachable, or make
  it refuse to mint rather than minting something forgeable.
- Cover the idempotency path — #210 added a request hash, and a replayed
  request must not create a second order.

### Acceptance criteria

- [ ] Valid, cross-order, tampered and missing tokens are each covered
- [ ] The empty-key case is proven unreachable or made to refuse
- [ ] Replaying a request is proven not to create a second order
- [ ] No secret or token value appears in test output
- [ ] Coverage on `src/api/offramp.ts` rises materially

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W141 · The OData layer is a query language nobody tests

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`src/lib/odata.ts` is 241 lines implementing OData-style query parsing —
filters, ordering and selection parsed from user-supplied query strings and
turned into database queries.

Anything that turns a user string into a query needs tests for two separate
reasons. The first is correctness: a filter parsed wrongly returns the wrong
rows, and the caller cannot tell. The second is that it is a parser on the
request path, so malformed and hostile input are both ordinary traffic.

### What to build

- Tests for each supported operator and combination, asserting the rows that
  come back rather than the parse tree alone.
- Malformed input: unbalanced quotes, unknown operators, unknown fields, an
  enormous expression. Each should be refused with a 400 naming the problem,
  not a 500 and not silently ignored.
- Confirm a filter cannot reach a column it should not, and that values are
  bound rather than interpolated. If they are interpolated anywhere, stop and
  raise it rather than writing a test around it.

### Acceptance criteria

- [ ] Every operator is covered, asserted on returned rows
- [ ] Malformed input returns 400 naming the problem, never 500
- [ ] An unknown or restricted field is refused
- [ ] Values are proven bound, not interpolated
- [ ] Coverage on `src/lib/odata.ts` rises materially

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W142 · The JSON:API middleware reshapes every response untested

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`src/middleware/jsonapi.ts` is 213 lines and sits in front of every route,
reshaping responses into JSON:API form.

A response envelope is the part of an API that every client depends on and
nobody thinks about. If it drops a field, nests one differently, or handles an
error shape inconsistently, every consumer breaks at once — and the routes
themselves still look correct, because the route returned the right thing and
the middleware changed it.

It also interacts with the stale-read middleware, which wraps `res.json` to
inject `stale`, `indexer_running` and `as_of_ledger`. Two layers both rewriting
responses is worth pinning precisely.

### What to build

- Tests for the envelope: a success, a collection, an error, and an empty
  result, asserting exact output shape.
- The interaction with the stale-read wrapper: when both apply, the result must
  be defined and asserted, not discovered.
- Cover what happens to a response that is already in the target shape, and to
  one that is not an object at all.

### Acceptance criteria

- [ ] Success, collection, error and empty shapes are asserted exactly
- [ ] The interaction with the stale-read middleware is pinned by a test
- [ ] A non-object response has a defined, tested result
- [ ] Coverage on `src/middleware/jsonapi.ts` rises materially

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W143 · The cache layer still assumes a Redis that is gone

**Labels:** help wanted, Stellar Wave, area:infra, difficulty:intermediate

### Background

`src/cache/redis.ts` is 209 lines. The managed Redis this project used is no
longer available, and three jobs read `process.env.REDIS_URL` directly
(`aggregateRefresh.ts`, `pricePointsPartitionJob.ts`, `snapshotRetention.ts`)
while `src/config.ts` defaults it to `redis://localhost:6379`.

So the current state is ambiguous in the worst way: code that behaves as though
a cache is present, a default that points at a local instance that will not
exist in production, and no single place that says whether caching is on.

A cache that is quietly absent is usually survivable and occasionally not — a
rate limiter or an idempotency guard backed by a cache that silently does
nothing has stopped doing its job without saying so.

### What to build

- Establish what is actually true in production, and say so in the PR. That is
  the first deliverable.
- Then make the absence explicit: either caching is optional and every consumer
  degrades deliberately, or it is required and its absence is reported on
  `/status` rather than inferred.
- Check specifically whether anything security-relevant depends on it — rate
  limiting and idempotency are the two to look at. Those must not silently
  become no-ops.
- Do not make a missing `REDIS_URL` fatal at boot. A cache is not what makes
  this process useful, and that mistake has already taken this service down
  once.

### Acceptance criteria

- [ ] The real production state is established and stated
- [ ] Caching is explicitly optional-and-degrading or required-and-reported
- [ ] Nothing security-relevant becomes a silent no-op without it
- [ ] A missing `REDIS_URL` does not prevent start-up
- [ ] `/status` reflects the cache's real state

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W144 · The RPC layer has no test for the thing it exists to survive

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`src/rpc.ts` is 333 lines and is the boundary between this service and the
Stellar network. It exists largely to cope with an RPC endpoint that is slow,
rate-limiting, returning errors, or lying — and the stale-read middleware in
`src/api.ts` depends on `checkRpcHealth` to decide whether to mark a response
stale.

Whether that health check is right determines whether users are told their data
is current. Getting it wrong in one direction marks good data stale; in the
other it presents stale data as live, which is the one that matters when someone
is deciding whether a payment arrived.

The RPC URL also carries its credential in the path, so anything that logs or
surfaces a URL must redact it.

### What to build

- Tests for `checkRpcHealth` across the real cases: healthy, slow, 429,
  5xx, malformed response, and unreachable. Each must produce the right
  staleness verdict.
- Prove no error path renders an RPC URL verbatim, in a log or a response. The
  credential lives in the path, so a leaked URL is a leaked key.
- Cover the failover behaviour if this module has any, including what happens
  when every endpoint is down.

### Acceptance criteria

- [ ] Health check covered for healthy, slow, 429, 5xx, malformed and unreachable
- [ ] Each case's staleness verdict is asserted
- [ ] No code path emits an RPC URL with its credential, proven by test
- [ ] Total failure has a defined, tested result
- [ ] Coverage on `src/rpc.ts` rises materially

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W145 · The error helper has no tested behaviour

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:easy

### Background

`src/utils/errors.ts`:

```
errors.ts   42.85 % stmts   100 % branch   0 % funcs
uncovered: 5-7, 12
```

Zero per cent function coverage. The module is small — an `HttpError` class
carrying a status, and `newCorrelationId()` — but both are used to decide what
a caller is told when something goes wrong.

A correlation id that is not unique, or an `HttpError` whose status is dropped
somewhere between throw and response, turns a precise 4xx into an opaque 500.
That is the difference between a caller fixing their request and a caller
filing a bug.

### What to build

- Tests that an `HttpError` reaches the client as its own status and message,
  through the real error handler in `src/api.ts` rather than in isolation.
- A test that a non-`HttpError` is **not** surfaced verbatim — internal failures
  should be masked, and the test should prove the mask is applied.
- A test that correlation ids are unique and appear in both the response and the
  log line, so the two can be joined when someone reports a problem.

### Acceptance criteria

- [ ] An `HttpError` round-trips its status and message through the real handler
- [ ] A non-`HttpError` is masked, proven by test
- [ ] Correlation ids are unique and appear in both response and log
- [ ] Function coverage on `src/utils/errors.ts` is no longer 0%

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W146 · Nothing says which routes are safe to cache

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

Caching decisions are scattered. `src/api.ts` applies `cacheMiddleware` with a
TTL to `/assets` and `/search`, several NGN routes set
`Cache-Control: no-store` individually, and the stale-read middleware adds
`X-Data-Stale` and `X-As-Of-Ledger` to some GET responses but deliberately skips
`/ngn` and `/offramp`.

Each of those choices has a reason, and some of the reasons are written down
well — the skip for the naira rails exists because marking a live exchange rate
`stale` was actively untrue, and `/ngn/onramp/rate` was doing exactly that.

What is missing is one place that states the policy. So the next route added is
a guess, and a money route that quietly gains a cache is a user reading a rate
that expired.

### What to build

- One short document listing every route group, its caching treatment and why:
  cached with a TTL, `no-store`, or neither.
- Include the stale-read exemptions and the reasoning already in the code.
- State the default for a new route, so the next person does not have to infer
  it. For anything that quotes a price or an order state, that default should be
  `no-store`.

### Acceptance criteria

- [ ] Every route group's caching treatment is listed with its reason
- [ ] The stale-read exemptions are included and explained
- [ ] A default for new routes is stated
- [ ] Each claim matches the code, checked rather than assumed

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

# Wave batch — the parts of wraith nothing is watching (W114–W125)

Drafted 2026-10-21 by reading `Miracle656/wraith` at `main` and running the
suite with coverage. Checked against all 39 open issues first; nothing here
duplicates one.

The observability batch (#269–#288) covered the naira rails well. This one goes
after the areas that batch did not reach: the generated API contract, the jobs
that move data around, the outbound webhook worker, and a type-system hole that
let a real bug through code review last week.

Three of these came out of reviewing a single pull request. That is usually the
sign of a gap worth writing down rather than patching once.

## Shared with every issue

**Repo:** `Miracle656/wraith`. Install with `npm ci`, typecheck with
`npx tsc --noEmit`, test with `npx jest --runInBand` — this repo uses **jest**,
not vitest. Regenerate the API spec with `npm run docs:openapi`; it must come
out byte-identical unless you meant to change it.

**This backend carries live money.** The naira rails and the offramp run against
a real provider. `src/api/linqWebhook.ts` verifies an HMAC over the raw request
body, so it is mounted before `express.json()` — anything touching body
parsing, route matching or middleware order must keep the webhook tests green,
not merely compile.

**Do not weaken a test to make it pass.** If a guard fails, either the code is
wrong or the guard needs rewriting for a new reality — say which in the PR.

**A NIN is personal data under Nigeria's NDPA.** It is never stored, never
logged, and never appears in a test fixture. The same goes for a customer's
phone number or meter number.

---

### W114 · Seven live routes are missing from the API contract

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background

`src/__tests__/openapiCoverage.test.ts` asserts that every route the app serves
appears in the generated OpenAPI spec. Seven are exempted by name:

```ts
const KNOWN_UNDOCUMENTED = [
  "get /ngn/bills/{orderid}",
  "get /ngn/onramp/orders/{orderid}",
  "get /ngn/onramp/rate",
  "post /ngn/bills",
  "post /ngn/customers",
  "post /ngn/customers/kyc",
  "post /ngn/onramp/orders",
];
```

The comment there is honest about why: the NGN rails landed after the guard was
written, and documenting them means seven request/response schemas, which is a
different piece of work from the one that test exists for.

That different piece of work is this issue. These are not minor routes — they
are the entire naira rail, the part of wraith that moves money, and they are
the only surfaces a client cannot generate against.

### What to build

- Zod schemas and OpenAPI registrations for all seven, request and response.
- Remove each from `KNOWN_UNDOCUMENTED` as you go. The list should be empty at
  the end; if one genuinely belongs undocumented, mark it `x-internal: true`
  with a reason rather than leaving it on the list.
- Document the error shapes too. A client needs to know what a 400 from
  `POST /ngn/customers/kyc` looks like, not only the happy path.

**Do not put a NIN, a phone number or a meter number in an example value.** Use
obviously-fake placeholders and say in the schema description that the field
carries personal data.

### Acceptance criteria

- [ ] All seven routes appear in the generated spec
- [ ] `KNOWN_UNDOCUMENTED` is empty, or each remaining entry is `x-internal`
      with a stated reason
- [ ] Error responses are documented, not only success
- [ ] `npm run docs:openapi` is deterministic — running it twice changes nothing
- [ ] No example value contains anything resembling real personal data

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W115 · A spread conditional hides a wrong field name from the compiler

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:advanced

### Background

This is a real bug that reached review last week, in a Prisma write:

```ts
await prisma.ngnOrder.update({
  where: { id: existing.id },
  data: {
    status: event.status ?? event.event,
    ...(event.amountNGN != null ? { settledNgn: Number(event.amountNGN) } : {}),
    ...(event.txHash ? { depositTxHash: event.txHash } : {}),
  },
});
```

`NgnOrder` has `settledNGN` and `txHash`. It has no `settledNgn`, and
`depositTxHash` belongs to `OfframpOrder`. Both writes would fail at runtime,
inside a `catch` that only logs — so onramp and bill orders would stop
reconciling, silently.

`tsc --noEmit` reported **nothing**. I checked why, and it is worth knowing:

```ts
// caught — TS2561: 'settledNgn' does not exist in type 'NgnOrderUpdateInput'.
//                  Did you mean to write 'settledNGN'?
const a: Prisma.NgnOrderUpdateInput = { settledNgn: 5000 }

// NOT caught — one known key present, bad keys only via spreads
const b: Prisma.NgnOrderUpdateInput = {
  status: 'completed',
  ...(x != null ? { settledNgn: 5000 } : {}),
}
```

Excess-property checking does not apply to properties introduced by a spread.
Remove the spread, or remove the known key, and it errors. Keep both and the
compiler is silent. `npm run build` passing is not evidence for this shape.

The pattern `...(cond ? { field: value } : {})` is used throughout this
codebase to build Prisma `data` objects, which is exactly where a wrong field
name costs the most.

### What to build

Pick a mechanism and apply it where it matters — the Prisma write paths first:

- a typed helper such as `when(cond, { field: value })` that is generic over the
  target input type, so the field name is checked; or
- an ESLint rule that flags a spread conditional inside a Prisma `data` or
  `where` object; or
- `satisfies` annotations on the built objects.

Whichever you choose, the deliverable that proves it is **a test that fails
before your change and passes after**, using the exact shape above.

Say in the PR why you picked that mechanism. A lint rule and a typed helper
have different costs and the reasoning matters more than the choice.

### Acceptance criteria

- [ ] The shape above is caught, demonstrated by a test that fails on `main`
- [ ] Every Prisma `data`/`where` object built with spread conditionals is
      covered by the chosen mechanism
- [ ] `npx tsc --noEmit` clean and the full suite passes
- [ ] The PR explains the mechanism choice

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W116 · A webhook finds an order by id alone, across both networks

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:intermediate

### Background

`reconcileNgnOrder` in `src/linq/ngnOrders.ts` looks the order up by id and
nothing else:

```ts
const existing = await prisma.ngnOrder.findFirst({ where: { orderId: event.orderId } });
```

then updates through the compound key, using whatever network that row
happened to have:

```ts
where: { network_orderId: { network: existing.network, orderId: event.orderId } },
```

The table's uniqueness is `@@unique([network, orderId])` — so the id alone is
**not** unique by design. Two rows may legitimately share an `orderId` across
networks, and `findFirst` then returns whichever the database hands back first,
with no ordering specified.

Today this is mostly theoretical: `NgnOrder.network` defaults to `"mainnet"`
and the routes refuse every other network. But the schema comment says the
column is kept explicit "so a row is never ambiguous", and this query is the
one place that ambiguity is reintroduced. The moment a testnet row exists with
a colliding provider id, a webhook settles the wrong order.

### What to build

- Resolve the order by the key the schema actually guarantees unique.
- If an event genuinely cannot tell you its network, say so explicitly in the
  code and decide deliberately what to do — but do not let `findFirst` pick.
- A test with two rows sharing an `orderId` across networks, asserting the
  right one is updated.

Worth checking the same pattern in `src/api/linqWebhook.ts`, which does the
equivalent lookup on `offrampOrder`.

### Acceptance criteria

- [ ] An order is resolved by a key the schema guarantees unique
- [ ] A test with a cross-network id collision proves the correct row updates
- [ ] The offramp lookup is checked for the same problem and fixed or justified
- [ ] No behaviour change for the single-network case, proven by existing tests

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W117 · The job that archives your history has never run in a test

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:advanced

### Background

`src/jobs/retention.ts` moves old partitions between schemas with raw DDL:

```ts
await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS "wraith_archive"');
```

Coverage on it, from `npx jest --runInBand --coverage`:

```
src/jobs/retention.ts   31.37 % stmts   16.66 % branch   18.18 % funcs
uncovered: 22-33, 66-126, 130-141
```

Lines 66–126 are the execution path — everything that actually touches the
database. What *is* covered is `planPartitionRetention`, the pure function that
decides what to archive. So we test the decision and not the action.

This is data we cannot get back. An archive step that names the wrong partition,
or half-completes, is not something a later deploy fixes.

### What to build

- Tests that exercise the execution path against a real Postgres — partitions
  created, the job run, placement asserted afterwards. `docker-compose` is the
  natural home; see #63, which asks for that harness, and build on it if it has
  landed.
- Cover the failure modes specifically: the archive schema already exists, a
  partition disappears between planning and execution, the job is interrupted
  halfway.
- Assert that nothing outside the planned set is touched. That is the property
  that matters most and the one a happy-path test will not check.

Note `formatQualifiedIdentifier` already quotes identifiers correctly
(doubling embedded quotes). Keep it that way and add a test that pins it,
because the next person to edit raw DDL will look there first.

### Acceptance criteria

- [ ] The execution path is exercised against a real database, not a mock
- [ ] A test proves partitions outside the plan are untouched
- [ ] Interrupted and already-applied runs are covered
- [ ] Identifier quoting has a test of its own
- [ ] Coverage on `src/jobs/retention.ts` is materially above 31%

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W118 · Outbound webhook delivery is 30% covered, and it is the half that retries

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`src/workers/webhooks.ts` is well built — HMAC `X-Wraith-Signature`, a
10-second timeout, five attempts, exponential backoff of 0s/30s/5min/30min/2h.

It is also barely tested:

```
src/workers/webhooks.ts   30.13 % stmts   42.5 % branch   16.66 % funcs
uncovered: 60-203, 214-224
```

Lines 60–203 are `attemptDelivery` and the dispatch loop: the signing, the
fetch, the retry scheduling, the permanent-failure path. Every property this
module promises a subscriber lives in the untested region.

A retry schedule that is wrong does not fail loudly. It just delivers late, or
twice, or never, and the subscriber is the one who notices.

### What to build

Tests for the behaviour subscribers depend on:

- the signature is computed over the exact bytes sent, and a subscriber can
  verify it
- a failed attempt schedules the next at the documented backoff, and attempt 5
  does not schedule a sixth
- a timeout is treated as a failure, not a success
- a 2xx marks delivery complete and stops retries
- a permanently failed delivery leaves a record that something can find later —
  `console.error` is not a record

### Acceptance criteria

- [ ] Signature, backoff schedule, timeout, success and permanent failure all
      covered
- [ ] The backoff assertions use the documented delays, not reimplement them
- [ ] A permanently failed delivery is discoverable after the fact
- [ ] Coverage on `src/workers/webhooks.ts` is materially above 30%

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W119 · Every origin may call every route

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

`src/api.ts:141`:

```ts
app.use(cors());
```

With no options, the `cors` package answers every request with
`Access-Control-Allow-Origin: *`. That applies uniformly to the read API, the
GraphQL endpoint, the fee quote, the offramp and the naira rails.

For a public read API that is a deliberate and correct choice. For the routes
that create orders it is at best unconsidered — nobody chose it, it is the
default that came with the line.

`area:security` has one open issue. This is the cheapest thing on that list to
get right.

### What to build

- Decide, per surface, who should be able to call it from a browser, and
  configure `cors` accordingly rather than globally.
- Drive the allow-list from configuration, not a literal, so a new client does
  not need a deploy of this file.
- Write down the reasoning in the module header. The next person needs to know
  which routes are deliberately open.

Be careful not to break the mobile app or the web wallet — a native client
sends no `Origin` and must keep working. Check both against your change.

### Acceptance criteria

- [ ] CORS is configured per surface, not one global default
- [ ] The allow-list is configurable without editing source
- [ ] Requests with no `Origin` header still work
- [ ] Tests cover an allowed origin, a disallowed one, and no origin
- [ ] The header says which surfaces are deliberately public and why

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W120 · An unknown query value is silently treated as the default

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background

`src/routes/assets/popular.ts`:

```ts
function windowToDate(window: string): Date {
  switch (window) {
    case "1h":  return new Date(now.getTime() - 60 * 60 * 1000);
    case "24h": return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case "7d":  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    default:    return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  }
}
```

`?window=7days` is not an error. It is twenty-four hours, returned with a 200
and no indication that the caller asked for something else. A client reading
"last 7 days" off their own dashboard would be wrong and have no way to tell.

The branch coverage on this file is **0%**, so none of these cases is tested
either.

### What to build

- Reject an unrecognised `window` with a 400 that names the field and lists
  what is accepted — the pattern the offramp routes already use.
- Cover each accepted value and the rejection with tests.
- Then check the other routes for the same shape. A `default:` that silently
  substitutes a value is the thing to look for; it is a different bug from a
  missing parameter, which legitimately takes a default.

### Acceptance criteria

- [ ] An unrecognised `window` returns 400 naming the field and the valid values
- [ ] An absent `window` still defaults, and that distinction is tested
- [ ] Every accepted value has a test
- [ ] Other routes are checked for silently-substituting defaults, and the PR
      lists what was found

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W121 · The metrics client we depend on has been renamed by its authors

**Labels:** help wanted, Stellar Wave, area:infra, difficulty:easy

### Background

`npm ci` prints, every time:

```
npm warn deprecated prom-client@15.1.3: prom-client has been replaced by @prometheus-io/client
```

`package.json` pins `"prom-client": "^15.1.3"`. Metrics are not optional here —
the observability work in #269–#288 is all built on this module, so it is about
to carry considerably more weight than it does today. Migrating before that
lands is much cheaper than after.

### What to build

- Move to `@prometheus-io/client`, checking the changelog for renames rather
  than assuming a drop-in.
- Confirm `/metrics` still exposes every series it does now, with the same
  names and labels. A renamed metric silently breaks whatever is scraping it,
  and that is the kind of break nobody notices until an alert does not fire.
- Capture the current `/metrics` output and diff it against the output after.
  That diff belongs in the PR.

While you are there: `npm ci` also warns about `rimraf@2.7.1` and `glob@7.2.3`.
Report where they come from (`npm ls rimraf glob`) and whether they are ours to
fix or a transitive dependency's.

### Acceptance criteria

- [ ] `@prometheus-io/client` replaces `prom-client`
- [ ] The before/after `/metrics` diff is in the PR and shows no unintended change
- [ ] The deprecation warning is gone from a clean `npm ci`
- [ ] The source of the `rimraf`/`glob` warnings is reported

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### W122 · The coverage floor is below where the money code sits

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:intermediate

### Background

`package.json` sets:

```json
"coverageThreshold": { "global": { "lines": 55, "functions": 50, "branches": 38, "statements": 55 } }
```

A global floor is satisfied by well-tested modules carrying thin ones. In this
repo that is not hypothetical — the suite passes while
`src/jobs/retention.ts` sits at 31%, `src/workers/webhooks.ts` at 30% and
`src/routes/assets/popular.ts` at 0% branch coverage.

Branch coverage at 38% is the number worth staring at: most of what this
backend does is decide between cases.

### What to build

- Per-path thresholds for the directories that matter, higher than the global
  floor — the naira rails, the webhook paths, the jobs.
- A ratchet, so the numbers can only go up. Whether that is a committed
  baseline file or a CI check comparing against the base branch is your call;
  argue it in the PR.
- Do not raise the global floor so far that unrelated PRs go red. The point is
  to stop the weak areas getting weaker, not to block people.

### Acceptance criteria

- [ ] Per-path thresholds exist for the money and job paths
- [ ] Coverage cannot decrease without the build failing
- [ ] A PR touching unrelated code does not fail because of this
- [ ] The PR states the chosen numbers and why

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W123 · There is no test that the OpenAPI spec matches what the routes return

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:advanced

### Background

`openapiCoverage.test.ts` checks that every route **appears** in the spec. It
does not check that the documented schema matches what the handler actually
sends.

So a response can gain a field, lose one, or change a type, and the spec stays
authoritative-looking and wrong. Clients are generated from it. A client
generated against a stale schema fails at the point where someone is trying to
move money, not at build time.

Issue #77 asks for contract tests with Dredd. This issue is the narrower,
cheaper version: validate real responses from the existing test suite against
the spec, with no new tooling.

### What to build

- A helper that validates a response body against the spec's schema for that
  route and status, and a way to apply it across existing route tests without
  rewriting them.
- Start with the money routes, where a client being wrong costs most.
- Make the failure message say which field diverged and in which direction —
  "response has an extra field `x`" rather than "does not match schema".

### Acceptance criteria

- [ ] Responses are validated against the spec in existing tests
- [ ] A deliberate drift between handler and spec fails the suite, shown by a
      test you then revert
- [ ] Failures name the diverging field
- [ ] The money routes are covered first

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W124 · The Linq client's error vocabulary is not written down anywhere

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:intermediate

### Background

`src/linq/` is the whole provider integration — client, webhook, onramp, bills,
orders, status mapping, error translation. It has module comments, and they are
good ones, but there is no document that says how the integration behaves as a
whole: which failures are retried, which are terminal, what each status means
in our vocabulary versus Linq's, and what happens when they disagree.

`area:docs` has two open issues. Meanwhile the naira rails are the part of this
system most likely to be picked up by someone who did not build it, under time
pressure, because money is stuck.

#286 asks for an operational runbook — what to do at 2am. This is the other
half: what the integration *is*, so the runbook has something to point at.

### What to build

A document in `docs/` covering:

- every call we make to Linq, and what we do with each failure shape
- the status vocabulary, theirs and ours, and where the mapping happens
- which operations are idempotent and why, pointing at the code
- what is deliberately not stored, and the NDPA reasoning
- the webhook contract: signature, raw-body requirement, acknowledge-then-
  reconcile ordering, and why each of those is load-bearing

Write it from the code, not from memory, and link to the files. Where the code
and your understanding disagree, that is a finding — put it in the PR.

### Acceptance criteria

- [ ] Every outbound call and its failure handling is described
- [ ] The status mapping is documented in both directions
- [ ] Each claim links to the code that implements it
- [ ] No real credential, NIN, phone number or meter number appears
- [ ] Anything that turned out to be wrong in the code is raised separately

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### W125 · Rebuilding the client after a schema change is a thing you remember to do

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background

A schema change needs `npx prisma generate` before `tsc` sees the new types.
Forgetting it produces a wall of errors in files you did not touch — about
twenty-five of them, all phantom, all pointing at a stale client rather than
the real problem.

That has cost time more than once, and the fix is already known: one PR under
review adds `"build": "prisma generate && tsc"`. That is the right change and
it should land on its own rather than inside a bug fix.

It only solves half of it, though. `npm test` and `npx tsc --noEmit` run far
more often than `npm run build`, and neither regenerates.

### What to build

- `prisma generate` ahead of the commands that need it — build, typecheck and
  test — without making every run pay for it twice.
- A check that the committed schema and the generated client agree, so CI says
  "your client is stale" instead of printing twenty-five unrelated errors.
- A line in the README or `CONTRIBUTING` so a new contributor meets this once.

### Acceptance criteria

- [ ] Build, typecheck and test all work from a clean checkout with no manual
      `prisma generate`
- [ ] A stale client fails with a message that says so
- [ ] A warm run is not noticeably slower
- [ ] The requirement is documented for new contributors

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

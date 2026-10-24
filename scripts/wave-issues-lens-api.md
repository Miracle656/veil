# Wave batch — Lens API surface and DX (L117–L136)

Drafted 2026-10-16 by reading every route handler. Lens answers about twenty-five
routes and no two of them agree on what an error looks like, which end of a
range is inclusive, or whether an empty result is a 404 or a 200. None of that
is visible from any single endpoint — it only shows up when somebody integrates
against four of them.

Deliberately weighted to small, independent work. Each issue touches a different
file or a different concern, so twenty people can take twenty of these and never
collide in review.

## Shared with every issue

**Repo:** `Divinity-Labs/Lens`. Node + Fastify + Prisma + Postgres. Tests are **vitest** (`npm test`), not jest — jest against this repo fails every file and tells you nothing.

**The spec is enforced.** `tests/openapi.test.ts` boots the server and fails if a registered route is missing from `openapi.yaml`. Operator-only and non-HTTP routes are excluded through the commented allow-list in `src/openapi/coverage.ts`. A new route or a changed response means the spec changes in the same PR.

**`?network=` is validated on every request** and an unrecognised value is a 400. Routes that answer per network declare the parameter in the spec; the ones that do not are listed in the README. If the two ever disagree, the spec is the thing to fix.

**Never elide a contract id or an issuer.** Take addresses from the protocol's own documentation and write them whole. A sibling repo's issue wrote `CD2W5LUR…XZ4L` and five contributors invented plausible contract ids to fill the gap.

**Change one thing.** These are scoped so they land independently. A PR that also reformats a file it did not need to touch is a PR nobody can review against its issue.

---

### L117 · Three routes hand internal error text to anonymous callers

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate, epic:security

### Background
`src/routes/benchmark.ts:84`, `src/routes/spreads.ts:162` and `src/routes/volumes.ts:103` all answer a failure with the exception's own message interpolated into the body:

```ts
return reply.status(500).send({ error: `Spread aggregation failed: ${(err as Error).message}` })
```

`src/api/websocket.ts:75` does the same over the socket. All four do database work, and a Postgres driver error carries the thing it failed to connect to. That is not hypothetical here: a sibling route echoed a raw pg error including its connection string and it sat in production for about three months before anyone noticed.

No authentication is required to reach any of these.

### What to build
- One internal-error path: log the real error with its stack, answer the caller with a fixed sentence and a stable code.
- A correlation id in both, so a report of "I got a 500" can be matched to the log line without the user holding anything sensitive.
- Audit the other twenty-six `(err as Error).message` uses in `src/` and fix any that reach a response.

### Acceptance criteria
- [ ] No route or socket interpolates an exception message into a response body
- [ ] The real error is logged with enough context to debug
- [ ] A test asserts a thrown error with a secret in its message does not appear in the response
- [ ] The remaining interpolations are either internal-only or fixed

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L118 · Errors are prose, so clients match on sentences

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:api-quality

### Background
Every error in the codebase is `{ error: "<a sentence>" }`. `src/routes/basket.ts` alone has five, each hand-written. A client that needs to branch — retry this, show that, give up here — has nothing to branch on but the prose, and the prose changes whenever someone rewords it.

The sibling backend learned this the expensive way: users whose identity check failed for one reason were routed to a screen about a different reason, because the only signal was a sentence that had been reworded upstream.

### What to build
- A stable `code` on every error response beside the existing `error`, from a documented set. `error` keeps its current text so nothing that reads it today breaks.
- Codes are enumerated in one module and in `openapi.yaml`, not invented per route.
- Start with the ones that already exist by implication: unknown pair, unwatched pair, bad interval, bad window, bad network, missing parameter, upstream unavailable.

### Acceptance criteria
- [ ] Every error response carries a `code` from a single enumerated set
- [ ] The set is documented in the spec
- [ ] Existing `error` strings are unchanged
- [ ] A test asserts no route emits a code outside the set

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L119 · An empty result is a 404 on one route and a 200 on another

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:api-quality

### Background
`src/routes/basket.ts:61` answers 404 when an asset has no price. `src/routes/benchmark.ts:34` answers 404 when a pair is not watched. Other routes return an empty array with a 200. Both conventions are defensible; having both is not, and a client cannot write one error handler.

### What to build
- Decide the rule and write it down: a resource that does not exist is a 404; a query that matched nothing is a 200 with an empty result and a reason.
- Apply it to every route, and say so in the spec.
- Note the behaviour change in the PR, per route.

### Acceptance criteria
- [ ] One documented rule, applied everywhere
- [ ] `openapi.yaml` lists the status codes each route can answer
- [ ] Changed routes are named in the PR description
- [ ] Tests cover both shapes

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L120 · Only `/screener` can be paged

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:api-quality

### Background
`src/routes/screener.ts` takes `cursor` and `limit`, clamps the limit to 100, and pages properly. `/pools`, `/pairs`, `/candles`, `/prices/history` and `/volumes` return everything they have. As venues are added — Phoenix, Blend and DeFindex are queued — those responses grow without bound, and the first symptom will be a mobile client timing out on `/pools`.

### What to build
- The same cursor-and-limit convention on every list route, copied from `screener.ts` rather than reinvented.
- A default limit and a maximum, documented per route.
- A cursor that survives rows being inserted while a client pages, which an offset does not.

### Acceptance criteria
- [ ] Every list route pages with the same parameters and the same cursor shape
- [ ] Defaults and maxima are in `openapi.yaml`
- [ ] A test pages through a result set with a row inserted mid-page
- [ ] Unpaged callers still get a sensible first page

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L121 · There is no version in the URL

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:api-quality

### Background
Routes are mounted at their bare paths — `/price/...`, `/candles/...` — with no version segment anywhere in `src/`. The package is at 0.2.0 and several issues in flight change response shapes: decimals becoming strings, an added `network` field, a different empty-result convention. Without a version there is no way to make any of those without breaking whoever is already integrated.

### What to build
- Mount the existing routes under `/v1` and keep the unversioned paths as aliases that answer identically.
- A deprecation policy in the docs: how long an alias lives and how a caller is warned.
- `openapi.yaml` describes the versioned paths.

### Acceptance criteria
- [ ] Every route answers under `/v1` and at its current path
- [ ] Both are covered by the OpenAPI coverage test
- [ ] The policy for retiring the unversioned paths is written down
- [ ] No existing caller breaks

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L122 · A request cannot be traced

**Labels:** help wanted, Stellar Wave, area:infra, difficulty:easy, epic:observability

### Background
Nothing in `src/` generates or accepts a request id. When someone reports a failure the only way to find it in the logs is the timestamp and a guess, and with more than one process running — which there is — even that is unreliable.

### What to build
- Accept an inbound `x-request-id` or generate one, put it on every log line for that request, and return it as a response header.
- Include it in error bodies, so a user reporting a problem can quote one short string.

### Acceptance criteria
- [ ] Every response carries a request id header
- [ ] Every log line for a request carries the same id
- [ ] An inbound id is honoured rather than replaced
- [ ] The id appears in error bodies

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L123 · Cacheable responses carry no cache headers

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:performance

### Background
`/pairs` and `/pools` change when a pool is added — rarely. `/candles` for a closed window never changes again. None of them send `Cache-Control`, so every client and every proxy refetches everything, and a dashboard polling five endpoints pays full price each time.

### What to build
- A per-route cache policy: a short max-age for live prices, a long one for closed historical windows, no-store for anything per-caller.
- Document the policy beside each route in the spec.

### Acceptance criteria
- [ ] Every route sends a deliberate `Cache-Control`
- [ ] Per-caller responses are `no-store`
- [ ] A closed historical window is cacheable for a long period
- [ ] The policy is in the spec, not only in the code

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L124 · No conditional requests, so a poller downloads the same bytes forever

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:performance

### Background
There is no ETag anywhere in `src/`. A client polling `/pairs` every thirty seconds transfers the whole list every time, even though it changes once a week. On a free hosting tier the bandwidth and the CPU both matter.

### What to build
- A strong ETag on list and historical responses, derived from the content rather than the clock.
- Honour `If-None-Match` with a 304.
- Pair it with L123 so the two policies agree.

### Acceptance criteria
- [ ] List and historical routes emit an ETag
- [ ] `If-None-Match` returns 304 with no body
- [ ] The ETag changes when and only when the content does
- [ ] A test polls twice and asserts the second is a 304

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L125 · One CORS policy covers public reads and authenticated routes alike

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate, epic:security

### Background
`src/app.ts:61` registers CORS as `{ origin: true }`, which reflects whatever origin asked. For the public price routes that is the right answer. It also applies to `/usage/me`, which takes a bearer token, and to the admin routes, where a reflected origin is a wider surface than anyone chose deliberately.

### What to build
- Split the policy: open on public reads, restricted on anything carrying a credential, and closed on admin.
- Be explicit about credentials rather than inheriting a default.
- Document which routes are public and which are not — the list is useful well beyond CORS.

### Acceptance criteria
- [ ] Public reads stay open to any origin
- [ ] Credentialed and admin routes have a deliberate, narrower policy
- [ ] The route classification is documented
- [ ] Tests cover an allowed and a refused origin on each class

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L126 · Validation is hand-rolled on some routes and zod on others

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:api-quality

### Background
`src/routes/price.ts` validates with zod schemas. `src/routes/basket.ts` validates with four hand-written `if` blocks and its own messages. `src/routes/screener.ts` parses an integer and checks `isNaN` afterwards. Three conventions means three ways to be wrong, and a caller sees three different shapes for the same class of mistake.

### What to build
- zod on every route's query and params, since it is already a dependency and already used.
- One formatter turning a zod error into the standard error shape with its code.
- No behaviour change beyond the message shape; note any that does.

### Acceptance criteria
- [ ] Every route validates with zod
- [ ] One formatter produces every validation error
- [ ] Messages name the parameter and what was expected
- [ ] Tests cover a bad value on each route

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L127 · The spec has no examples

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:docs

### Background
`openapi.yaml` is 1,792 lines of schemas and no example values. A developer reading it learns the shape of a response and not what one looks like, which is the thing they actually need to decide whether to integrate.

### What to build
- A realistic example response for every route, taken from a real call, with the date it was captured.
- An example request where a route takes parameters worth demonstrating.
- Keep them in the generator (`scripts/generate-openapi.ts`) so they survive regeneration.

### Acceptance criteria
- [ ] Every route has a response example with a capture date
- [ ] Examples are real, not invented
- [ ] They survive `npm run openapi:gen`
- [ ] No example contains a made-up contract id or issuer

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L128 · Error responses are undocumented

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:docs

### Background
The spec describes what a route returns when it works. It says nothing about the 400s and 404s each route can produce, so the error codes added in L118 would be invisible to anyone reading it, and a generated client would have no error type at all.

### What to build
- Document every status a route can answer, with the error schema and the codes it can carry.
- One shared error component referenced from each route rather than copied.

### Acceptance criteria
- [ ] Each route lists its error statuses and codes
- [ ] One shared error schema, referenced
- [ ] The coverage test checks errors as well as success shapes

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L129 · Nothing tells a caller what to do with a 429

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:api-quality

### Background
Lens rate-limits and the limits are not documented anywhere. A client that gets a 429 has no way to know whether to retry in one second or sixty, so it will guess, and a guessing client under a rate limit makes the rate limit worse.

The sibling backend hit exactly this with its payment provider last week: a 429 with no `Retry-After`, a client that invented "a few seconds", and a user told the service was down.

### What to build
- Send `Retry-After` on every 429, and the standard rate-limit headers alongside.
- Document the limits per route class in the README and the spec.
- The error carries `code: "rate_limited"` and the seconds in the body as well as the header.

### Acceptance criteria
- [ ] Every 429 carries `Retry-After` and a code
- [ ] Limits are documented per route class
- [ ] A test drives a limiter to 429 and asserts the header
- [ ] The documented numbers match the configured ones, checked by a test

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L130 · `/status` has no documented shape

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:observability

### Background
`/status` is the endpoint every integrator and every uptime monitor hits first, and it is excluded from the OpenAPI coverage allow-list, so nothing describes what it returns or what would count as unhealthy. A monitor cannot be configured against a shape nobody has written down.

### What to build
- Document the response, and state which fields mean healthy.
- Distinguish process health from data health: the service can be up while every venue is stale, and those must not look the same.
- Return a non-200 only for conditions a monitor should page on, and say which those are.

### Acceptance criteria
- [ ] `/status` is documented with its full shape
- [ ] Process health and data health are separate fields
- [ ] The paging condition is stated and tested
- [ ] A monitor configuration example is in the docs

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L131 · There is no sixty-second quickstart

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:docs

### Background
The README opens with an endpoint table of twenty-five rows. A developer deciding whether to use Lens needs one command that returns a real number, and they need it in the first screen. The table is reference material and it is doing the job of an introduction.

### What to build
- A quickstart above the table: one curl against the live service, the real response beside it, and one sentence on what the numbers mean.
- The same for the GraphQL endpoint and the MCP server, each one command.
- A test that the curl in the README is syntactically valid and points at a route that exists.

### Acceptance criteria
- [ ] A working curl and its real response in the first screen of the README
- [ ] One example each for REST, GraphQL and MCP
- [ ] A test catches a quickstart that names a route the server does not register

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L132 · The README's endpoint table is maintained by hand

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:docs

### Background
Twenty-five rows typed out, with the routes and their descriptions, kept in step with the code by memory alone. `openapi.yaml` already knows every route, because a test fails when it does not.

### What to build
- Generate the table from the spec into the README, between markers, as part of `openapi:gen`.
- A CI check that fails when the committed README and a fresh generation differ.

### Acceptance criteria
- [ ] The table is generated from `openapi.yaml`
- [ ] CI fails on drift
- [ ] The generated table matches what is there today, or the PR says what was wrong

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L133 · No generated client, so every integrator writes the same fetch wrapper

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:intermediate, epic:dx

### Background
Lens has a complete OpenAPI description and no client generated from it. Every consumer — including the sibling wallet — writes its own typed wrapper, and each one re-derives the same response types by hand and gets them subtly wrong.

### What to build
- A generated TypeScript client, built in CI from `openapi.yaml`, published or committed.
- Types come from the spec, never hand-written, so a spec change is a client change.
- A short usage example in the README.

### Acceptance criteria
- [ ] A typed client is generated from the spec in CI
- [ ] Regenerating produces no diff when the spec has not changed
- [ ] One documented example compiles
- [ ] No type is hand-maintained

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L134 · Route code snippets exist in no language but curl

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:dx

### Background
The audience is building wallets and agents in TypeScript and Python. The docs offer curl, which proves the route works and does not help anyone integrate.

### What to build
- A TypeScript and a Python snippet per route group, generated from the spec so they cannot drift.
- Each snippet is runnable as written, with no placeholder a reader has to guess.

### Acceptance criteria
- [ ] TypeScript and Python snippets for every route group
- [ ] Generated, not typed
- [ ] Each runs as written against the live service
- [ ] No snippet contains an invented address

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L135 · Logs are not structured, so nothing can be queried

**Labels:** help wanted, Stellar Wave, area:infra, difficulty:easy, epic:observability

### Background
The service logs through pino, which emits JSON, but the messages themselves are prose with values interpolated into sentences. Finding every failure for one pair means a substring search, and counting them is impossible.

### What to build
- Values as fields, not inside the sentence: route, pair, network, venue, status, duration, request id.
- One logging helper so a new call site cannot invent its own shape.
- Keep the human-readable message; move the data out of it.

### Acceptance criteria
- [ ] Log lines carry values as fields
- [ ] One helper is used by every call site touched
- [ ] A documented query answers "every failure for this pair in the last hour"
- [ ] No value appears only inside a prose message

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L136 · Nothing checks the live service against its own spec

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate, epic:testing

### Background
`tests/openapi.test.ts` proves every registered route appears in the spec. It does not prove the deployed service answers in the shape the spec promises. The two can diverge the moment a handler changes a field, and nothing would notice until an integrator did.

### What to build
- A scheduled check that calls the live service for each route and validates the response against the spec's schema.
- It reports rather than fails the build, since the live service is not in CI's control.
- Append to an existing report rather than opening a new issue per run — a sibling repo's nightly job opens a fresh issue every night and the noise trained everyone to ignore it.

### Acceptance criteria
- [ ] Every documented route is validated against the live response
- [ ] Failures are reported in one place that updates rather than multiplying
- [ ] A deliberate schema mismatch is detected by the check
- [ ] The job's schedule and its cost are documented

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

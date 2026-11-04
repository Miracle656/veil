# Wave batch — Lens GraphQL & the paid surface (L187–L208)

Drafted 2026-10-16 by reading `Divinity-Labs/Lens` at `8e966ef`. Checked
against the 114 open issues in the repo first: nothing here duplicates one.

The theme: Lens has a GraphQL API that almost nobody has looked at. It is 234
lines, it exposes four queries and one subscription, and it is the only surface
in the service that is **not** behind the x402 paywall, **not** network-aware,
**not** depth-limited and **not** covered by a query test. The subscription is
genuinely good — five tests, including one proving networks do not cross — and
everything around it is a decade behind the REST side.

Two of these are bugs with money attached. The rest is a surface that was built
once and never finished.

## Shared with every issue

**Repo:** `Divinity-Labs/Lens`. Node + TypeScript, Fastify, **mercurius** for
GraphQL at `POST /graphql`, Prisma on Postgres, Redis, Prometheus.

**Run the tests:** `npm test`. **The tests are vitest, not jest.** Running jest
here reports "66 suites, 0 tests" and means nothing. A single file is
`npx vitest run src/__tests__/graphqlSubscription.test.ts`.

**`Load test (prices)` is already failing on `main`** and has been for some
time. It is not your PR. Everything else should be green.

**Read `src/__tests__/graphqlSubscription.test.ts` before you start.** It is the
house pattern for testing this surface and it is good — it drives a real
subscription through a real server and asserts on what a client receives.

**This service prices real assets on Stellar mainnet.** A wrong number is worse
than a missing one, because the caller cannot tell.

**Never elide an address, a contract id or a key** in code, comments or test
fixtures. A previous batch shortened a contract id in an issue and five
contributors invented plausible-looking ids to fill the gap. Write it in full or
not at all.

---

### L187 · The GraphQL pair matcher throws the issuer away

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:intermediate

### Background

`src/api/graphql.ts`:

```ts
function findPair(assetA: string, assetB: string) {
  const normalize = (a: string) => a.toLowerCase() === 'native' ? 'XLM' : a.split(':')[0].toUpperCase()
  ...
}
```

`a.split(':')[0]` keeps the asset **code** and discards the **issuer**. On
Stellar an asset is a code *and* an issuer — `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`
and a `USDC` issued by anyone else are different assets that trade at different
prices. With the issuer dropped, every asset called USDC is the same asset to
this resolver.

**This exact bug was fixed on the REST side** and the fix is on `main` as
`41b1f62`, "fix: do not answer a price request about a different asset", with
`src/__tests__/pairIssuerMatch.test.ts` covering it. The GraphQL surface was
never changed, so a GraphQL caller can still be answered about a different asset
than the one they asked for.

Read the REST fix first. This is the same change in a second place, not a new
design problem.

### What to build

- Match on code **and** issuer when the caller supplies a qualified asset.
- A bare code with no issuer should behave the way REST decided it behaves —
  read `src/api/rest.ts` and match it rather than inventing a second rule.
- `native` must keep resolving to XLM.
- A request naming an issuer we do not track must not fall back to a pair with
  the same code and a different issuer. Answering about the wrong asset is worse
  than answering "not found".

### Acceptance criteria

- [ ] A qualified asset only matches a pair with the same code **and** issuer
- [ ] A test asserts two assets sharing a code and differing in issuer do not match each other
- [ ] `native` still resolves to XLM
- [ ] An unknown issuer produces no match rather than a same-code match
- [ ] The behaviour for a bare, unqualified code matches the REST surface and a test says so

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L188 · GraphQL serves the paid REST data for free

**Labels:** help wanted, Stellar Wave, area:x402, difficulty:advanced

### Background

`src/middleware/x402.ts` gates routes behind USDC micropayments:

```ts
export const GATED_ROUTES: readonly GatedRoute[] = [
  { path: '/price',   method: 'GET', price: '$0.10', description: 'Unified SDEX+AMM price with VWAP and best route' },
  { path: '/pools',   method: 'GET', price: '$0.05', description: 'AMM liquidity pool reserves and spot prices' },
  { path: '/candles', method: 'GET', ... },
  ...
]
```

Every entry is a **GET** on a **REST** path. GraphQL is `POST /graphql`, so
`findGatedRoute` never matches it — and `getPrice` returns the same aggregated
price, VWAP and best route that `GET /price` charges $0.10 for.

Anyone who notices can read the entire paid surface for nothing, and the
`graphiql: true` console (L192) hands them the schema to do it with.

### What to build

This needs a decision before it needs code, so propose one in the PR:

- **Gate the operation, not the path.** A GraphQL request carries one or more
  operations; pricing has to be derived from which fields are requested, not
  from the URL. That is the only approach that survives a query asking for
  `getPrice` and `getBestRoute` together.
- Or **put GraphQL behind a paid API key** and leave x402 for REST, if per-call
  settlement on a batched query is not worth the complexity.

Whichever you pick:

- A single request asking for several gated fields must be priced as several,
  not one.
- An unpaid request must be rejected before any resolver does database work.
- Subscriptions are the same problem — see L193 — so say how your approach
  extends to them even if you do not implement it here.
- Document the pricing in the same place `GATED_ROUTES` is documented.

### Acceptance criteria

- [ ] A GraphQL query for a gated field is not free
- [ ] Price scales with the gated fields requested, not with the request count
- [ ] An unpaid request is rejected before any resolver queries the database
- [ ] A test asserts an unpaid `getPrice` query is refused while an unpaid `listPairs` is not
- [ ] The approach and its reasoning are written down, including how it extends to subscriptions

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L189 · GraphQL ignores the network the caller asked for

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:intermediate

### Background

REST resolves a per-request network from `?network=` or the `x-network` header
in `src/middleware/network.ts`. GraphQL does not. The resolver says so plainly:

```ts
// These queries carry no network argument, so they resolve against the
// active network's pair list (findPair above) and read that same
// network's price data — scoped, not pooled across both chains.
// Per-request network selection on the GraphQL surface is separate work.
```

The comment is honest and the behaviour is safe — it is scoped to
`activeNetwork`, not pooled — but on a deployment running both networks, a
GraphQL caller simply cannot ask about the other one. The subscription already
takes an optional `network` argument, so the two halves of the same API
disagree.

### What to build

- A `network` argument on `getPrice`, `getBestRoute`, `getPriceHistory` and
  `listPairs`, optional, defaulting to the active network — matching what
  `priceUpdated` already does.
- Honour the `x-network` header too, so a client setting it once gets consistent
  behaviour across REST and GraphQL.
- An explicit unrecognised network must be an error, as it is in REST, not a
  silent fallback.
- `findPair` must look in the requested network's pair list, not the active one.

### Acceptance criteria

- [ ] All four queries accept an optional `network` argument
- [ ] Omitting it resolves to the active network
- [ ] An unrecognised value is a GraphQL error naming the valid values
- [ ] The `x-network` header is honoured when no argument is given
- [ ] A test proves the same pair returns each network's own price

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L190 · A GraphQL query can nest as deep as it likes

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

`registerGraphQL` passes `schema`, `resolvers`, `graphiql` and `subscription` to
mercurius — and nothing else. There is no depth limit, so the server will parse
and execute an arbitrarily nested query.

The current schema has no cycle, which limits how bad this is **today**. But the
moment any type references another that references back — a pair containing
assets containing their pairs, which is the obvious next modelling step — an
unauthenticated POST can ask for a query nested hundreds of levels deep and the
server will try. A depth limit added now costs one option; added later it is a
breaking change for whoever has built on the deep query.

### What to build

- A maximum query depth, configurable, rejecting anything deeper **before**
  execution.
- The rejection should be a clear GraphQL error naming the limit, not a crash or
  a timeout.
- Introspection queries are legitimately deep — make sure the limit does not
  break the tooling, or exempt introspection deliberately and say so.
- Document the limit next to the schema so the next person adding a type knows
  the ceiling exists.

### Acceptance criteria

- [ ] Queries deeper than the limit are rejected before any resolver runs
- [ ] The limit is configurable and documented in `.env.example` if it becomes a variable
- [ ] The error names the limit and the depth that was requested
- [ ] A legitimate introspection query still works
- [ ] A test asserts both a passing and a rejected depth

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L191 · One GraphQL request costs one rate-limit token however much it asks for

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

Rate limiting counts HTTP requests. A REST caller wanting fifty pairs' prices
makes fifty requests and spends fifty tokens. A GraphQL caller asks for all
fifty in one document — aliasing the same field fifty times is legal GraphQL —
and spends **one**.

```graphql
{ a: getPrice(assetA:"XLM", assetB:"USDC") { price }
  b: getPrice(assetA:"XLM", assetB:"USDC") { price }
  … fifty more … }
```

Each alias runs the resolver, so that is fifty cache reads, fifty aggregate
computations and fifty best-route calculations behind a single token. Depth
limiting (L190) does not help: this query is two levels deep.

### What to build

- A query **cost** or complexity limit, in addition to depth. Assign a cost per
  field — the expensive resolvers are `getPrice`, `getBestRoute` and
  `getPriceHistory`, which hit the database and the cache — and reject a
  document whose total exceeds the budget.
- Or make rate limiting consume tokens proportional to the computed cost, which
  composes better with L188's pricing.
- Either way the limit must be computed from the parsed document **before**
  execution, not by counting resolver calls as they happen.

### Acceptance criteria

- [ ] A document's cost is computed before execution
- [ ] Repeated aliases of an expensive field increase the cost
- [ ] Exceeding the budget is a clear error, not a timeout
- [ ] Costs per field are declared in one place and documented
- [ ] A test proves fifty aliased `getPrice` calls do not cost the same as one

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L192 · GraphiQL and introspection are served unconditionally

**Labels:** help wanted, Stellar Wave, area:security, difficulty:easy

### Background

```ts
await app.register(mercurius, {
  schema,
  resolvers,
  graphiql: true,
  path: '/graphql',
  ...
})
```

`graphiql: true` is not conditional on the environment, so production serves a
full interactive query console at `/graphiql`, with schema introspection, to
anyone with the URL. Combined with L188 — GraphQL not being behind the paywall —
that is a browsable, executable console in front of the data the REST API
charges for.

Introspection on a public read API is a defensible choice. Shipping the IDE
unconditionally is almost certainly not a choice anyone made.

### What to build

- Enable `graphiql` only outside production, or behind the same auth as the
  admin routes.
- Decide introspection separately and deliberately — a public API arguably wants
  it, a paid one arguably does not. Whichever you pick, write down why.
- If introspection stays on, make sure L190's depth limit does not break it.

### Acceptance criteria

- [ ] GraphiQL is not served in production by default
- [ ] The setting is configurable and documented in `.env.example`
- [ ] The introspection decision is explicit and commented
- [ ] A test asserts the IDE is absent under production configuration
- [ ] `POST /graphql` itself is unaffected

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L193 · Subscriptions are free and unmetered

**Labels:** help wanted, Stellar Wave, area:x402, difficulty:intermediate

### Background

`priceUpdated` streams every price for a pair, indefinitely, over a websocket,
with no authentication and no metering. It is the most valuable thing the
service produces — a live feed — and it is the cheapest to take.

A REST caller polling `/price` every second pays $0.10 a time. A subscriber gets
a better feed, pushed, for nothing.

The subscription itself is well built: `withFilter` narrows per pair, the
network tagging is correct, and five tests cover it including one proving one
network's prices never reach another's subscriber. The gap is purely commercial.

### What to build

- Authenticate the subscription — an API key on the connection init payload is
  the usual shape for `graphql-transport-ws`.
- Meter it. A per-connection or per-message cost that fits whatever L188 decides
  for queries; the two should not be separate pricing models.
- Limit concurrent subscriptions per key, so one caller cannot open thousands.
- Reject unauthenticated connections at handshake, not after the first message.

### Acceptance criteria

- [ ] A subscription without valid credentials is refused at connection time
- [ ] Subscriptions are metered consistently with queries
- [ ] Concurrent subscriptions per key are capped and the cap is configurable
- [ ] The existing five subscription tests still pass
- [ ] A test covers an unauthenticated connection being refused

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L194 · GraphQL errors are unmasked, and this service has leaked a connection string before

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

No `errorFormatter` and no error masking is configured on mercurius, so a thrown
error's message travels to the caller in the `errors` array.

That matters here more than it would elsewhere: **this repo has already leaked a
Postgres connection string to callers through a raw error message**, from
`/price/twap`, and it was live for roughly three months. A `pg` error message can
carry the connection target, and the resolvers call `pgPool.query` directly with
no try/catch:

```ts
const agg = await getAggregatedPrice(pairKey, activeNetwork)
const route = await getBestRoute(pair.assetA, pair.assetB, pairKey, 1000, activeNetwork)
```

### What to build

- An `errorFormatter` that returns a safe, generic message for anything
  unexpected, while logging the real error server-side with its stack.
- Deliberate, caller-facing errors — unknown pair, bad network, over budget —
  must stay readable. Distinguish them with an error class or code rather than
  by matching on message text.
- Include a request id in the response so a caller can quote it and an operator
  can find the real error.
- A test that a database failure does not put the connection details, the SQL,
  or a file path in the response.

### Acceptance criteria

- [ ] An unexpected error returns a generic message to the caller
- [ ] The real error, with stack, is logged server-side
- [ ] Intentional user-facing errors keep their messages
- [ ] A correlating id is returned with errors
- [ ] A test asserts no connection string, SQL or path appears in a GraphQL error response

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L195 · `listPairs` returns bare strings

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:easy

### Background

```graphql
listPairs: [String]!
```

A caller gets `["USDC/XLM", "AQUA/XLM", …]` and nothing else — no issuer, no
network, no indication of whether a pair is actually being ingested or has gone
stale. To learn anything about a pair they must then call `getPrice` once per
pair, which is both slow and, after L191, expensive.

The REST `/pairs` route returns considerably more.

### What to build

- A `Pair` type carrying both assets with their codes **and issuers**, the pair
  key, the network, and a last-updated timestamp.
- Keep `listPairs` working or deprecate it explicitly — do not silently change
  the type of a field callers depend on.
- Match what REST `/pairs` returns, so the two surfaces describe the same world.
- Nullable fields where the data genuinely may be absent, non-null where it
  cannot be.

### Acceptance criteria

- [ ] Pairs are returned as a type with issuer and network, not bare strings
- [ ] The existing field either still works or is formally deprecated
- [ ] Field nullability matches whether the value can really be missing
- [ ] The shape agrees with REST `/pairs`
- [ ] A test asserts the issuer is present and correct

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L196 · There is no pools query

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:intermediate

### Background

REST serves `/pools` — AMM liquidity pool reserves and spot prices, priced at
$0.05 in `GATED_ROUTES`. GraphQL has no equivalent, so any client wanting both
prices and pools must speak two protocols.

### What to build

- A `pools` query returning the same data `/pools` does, for a pair or for all
  watched pairs.
- Reuse the REST handler's underlying function rather than reimplementing the
  query — two implementations of the same read will diverge.
- Network-aware per L189.
- Priced consistently with whatever L188 decides; if that has not landed, leave
  a clear comment saying it must be gated.

### Acceptance criteria

- [ ] A `pools` query returns reserves and spot prices
- [ ] It shares its implementation with the REST route
- [ ] It is network-aware
- [ ] Pool identifiers are returned in full, never shortened
- [ ] A test asserts GraphQL and REST return the same pools for the same input

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L197 · There is no screener query

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:intermediate

### Background

`/screener` filters and sorts pairs by volume, 24h change, price and liquidity,
with pagination. It is the query a client most wants from GraphQL, because the
whole point of GraphQL is asking for a filtered slice and the fields you want —
and it is absent.

### What to build

- A `screener` query with the same filters, sort fields and cursor pagination
  the REST route supports.
- Input types for the filters rather than a long argument list.
- Reuse the REST implementation.
- `market_cap` must be rejected the way REST rejects it: Lens has no circulating
  supply data, and the REST route already explains this in a constant. Do not
  quietly return null instead.

### Acceptance criteria

- [ ] Filtering, sorting and cursor pagination all work
- [ ] Filters are expressed as input types
- [ ] The implementation is shared with REST
- [ ] `market_cap` is rejected with the same explanation REST gives
- [ ] A test covers one filter, one sort and one page boundary

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L198 · There is no volumes or spreads query

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:intermediate

### Background

`/volumes/:asset` and `/spreads/:asset` both exist on REST and neither has a
GraphQL equivalent. Spreads in particular is the per-venue view — which venue
quoted what — and it is the data a GraphQL client would most want to request
selectively, since a caller usually wants one venue's number rather than all.

### What to build

- A `volumes` query and a `spreads` query matching the REST routes.
- Per-venue results as a list of a `VenueQuote` type, so a caller can select
  just the fields they want per venue.
- Network-aware per L189.
- Shared implementation with REST.

### Acceptance criteria

- [ ] Both queries exist and match their REST counterparts
- [ ] Venue results are a typed list, not a map or a string
- [ ] Both are network-aware
- [ ] Implementations are shared with the REST routes
- [ ] Tests assert parity with REST for the same input

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L199 · There is no oracle query

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:intermediate

### Background

`src/routes/oracle.ts` serves the oracle comparison — Lens's own aggregate
against configured oracle sources, with each source reported as configured,
available or unreachable. That comparison is the most interesting thing the
service computes and GraphQL cannot reach it.

### What to build

- An `oracle` query returning the comparison for a pair.
- Each source as a typed object with its name, value, status and the age of its
  reading, rather than a flattened set of scalars.
- A source that is unreachable must be distinguishable from one that is
  configured-and-reporting-nothing — that distinction is the point of the route.
- Network-aware, shared implementation with REST.

### Acceptance criteria

- [ ] An `oracle` query returns per-source comparison data
- [ ] Source status is an enum, not a free-text string
- [ ] Unreachable and empty are distinct states
- [ ] Implementation is shared with the REST route
- [ ] A test covers an unreachable source

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L200 · `getPriceHistory` cannot express a time range

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:easy

### Background

```graphql
getPriceHistory(assetA: String!, assetB: String!, window: String!, limit: Int): [PriceBucket]
```

The only controls are a window size and a count, both anchored to now. A caller
wanting last Tuesday has to pull every bucket since then and discard most of it.
REST `/prices/history` takes `from` and `to`.

### What to build

- Optional `from` and `to` arguments, ISO 8601, validated.
- Keep `limit` as a cap, and keep the existing bound on how many buckets a
  single request may produce — the REST route rejects a window that would
  produce too many points, and this should behave the same way.
- `from` after `to` is an error.
- Say in the schema description whether the range is inclusive at both ends.
  Elsewhere in this codebase range queries are inclusive at both ends, which
  makes adjacent windows double-count the boundary — do not quietly repeat that
  here; state it.

### Acceptance criteria

- [ ] `from` and `to` are supported and validated
- [ ] An over-large range is rejected rather than served
- [ ] `from` after `to` is an error
- [ ] Boundary inclusivity is documented in the schema description
- [ ] Tests cover a bounded range, an invalid range and an over-large one

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L201 · Money is a Float throughout the GraphQL schema

**Labels:** help wanted, Stellar Wave, area:data-integrity, difficulty:advanced

### Background

```graphql
price: Float!
sdexPrice: Float!
ammPrice: Float!
vwap: Float!
volume: Float!
```

GraphQL's `Float` is an IEEE 754 double. Prices are stored as
`Decimal(36, 18)` in `schema.prisma` and are already cast `::float` in 18 places
in the SQL — this schema is the last step of that chain, and it makes the loss
permanent and caller-visible.

For an asset priced around 0.18 this rarely matters. For a long-tail asset
priced at 0.000000000000001234, or a volume in the billions, doubles start
eating digits — and the whole purpose of this API is being the number other
systems trust.

### What to build

This is a design change, so propose it before building it.

- A custom `Decimal` scalar serialising as a **string**, preserving the stored
  precision end to end.
- Decide what happens to existing clients: adding a new field alongside the
  `Float` and deprecating the old one is the usual path, and it is a breaking
  change either way, so the migration needs stating.
- Audit where the `::float` casts happen — fixing the schema while the SQL still
  rounds achieves nothing.
- A test with a value that genuinely cannot survive a double round-trip.

### Acceptance criteria

- [ ] Monetary values can be requested at full stored precision
- [ ] The precision survives the whole path, SQL included
- [ ] Existing clients have a documented migration
- [ ] A test asserts a value that a double would round is returned exactly
- [ ] The trade-off and the migration are written down

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L202 · The schema is a template literal with nothing checking it

**Labels:** help wanted, Stellar Wave, area:dx, difficulty:easy

### Background

The schema lives as a backtick string inside `src/api/graphql.ts`. There is no
`.graphql` file in the repo, so no editor tooling, no linting, no diffable
artifact, and no way for a consumer to generate a client without introspecting a
running server.

It also means a schema change is invisible in review unless the reviewer reads
the string carefully — and a breaking change to a published API deserves more
than that.

### What to build

- Export the schema as an SDL artifact at build time, committed or generated
  into a known path.
- A CI check that the committed artifact matches the schema the code defines, so
  the two cannot drift — the repo already has a `.env.example` drift guard; copy
  its approach.
- Optionally, a check that flags a **breaking** schema change, so removing a
  field is a deliberate act rather than a surprise.

### Acceptance criteria

- [ ] An SDL artifact exists at a documented path
- [ ] CI fails when the artifact and the code disagree
- [ ] Regenerating it is one documented command
- [ ] The artifact is valid SDL that a client generator can consume
- [ ] The README says where it is and how to refresh it

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L203 · Every subscriber is woken by every price

**Labels:** help wanted, Stellar Wave, area:websocket, difficulty:intermediate

### Background

```ts
const onPricePublished = (event: PricePublishedEvent) => {
  app.graphql.pubsub.publish({ topic: PRICE_TOPIC, payload: { priceUpdated: event } })
}
```

Every price goes onto one topic, `PRICE_UPDATED`, and each subscriber filters it
down with `withFilter`. Correct, and simple — but the filter runs per subscriber
per event. With a thousand subscribers each watching one pair, a single price
update runs a thousand filter callbacks, nine hundred and ninety-nine of which
discard it.

At the current scale this is invisible. It is also the kind of thing that is
cheap to fix now and a rewrite once there is traffic.

### What to build

- Publish to a topic keyed by pair and network, so the pubsub layer does the
  routing and a subscriber is only woken for its own pair.
- Keep the current behaviour for a subscription with no network argument, which
  deliberately receives every network — the existing test covers this and must
  keep passing.
- A metric of active subscriptions by pair, so the distribution is visible.
- Measure before and after with a representative number of subscribers, and put
  the numbers in the PR. A performance change without a measurement is a guess.

### Acceptance criteria

- [ ] A subscriber is only woken for events matching its subscription
- [ ] All five existing subscription tests still pass unchanged
- [ ] A network-less subscription still receives every network
- [ ] Active subscriptions are exported as a metric
- [ ] The PR contains a before-and-after measurement

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L204 · No metric distinguishes GraphQL from anything else

**Labels:** help wanted, Stellar Wave, area:observability, difficulty:easy

### Background

`src/metrics.ts` has no GraphQL metrics, and `src/middleware/httpMetrics.ts`
sees GraphQL as a single route: `POST /graphql`. So every GraphQL request looks
identical on the dashboard whatever it asked for, and `getPrice` traffic is
invisible — the resolver increments `price_requests_total`, which does not say
it came from GraphQL.

Once L188 prices GraphQL, "how much GraphQL traffic is there and what is it
asking for" becomes a revenue question, not just an operational one.

### What to build

- A counter of GraphQL operations by operation name and type (query,
  mutation, subscription).
- A histogram of resolver duration by field, for the expensive fields at least.
- A counter of GraphQL errors by category.
- **Keep label cardinality bounded.** Operation names come from the client and
  are therefore unbounded — fold unknown names into one label value rather than
  creating a series per name.

### Acceptance criteria

- [ ] Operations are counted by name and type
- [ ] Resolver duration is recorded for the database-backed fields
- [ ] Errors are counted with a bounded set of categories
- [ ] No client-supplied string becomes an unbounded label
- [ ] Metrics appear on the existing `/metrics` endpoint

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L205 · No test ever executes a GraphQL query

**Labels:** help wanted, Stellar Wave, area:testing, difficulty:intermediate

### Background

`src/__tests__/graphqlSubscription.test.ts` covers the subscription well — five
tests, including network isolation and clean channel close. Nothing covers the
**queries**. `getPrice`, `getBestRoute`, `getPriceHistory` and `listPairs` have
never been executed through the GraphQL layer by any test.

That is why L187 — the issuer being discarded — has survived here after being
found and fixed on the REST side. A single parity test would have caught it.

### What to build

- Tests that execute each query through a real mercurius instance, in the style
  of the subscription test.
- At least one parity test per query: the same question asked over REST and over
  GraphQL returns the same answer. That is the test that keeps the two surfaces
  honest as either changes.
- Cover the error paths too — unknown pair, bad arguments.
- Mock the database as the rest of the suite does; do not require a live
  Postgres.

### Acceptance criteria

- [ ] Every query has at least one test executing it through GraphQL
- [ ] At least one REST/GraphQL parity assertion exists per query
- [ ] Error paths are covered
- [ ] Tests mock the database and need no live Postgres
- [ ] The existing subscription tests are untouched

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L206 · An unknown pair is answered with silence

**Labels:** help wanted, Stellar Wave, area:graphql, difficulty:easy

### Background

```ts
const pair = findPair(assetA, assetB)
if (!pair) return null
```

A caller asking about a pair Lens does not track gets `{"data":{"getPrice":null}}`.
A caller asking about a pair that exists but has no data yet gets the same. A
caller who misspelled an asset code gets the same. Three different situations,
one indistinguishable answer — and the schema's `AggregatedPrice` being nullable
means this is not even an error a client library will raise.

### What to build

- Distinguish the cases: unknown pair, known pair with no data, and invalid
  input are three different answers.
- Invalid input should be a GraphQL error. "Known but empty" should probably not
  be — decide, and write down why.
- Where an error is returned, give it a machine-readable code in `extensions`
  so clients branch on the code and not the message.
- Keep it consistent with how REST answers the same three cases; if REST is
  inconsistent, say so rather than copying it.

### Acceptance criteria

- [ ] The three cases are distinguishable by a client
- [ ] Errors carry a machine-readable code in `extensions`
- [ ] The choice of error-versus-null is documented in the schema description
- [ ] Behaviour agrees with REST, or the disagreement is explained
- [ ] Tests cover all three cases

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L207 · The GraphQL API is undocumented

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy

### Background

The REST API has `openapi.yaml`, `openapi.json` and a drift test that fails when
a route is undocumented. GraphQL has a template literal. A developer evaluating
Lens has no way to learn the GraphQL surface exists, let alone what it offers,
without reading `src/api/graphql.ts`.

OpenAPI cannot describe GraphQL, so the answer is not to force it into the spec
— it is to document it properly on its own terms.

### What to build

- A documentation page covering the GraphQL endpoint: where it is, the queries
  and the subscription, with a working example of each.
- A subscription example that shows the `graphql-transport-ws` handshake, since
  that is the part people get wrong.
- Say plainly which REST capabilities have no GraphQL equivalent today — L196
  through L199 are that list — so nobody has to discover it by trying.
- Link it from the README beside the REST documentation.
- Every example must be runnable as written. An example that does not run is
  worse than none.

### Acceptance criteria

- [ ] A GraphQL documentation page exists and is linked from the README
- [ ] Every query and the subscription have a runnable example
- [ ] The subscription example includes the handshake
- [ ] Gaps against REST are listed explicitly
- [ ] No address, contract id or key in any example is shortened

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L208 · Any client can send any query

**Labels:** help wanted, Stellar Wave, area:security, difficulty:intermediate

### Background

The endpoint accepts arbitrary documents from anyone. Depth (L190) and cost
(L191) limits bound how expensive a single document can be, but they do not
change the fact that an unauthenticated caller composes the query.

For a public exploratory API that is the right trade. For the paid surface — and
after L188, most of this is the paid surface — an allow-list of known documents
is the stronger position: it makes cost predictable, makes caching possible, and
removes the whole class of adversarial-query problems rather than bounding it.

### What to build

- Support persisted queries: a client sends a hash, the server executes the
  document it already knows.
- Decide whether arbitrary documents stay allowed — in development yes, in
  production it is a judgement call. Make it configurable and default to the
  safer option.
- A documented workflow for registering a query, or nobody will use it.
- Persisted queries make response caching tractable, since the document is known
  ahead of time — note that even if you do not implement it.

### Acceptance criteria

- [ ] A client can execute a registered query by hash
- [ ] Whether arbitrary documents are accepted is configurable, with a safe default
- [ ] An unknown hash is a clear error
- [ ] Registering a query is documented end to end
- [ ] Tests cover a registered hash, an unknown hash, and the arbitrary-document toggle

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

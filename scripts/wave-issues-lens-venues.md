# Wave batch — Lens venue coverage (L077–L096)

Drafted 2026-10-15. Lens aggregates SDEX, Stellar classic AMM pools, Soroswap
and Aquarius. Everything else on Soroban is invisible to it: Phoenix, Blend,
DeFindex, and the lending markets. A "unified Stellar price API" that cannot see
half the venues is not yet unified, and every missing venue is a route that
returns a worse price than the chain actually offers.

This batch adds venues. It is deliberately repetitive in shape — each adapter
follows `src/ingest/venues/aquarius.ts` — because the shape is proven and the
interesting work is in each protocol's own maths.

## Shared with every issue

**Repo:** `Divinity-Labs/Lens`. Node + Fastify + Prisma + Postgres. The tests are **vitest** (`npm test`), not jest — running jest against this repo fails every file and tells you nothing.

**Where venue adapters live:** `src/ingest/venues/`. `aquarius.ts` is the reference implementation: it reads reserves, derives a spot price from the constant-product invariant, and writes `price_points` rows with a distinct `source`. Follow its structure, including `_resetLastPrice()` for tests.

**Every row carries a network.** `price_points.network` exists and is indexed `(network, pairKey, timestamp DESC)`. A new ingester runs once per entry in `ENABLED_NETWORKS` (`src/network/enabledNetworks.ts`) and must write the network it read from. An adapter that hard-codes a network will silently merge mainnet and testnet prices into one series — that bug already exists on four routes and is being fixed separately.

**Never elide a contract id or an issuer.** Take every address from the protocol's own documentation and paste it whole. A previous batch in a sibling repo wrote `CD2W5LUR…XZ4L` in an issue and five contributors invented plausible-looking contract ids to fill the gap. If you cannot find the real address, say so in the PR rather than inventing one.

**A price you cannot source is worse than no price.** Every adapter must record where a number came from — `source` on the row, and the venue in any API response that uses it. Silent blending across venues is how a "unified" price becomes an average of a real market and a dead one.

---

### L077 · No adapter for Phoenix, one of Soroban's largest DEXs

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:advanced, epic:venues

### Background
`src/ingest/venues/` contains exactly one file, `aquarius.ts`. Soroswap has its own ingester at `src/ingesters/soroswap.ts`. Phoenix — a Soroban AMM with live pools and real volume — has neither, so a Lens caller asking for the best price on a pair Phoenix quotes gets an answer that ignores it.

### What to build
- A `src/ingest/venues/phoenix.ts` adapter modelled on `aquarius.ts`: discover pools, read reserves, derive spot price, write `price_points` with `source = 'phoenix_amm'`.
- Pool discovery must not be a hard-coded list that rots. Read it from the protocol's factory or its published registry, and cache the result with a TTL rather than per request.
- Take the factory contract id from Phoenix's own documentation and write it in full.
- Register the adapter so it starts once per enabled network.

### Acceptance criteria
- [ ] Phoenix pool prices appear in `price_points` with their own `source`
- [ ] Pools are discovered, not hard-coded; the discovery is cached
- [ ] One ingester instance per entry in `ENABLED_NETWORKS`, each writing its own `network`
- [ ] Tests cover reserve→price derivation, including a pool with zero reserves
- [ ] An unreachable Phoenix RPC degrades the venue, never the process

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L078 · Phoenix pools are not in `/pools`, so nobody can see what is watched

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:venues

### Background
`/pools` answers "which AMM pools is Lens watching". Once L077 lands, Phoenix pools are being read but are not listed, so an integrator cannot tell whether a missing price means "no pool" or "pool not watched".

### What to build
- Include Phoenix pools in `/pools`, each tagged with its venue.
- `/pools` must say which venue every pool belongs to; today the shape assumes one kind.
- Update `openapi.yaml` and the response schema.

### Acceptance criteria
- [ ] `/pools` lists Phoenix pools alongside the existing ones
- [ ] Every pool in the response names its venue
- [ ] `openapi.yaml` matches, and `tests/openapi.test.ts` passes
- [ ] A test asserts a mixed-venue response

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L079 · Blend lending markets have no price or rate ingestion

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:advanced, epic:venues

### Background
Blend is Stellar's lending protocol. Its pools hold real TVL and publish supply and borrow rates, and none of it reaches Lens. A caller cannot ask what it costs to borrow USDC on Stellar, which is one of the first questions any DeFi dashboard asks.

### What to build
- An adapter that reads each Blend pool's reserves, utilisation, supply APY and borrow APY.
- Rates are not prices. Store them in their own table rather than forcing them into `price_points`; a migration is part of this issue.
- Take pool and backstop contract ids from Blend's own documentation, in full.

### Acceptance criteria
- [ ] Blend pool state is ingested on a schedule, per enabled network
- [ ] Supply and borrow rates are stored with their own schema and retention
- [ ] Utilisation is derived, not copied, and a test pins the arithmetic
- [ ] A pool that cannot be read is skipped with a log and a metric, not a crash

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L080 · There is no endpoint for lending rates

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:venues

### Background
With L079 ingesting Blend rates, nothing exposes them. "What is the best USDC yield on Stellar right now" is a question Lens is well placed to answer and currently cannot.

### What to build
- `GET /rates/:asset` returning supply and borrow rates per venue, sorted best-first, with the pool each came from.
- Honour `?network=`.
- An `openapi.yaml` entry with the `network` parameter declared, and the response field documented.

### Acceptance criteria
- [ ] `/rates/:asset` answers with per-venue rates and names each pool
- [ ] `?network=` is honoured and declared in the spec
- [ ] An asset with no lending market returns an empty list and a 200, not a 404
- [ ] Tests cover an asset in several venues and an asset in none

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L081 · DeFindex vaults are invisible

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:advanced, epic:venues

### Background
DeFindex vaults hold positions across underlying strategies and publish a share price. A vault share is an asset people hold, and Lens prices no vault shares, so a portfolio built on Lens undervalues or ignores them entirely.

### What to build
- An adapter that reads each vault's total assets and total shares and derives the share price.
- Share price must be derived from on-chain state, never from a published figure that could be stale.
- Store with a `source` that distinguishes a derived vault price from a traded one.

### Acceptance criteria
- [ ] Vault share prices are ingested per enabled network
- [ ] The derivation handles a vault with zero shares without dividing by zero
- [ ] A test pins share-price arithmetic against known reserves
- [ ] The source makes clear the price is derived, not traded

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L082 · `src/ingest/cex/` ships only a mock

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:cex

### Background
`src/ingest/cex/index.ts` defines `CexAdapter` and its doc comment names "Coinbase, Binance, Kraken, …" as the concrete adapters. The directory contains `index.ts` and `mock.ts`. There are no real adapters, so every cross-venue comparison Lens offers compares Stellar venues against nothing.

### What to build
- One real adapter, complete, as the pattern for the rest: fetch the ticker, normalise the pair identifier, and satisfy `CexAdapter` exactly.
- Rate-limit and back off according to the exchange's published limits, and never let an exchange outage affect the process.
- Record the exchange in `source`, so a CEX price is never mistaken for an on-chain one.

### Acceptance criteria
- [ ] One exchange adapter implements `CexAdapter` in full and is registered through `createCexAdapter`
- [ ] Pair normalisation is tested both directions, including a pair the exchange names differently
- [ ] Rate limiting and backoff are implemented and tested against a stubbed 429
- [ ] A failing exchange degrades to no CEX price, never an error response

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L083 · A second and third CEX adapter, so "cross-venue" means something

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:cex

### Background
One exchange is a sample, not a market. Cross-venue spread and arbitrage only mean something once there are several independent sources, and the `CexAdapter` interface exists precisely so adding them is mechanical.

### What to build
- Two further exchange adapters behind the same interface, with their own pair normalisation.
- A registry so adapters are enabled by configuration rather than by editing code.
- No adapter may be required: a missing API key disables that venue quietly.

### Acceptance criteria
- [ ] Two further adapters implement `CexAdapter` and are registered
- [ ] Enabled venues are configuration, not a code change
- [ ] A venue with no credentials is skipped with a log, and the rest still run
- [ ] Tests cover each adapter's normalisation

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L084 · CEX prices are ingested and nothing compares them to the chain

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:cex

### Background
The most useful thing Lens can say about a CEX price is how far the on-chain price is from it. That is the number that tells a trader whether a Stellar venue is mispriced, and it is the number nobody else publishes for Stellar.

### What to build
- `GET /premium/:assetA/:assetB` — the on-chain price, the best CEX price, and the difference in basis points, naming both sources and both timestamps.
- A premium computed from stale data is a lie: refuse to answer when either side is older than a configurable staleness bound, and say which side was stale.
- `openapi.yaml` entry, `?network=` honoured.

### Acceptance criteria
- [ ] The endpoint returns both prices, both sources, both timestamps and the spread in bps
- [ ] A stale side produces an explicit refusal naming it, not a silently wrong number
- [ ] The staleness bound is configurable
- [ ] Tests cover fresh, one-side-stale and both-stale

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L085 · Venue adapters have no shared contract, so each one drifts

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:venues

### Background
`src/ingesters/` holds `amm.ts`, `sdex.ts`, `soroswap.ts`; `src/ingest/venues/` holds `aquarius.ts`. Two directories, no shared interface, and each file re-implements scheduling, error handling and the last-price map. Every new venue in this batch multiplies that.

### What to build
- A `VenueAdapter` interface covering discovery, read, derive and write, with scheduling and error handling owned by the runner rather than each adapter.
- Migrate the existing adapters onto it. Behaviour must not change; this is a refactor and the tests are the proof.
- One directory, not two.

### Acceptance criteria
- [ ] A single `VenueAdapter` interface, implemented by every existing adapter
- [ ] Scheduling, retry and error handling live in the runner, not in adapters
- [ ] Existing tests pass unchanged, and `source` values are identical before and after
- [ ] Adding a venue requires no change to the runner

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L086 · A venue that goes quiet is indistinguishable from a venue with no trades

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:data-quality

### Background
If an adapter stops writing — bad credentials, a changed API, a renamed pool — the last price it wrote stays in the table and keeps being aggregated. There is no heartbeat per venue, so a dead venue looks exactly like a quiet one, and its stale price keeps influencing every VWAP that includes it.

### What to build
- A per-venue heartbeat: last successful read, last write, and consecutive failures.
- Prices older than a per-venue staleness bound are excluded from aggregation, and the exclusion is visible rather than silent.
- Expose the heartbeat on `/status` and as a Prometheus gauge.

### Acceptance criteria
- [ ] Every venue reports last-success, last-write and consecutive-failure count
- [ ] Stale venue prices are excluded from aggregates, and responses say a venue was excluded
- [ ] `/status` and `/metrics` both expose it
- [ ] A test drives a venue to stale and asserts it leaves the aggregate

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L087 · Pool discovery is not incremental, so new pools appear only on restart

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:venues

### Background
A pool created after the process started is not watched until someone restarts it. On a chain where pools are deployed continuously, that means Lens is permanently behind, and the gap is invisible because nothing reports it.

### What to build
- Periodic re-discovery per venue, on its own interval, adding new pools without a restart.
- Removal of pools that have gone, with the rows they wrote retained.
- A metric for pools added and removed per cycle.

### Acceptance criteria
- [ ] New pools are picked up without a restart, within a configurable interval
- [ ] Disappearing pools stop being read, and their history is kept
- [ ] Added/removed counts are exported as metrics
- [ ] A test covers a discovery cycle that adds and removes

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L088 · `/compare/:asset` knows one oracle

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:oracles

### Background
`src/ingest/oracles/` contains `reflector.ts` and nothing else. `/compare/:asset` therefore compares Lens against exactly one oracle, which makes it a two-point comparison with no way to tell which of the two is wrong when they disagree.

### What to build
- Generalise the oracle layer to several sources behind one interface, with Reflector as the first implementation.
- `/compare/:asset` reports every configured oracle, each named, with its own timestamp and deviation.
- An oracle that is unreachable is reported as unreachable, not omitted.

### Acceptance criteria
- [ ] An `OracleAdapter` interface with Reflector migrated onto it
- [ ] `/compare/:asset` returns every configured oracle, named and timestamped
- [ ] An unreachable oracle is reported, not silently dropped
- [ ] `openapi.yaml` updated and covered

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L089 · Lens consumes oracle prices and publishes none

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:advanced, epic:oracles

### Background
Lens aggregates more Stellar venues than any oracle on the network, and that aggregate is reachable only over HTTP. A Soroban contract cannot read it. SEP-40 is the interface Stellar contracts already use for price feeds, and nothing stops Lens answering it.

### What to build
- A SEP-40 compatible publisher: a contract interface Lens pushes its aggregate into, so on-chain consumers can read a Lens price.
- Publication must be rate-limited and deviation-triggered, not a write per tick — the cost of writing every sample to the chain is the reason oracles batch.
- The published price must carry the same staleness and source guarantees as the API.

### Acceptance criteria
- [ ] A documented SEP-40 compatible surface a contract can read
- [ ] Publication triggers on deviation and a maximum interval, not on every sample
- [ ] A stale aggregate is never published
- [ ] Deployment and key handling are documented; no key is committed

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L090 · No venue-level TVL, so "liquidity" has no denominator

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
`/screener` sorts by liquidity, and `/pools` lists pools, but nothing reports total value locked per venue or in total. TVL is the single most requested number about any DeFi ecosystem, and Stellar's is reported by third parties that do not see Soroswap, Aquarius and Phoenix together.

### What to build
- `GET /tvl` — total value locked, broken down by venue and by asset, with the price source used for the valuation named.
- Valuing TVL needs a price per asset; a pool whose assets Lens cannot price must be reported as unpriced rather than counted as zero.
- Honour `?network=`.

### Acceptance criteria
- [ ] `/tvl` reports total and per-venue TVL with the valuation source named
- [ ] Unpriceable pools are reported as unpriced, never silently zero
- [ ] `?network=` honoured and declared
- [ ] Tests cover a pool with an unpriceable asset

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L091 · Nothing records a venue's share of volume

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
`/volumes/:asset` gives a per-venue breakdown for one asset. There is no view of the market as a whole — which venue is actually winning flow on Stellar, and how that is changing. That is the question every ecosystem report asks and nobody can answer from public data.

### What to build
- `GET /venues?window=24h` — every venue with its traded volume, its share, and the change against the previous window.
- Shares must sum to 100 within a stated tolerance, and the response must say which venues were excluded for staleness.

### Acceptance criteria
- [ ] Per-venue volume, share and period-over-period change
- [ ] Shares reconcile to the total, with excluded venues named
- [ ] Windows `24h`, `7d`, `30d` supported
- [ ] Tests cover a window where a venue has no trades at all

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L092 · Classic AMM and Soroswap ingesters live outside `src/ingest/`

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:easy, epic:venues

### Background
`src/ingesters/` and `src/ingest/` both exist and both hold ingestion code. New contributors put new work in whichever they happened to open first, which is how the split persists.

### What to build
- One location for ingestion. Move `amm.ts`, `sdex.ts`, `soroswap.ts`, `snapshot.ts` and `toid.ts` into the surviving tree and update every import.
- No behaviour change, no renamed `source` values.

### Acceptance criteria
- [ ] A single ingestion directory; the other is gone
- [ ] All imports updated, `npm test` green, build clean
- [ ] No `source` string changes

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L093 · An adapter cannot be tested without hitting the network

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate, epic:testing

### Background
Adding a venue means adding a test, and there is no fixture layer for venue responses. Each new adapter in this batch will otherwise invent its own stubbing, and the ones that cannot be bothered will ship untested.

### What to build
- Recorded fixtures per venue — a real response, saved, with the date and the source URL in the file.
- A helper that builds an adapter against fixtures with no network access, and fails loudly if a test tries to reach the network.
- Migrate the existing adapters' tests onto it.

### Acceptance criteria
- [ ] Fixtures exist per venue, each recording where and when it was captured
- [ ] A test helper runs any adapter against fixtures
- [ ] Network access during tests fails the run rather than being slow
- [ ] Existing adapter tests use it

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L094 · A venue's decimals are assumed, never read

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:data-quality

### Background
Soroban tokens declare their own decimals, and nothing requires them to be 7. An adapter that assumes Stellar's classic 7 places will be wrong by orders of magnitude on any token that differs — and wrong silently, because a price is still a number.

### What to build
- Read `decimals` from each token contract and scale reserves with it.
- Cache per token; a token's decimals do not change.
- A sanity bound: a derived price outside a configurable plausible range is rejected and logged rather than written.

### Acceptance criteria
- [ ] Decimals are read per token, not assumed
- [ ] Cached, with the cache tested
- [ ] A price outside the plausible range is rejected with a log and a metric
- [ ] A test covers a token with decimals other than 7

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L095 · Nothing tells an integrator which venues exist

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:venues

### Background
After this batch Lens reads from several venues with different characteristics — on-chain and off, AMM and order book, traded and derived. No endpoint lists them, so an integrator has to read the source to find out what they are consuming.

### What to build
- `GET /venues/registry` — every venue, its kind, whether it is on-chain, which network it covers, and its current heartbeat.
- Generated from the adapter registry, so it cannot drift from reality.

### Acceptance criteria
- [ ] The endpoint lists every registered venue with kind, network and liveness
- [ ] It is generated from the registry, not a hand-written list
- [ ] `openapi.yaml` entry and coverage test
- [ ] Adding a venue changes the response with no further code

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L096 · The README's venue list is hand-maintained and already wrong

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:docs

### Background
The README says Lens "aggregates price data from Stellar's Classic Order Book (SDEX) and AMM Liquidity Pools". Soroswap and Aquarius are already ingested and not mentioned; everything this batch adds will be missing too. A README that undersells what the service does is a documentation bug with a direct cost.

### What to build
- A venues section generated from the registry in L095, checked by a test that fails when the README and the registry disagree.
- The same treatment for the endpoint table, which has the same failure mode.

### Acceptance criteria
- [ ] The README's venue list is generated, not typed
- [ ] A test fails when the README and the registry diverge
- [ ] The current list is correct as of this PR

> **Drips Wave** · Complexity: **Easy** · **100 points**

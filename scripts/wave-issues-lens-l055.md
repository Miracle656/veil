# Lens wave batch — price correctness, dual-network, public surface (DRAFT)

**Repo:** `Miracle656/Lens`. **IDs:** L055–L070. **Points:** Easy 100 · Intermediate 150 · Advanced 200.

**Before publishing:** ensure `Stellar Wave`, `help wanted`, `difficulty:*`, `points:*` exist, plus `area:pricing`, `area:api`, `area:ci`.

## Shared with every issue

### The shape of the problem

Lens aggregates SDEX trades and AMM pool prices into VWAP, OHLCV and best-route data. It is in good shape on the surface — 47 test files, 401 passing tests, a clean typecheck, changesets, OpenAPI publishing, Prometheus metrics.

Underneath it is **two codebases wearing one coat.** Everything written since the dual-network work (#113–#118) is network-aware. Everything written before it silently pools testnet and mainnet: exactly one of roughly twenty data-reading modules filters by `network`. Several issues below are that seam.

### State of `main` before you start

Verified on 2026-09-24: `npx tsc --noEmit` exits 0, and `npx vitest run` gives **400 passed, 1 skipped**, green across seven consecutive runs.

So two open issues are stale and should not scare you off:
- **#146** ("broken `@stellar/stellar-sdk` vitest mock makes every PR look red") does not reproduce on `main`.
- **#151** ("flaky suite, fails ~1 in 5") did not reproduce in seven runs. The underlying hazard is real though: `src/config.ts:245-253` memoises each `NetworkConfig` in a module-level `Map` on first access, so whichever test file imports first freezes `process.env` for every other file.

**#113** ("restructure `config.ts` into a per-network map") is already fully implemented at `src/config.ts:97-315`.

### Ground rules

- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- A price with the wrong units, the wrong network or the wrong timestamp is worse than no price. Prefer refusing to answer over answering confidently.
- Don't widen a Prometheus label to something unbounded. Pairs and networks are fine; issuers and pool ids are not.
- Don't reformat a file you're changing.

---

### L055 · `slippagePct` on `/price/:a/:b/route` is always exactly zero

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:easy

### Background
`src/aggregator/bestRoute.ts:114-115` computes `spotPrice = Math.max(sdexPrice, ammPrice)` and then `slippagePct = |estimatedOutput/amount − spotPrice| / spotPrice`. But all five branches above it set `estimatedOutput` to exactly `Math.max(sdexPrice, ammPrice) * amount` (lines 90, 94, 101, 105, 109), so the numerator is identically zero. The field has never carried information.

Worse, `tests/aggregator.property.test.ts:93` asserts `expect(result.slippagePct).toBeCloseTo(0, 6)` across the whole generated input space — the property test cements the bug instead of catching it.

The AMM branch has the real quote available: `getAMMPrice` already applies the constant-product curve, so execution price and reserve-ratio spot price genuinely differ, and their gap is the slippage.

### Acceptance criteria
- [ ] `slippagePct` is computed against a true spot reference, not against the execution price it was derived from
- [ ] A test proves slippage grows with `amount` against a fixed pool — near zero when small, materially above zero when large
- [ ] The property test no longer pins the value to 0
- [ ] Route selection is unchanged; this PR fixes the reported number only
- [ ] The dead ternary at `bestRoute.ts:102` is removed

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L056 · AMM snapshots are tagged with the process's network, not the ingester's

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:easy

### Background
`src/ingesters/amm.ts:38-42` declares `snapshotPool(pool, pair, network)` and correctly passes `network` to `upsertPricePoints` at line 87 — but the `prisma.poolSnapshot.create` at **line 57 writes `network: activeNetwork`**.

With both networks enabled (`src/index.ts:252-260` starts one loop per network), every mainnet pool snapshot is stored tagged `testnet`. This is precisely the failure the comment at `src/db.ts:32-38` says the required-`network`-argument design exists to prevent; it just was not applied to the sibling table. Reserves and spot prices from two chains now share a row space that `/pools`, `/screener` and `getAMMPrice` all read.

### Acceptance criteria
- [ ] `src/ingesters/amm.ts:57` uses the `network` parameter
- [ ] A test calls `snapshotPool(pool, pair, 'mainnet')` with `STELLAR_NETWORK` unset and asserts the row carries `network: 'mainnet'` — fails before
- [ ] Every other `activeNetwork` reference inside a function that already takes a `network` parameter is audited
- [ ] The PR says whether existing mis-tagged rows need backfilling

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L057 · Reject malformed contract ids at config load — two defaults are invalid

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background
Stellar contract ids are 56 characters. Two built-in defaults in `src/config.ts` are **55**: the testnet Soroswap factory at line 128, and the mainnet Reflector oracle at line 163. (The mainnet Soroswap factory at line 127 is correctly 56.)

Because `soroswapEnabled` defaults to `true` (line 137) and `oracleEnabled` only checks for a non-empty string (lines 166-168), both features boot "enabled" and then fail on every RPC call with an opaque decode error rather than a config error. Config should refuse to hand out an address it already knows is unusable.

### Acceptance criteria
- [ ] `buildNetworkConfig` validates every contract id with `StrKey.isValidContract` — already available via `@stellar/stellar-sdk`
- [ ] An invalid id either throws at load naming the env var, or forces `enabled: false` with a warning — pick one and document it
- [ ] A test asserts both current literals are rejected and a valid 56-character id passes
- [ ] Both literals are replaced with correct addresses, or removed in favour of a required env var
- [ ] `.env.example` says what each address is and where to get it

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L058 · `/status` reports `lastIndexedLedger: null` and mixes networks

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
`src/api/rest.ts:73-75` reads `indexer_state` ordered by `updated_at` with **no `network` predicate**, so under dual-network it returns whichever chain wrote most recently. And `last_ledger` is permanently null, because `src/ingesters/sdex.ts:71` calls `setIndexerCursor` omitting the optional `ledger` argument and `sdex.ts:53` hardcodes `ledger: 0`.

`/status` is the UptimeRobot health target named in `docs/DUAL_NETWORK.md`, so the one field monitoring would page on is dead.

### Acceptance criteria
- [ ] `/status` honours `req.network` — the selector at `src/middleware/network.ts:60` already populates it — and filters `indexer_state` by it
- [ ] The response names the network it answered for and lists that network's watched pairs
- [ ] `lastIndexedLedger` is non-null once SDEX has ingested
- [ ] A test asserts two networks' rows do not bleed into one another
- [ ] Optionally an `ingestLagSeconds` field, so a stalled ingester is visible without Prometheus

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L059 · The aggregate-refresh worker writes a cache key nobody reads

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
`src/jobs/aggregateRefresh.ts:39` calls `setCachedPrice(pairKey, …)` with a bare pair key. The `/price` route at `src/api/rest.ts:98-99` reads `getCachedPrice(\`${network}:${pair.pairKey}\`)`. Since `src/redis.ts:51,59` additionally prefixes `lens:${activeNetwork}:price:`, the worker writes `lens:testnet:price:XLM/USDC` while the route reads `lens:testnet:price:testnet:XLM/USDC`.

**The entire warm-cache path is dead.** Every `/price` request is a cold miss doing eight Postgres queries plus a Horizon round-trip, and `X-Cache` only ever reports `HIT` from a previous request's own write. The double prefix is a latent bug in itself: the outer segment is the *process* network, the inner one the *request* network.

### Acceptance criteria
- [ ] One place owns the cache key — either the helpers take `(network, pairKey)`, or callers pass the full key and `redis.ts` stops prefixing; not both
- [ ] A test spying on `redis.set`/`redis.get` proves the worker and the route produce an identical key
- [ ] A test shows a worker-written entry served as `X-Cache: HIT`
- [ ] Keys for the two networks still differ

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L060 · Add a `network` label to the ingest metrics

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:easy

### Background
Every ingest metric in `src/metrics.ts` is network-blind: `trades_ingested_total{pair}`, `amm_snapshots_total{pool}`, `price_snapshots_total`, and worst, the **gauge** `last_trade_timestamp{pair}` (lines 42-47).

Since one ingester set runs per enabled network, the testnet loop's `last_trade_timestamp.set({pair}, …)` at `src/ingesters/sdex.ts:68` overwrites the mainnet loop's value for the same pair. The only staleness signal Lens exports is therefore unusable on a dual-network deployment — and `docs/http-metrics.md` proposes alerting on it. The HTTP metrics were done carefully with bounded cardinality; the ingest ones predate that.

### Acceptance criteria
- [ ] `network` added to the label set on all four metrics
- [ ] Every `.inc()` / `.set()` call site passes it
- [ ] A test asserts two networks produce two distinct series for the same pair, not one overwritten one
- [ ] The metrics documentation is updated
- [ ] The PR notes cardinality: pairs × networks stays small, and issuer or pool must not be added here

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L061 · `/prices/history` ignores `?network=`

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
`src/api/history.ts:46` passes the module-level `activeNetwork` constant as the bind for `WHERE … network = $5`. The handler at line 69 never touches `req.network`, even though the selector validated and attached it before the handler ran.

So `GET /prices/history?pair=XLM/USDC&network=mainnet` against a testnet-default instance returns testnet snapshots with no indication. The endpoint is x402-gated, so this is a paid wrong answer.

This is distinct from #157: that issue is about a *missing* predicate, this one has the predicate and binds the wrong value.

### Acceptance criteria
- [ ] `queryHistory` takes `network` as a parameter instead of closing over `activeNetwork`
- [ ] The route passes `req.network`, and the response echoes the resolved network
- [ ] A test asserts `?network=mainnet` and `?network=testnet` return different rows from the same table
- [ ] The existing interval and max-points guards are left intact

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L062 · Snapshot retention only prunes one network

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background
`src/jobs/snapshotRetention.ts:26-30` deletes `WHERE network = $1` binding `activeNetwork`. On a dual-network process the second network's `price_snapshots` are **never pruned** and grow at one row per pair per minute, forever. `QUEUE_NAME` at line 5 is likewise pinned to `activeNetwork`, so even the scheduling is single-network.

The comment at `src/index.ts:202-210` is explicit that losing retention is "silent, and the bill arrives as a full disk weeks later". That is exactly what is happening, just for the other chain.

### Acceptance criteria
- [ ] Pruning covers every network in `getEnabledNetworks()`, or takes `network` and is invoked once per enabled network
- [ ] The returned and logged count is per network
- [ ] A test with rows on both networks asserts both are pruned — fails before
- [ ] The in-process fallback timer covers both networks too

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L063 · `CONTRIBUTING.md` describes a repo that no longer exists

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background
A contributor's first twenty minutes go into documents that are wrong. `CONTRIBUTING.md` says the API runs on port 3000 (it is 3002, `src/config.ts:225`); its layout tree lists `src/ingest/` for ingesters (they are in `src/ingesters/`), `src/pricing/` as "best-route calculation" (that is `src/aggregator/`), and a top-level `sql/` directory **that does not exist**; it documents the env var `NETWORK` (the real one is `STELLAR_NETWORK`); and under Testing it says "Tests are being set up" next to 401 passing tests.

Separately `docs/DUAL_NETWORK.md` still asserts the schema has "no `network` column" and that "today's defaults are incoherent" — both fixed by the merged #113 and #114.

### Acceptance criteria
- [ ] Port, directory tree, env var names and the Testing section all match `main`
- [ ] The two stale paragraphs in `docs/DUAL_NETWORK.md` are rewritten, and the issue table marks #113–#120 done
- [ ] The dual-network note in `README.md` is checked against reality and corrected
- [ ] Every command in CONTRIBUTING's "before opening a PR" block is run once from a clean clone and confirmed
- [ ] No new docs files — fix the existing ones

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L064 · Reject non-numeric `window` before it reaches Postgres

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
`src/routes/price.ts:23` does `parseInt(req.query.window ?? '60', 10)` and then validates with `if (windowMinutes < 1 || windowMinutes > 1440)` at line 27. For `?window=abc` the parse yields `NaN`, and **both comparisons against `NaN` are false**, so validation passes. The value flows into `src/pricing/twap.ts:110` as `($2 || ' minutes')::interval`, Postgres fails to parse `"NaN minutes"`, and the caller gets a 500 carrying a raw driver message instead of a 400.

The same hole exists for `sampleInterval` and for `window` on the VWAP route. Both routes are also missing from the README table and `openapi.yaml`, despite being x402-gated.

### Acceptance criteria
- [ ] Non-numeric input is rejected with 400 on all three parameters — `zod` is already a dependency
- [ ] `method` is validated against its allowed values rather than passed through untyped
- [ ] Tests for `?window=abc`, `?window=0`, `?window=99999`, `?sampleInterval=abc`, `?method=bogus` — all 400, none reaching the database
- [ ] Both routes added to the README endpoint table

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L065 · TWAP outlier rejection pairs prices with the wrong timestamps

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate

### Background
`src/pricing/twap.ts:131-133` filters prices with `rejectOutliersIQR`, which returns a **compacted** array. Lines 168-174 then rebuild the series as `rows.map((r, i) => ({ ts: r.timestamp, price: validPrices[i] }))`.

So whenever any outlier is rejected, price *i* is attached to row *i*'s timestamp even though the arrays no longer correspond, and the trailing rows are dropped instead of the rejected ones. The result is a TWAP over a scrambled series weighted by the wrong instants — the exact opposite of the manipulation-resistance the module's docstring claims.

The fix already exists in the same file: `computeVWAP` at line 270 uses `rejectOutliersWithIndices`, which returns a `Set<number>` of original indices and stays aligned.

### Acceptance criteria
- [ ] `computeTWAP` uses the index-returning rejector so `(timestamp, price)` pairing survives rejection
- [ ] A test with a known series containing one spike asserts surviving points keep their original timestamps and the TWAP equals a hand-computed value — fails before
- [ ] `outlierRejected` still reports the true count
- [ ] The now-redundant rejectors are deleted or expressed in terms of the index-returning pair, so the two cannot drift again
- [ ] `computeVWAP` behaviour is unchanged

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L066 · Unit-test `src/aggregator/vwap.ts`, the module every `/price` answer comes from

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate

### Background
`src/aggregator/vwap.ts` is imported by **no test file**, and it is the module behind `/price/:a/:b`, the GraphQL `getPrice` resolver and the aggregate-refresh worker.

Untested branches with real consequences: the fallback chain `vwap1h || vwap24h || ammPrice || 0` at line 164 silently substitutes a 24-hour average when the last hour is empty; the `confidence` ladder at lines 150-159 hardcodes 30s / 300s thresholds; `stale` at line 161 duplicates the 300s constant; and `sources` at lines 135-140 counts `DISTINCT COALESCE(pool_id, 'sdex')`, so every SDEX trade collapses to one "source" regardless of counterparty.

### Acceptance criteria
- [ ] A test file covering `calculateVWAP` (with and without the source filter), `calculateOHLCV`, `getPriceChange24h` and `getAggregatedPrice`, mocking `pgPool.query` in the style of `src/__tests__/spreads.test.ts`
- [ ] Every `confidence` outcome asserted at its boundary, including the null-age case
- [ ] `stale` asserted at exactly 299 and 300 seconds
- [ ] The `vwap1h || vwap24h || ammPrice` fallback asserted explicitly, so changing it requires changing a test
- [ ] The 30s and 300s thresholds become named exported constants that the tests import

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L067 · `/basket` averages prices quoted in different currencies

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate

### Background
`src/routes/basket.ts:4-16`'s `fetchAssetVWAP(asset)` runs `WHERE (asset_a = $1 OR asset_b = $1)` over `price_points` and volume-weights every matching row into one number. But `price` in that table is denominated in whatever the *other* leg was: `src/ingesters/sdex.ts:41-43` stores XLM/USDC as USDC-per-XLM and XLM/EURC as EURC-per-XLM. Averaging them produces a figure in no currency at all.

Two more problems in the same six lines: `asset_a`/`asset_b` store only the *code*, so every issuer's "USDC" is conflated — the exact failure `src/api/rest.ts:24-37` documents and guards against for `/price` — and the row's price is inverted for half the pairs depending on which side the asset sits on.

Adding a `network` predicate (#157) does not touch any of this.

### Acceptance criteria
- [ ] `/basket` takes an explicit quote asset, or restricts to pairs sharing one, and documents which
- [ ] Prices are inverted when the requested asset is the counter side, so all components share a unit and a direction
- [ ] Asset matching honours a supplied issuer, reusing the `findPair` semantics rather than matching on bare code
- [ ] An asset with no price in the chosen quote returns 404 naming it, rather than a silently mixed number
- [ ] A test with two pairs sharing a base but different quotes asserts they are no longer pooled — fails before

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L068 · `ratePerDay` is stored, returned, advertised — and never enforced

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background
The per-key daily quota exists everywhere except where it would do something. It is a column with a default of 10000, settable via `POST /admin/keys` (`src/api/admin.ts:59,71`), returned in the admin response, settable from `scripts/issue-api-key.ts`, and loaded into the request context (`src/api/auth.ts:14,51`).

Then the rate limiter at `src/index.ts:115-118` reads only `req.apiKey?.ratePerMin` with `timeWindow: '1 minute'`. Nothing in `src/` references `ratePerDay` for enforcement. A key issued with `--per-day 100` gets 60/minute, about 86,400 a day.

### Acceptance criteria
- [ ] A daily counter is enforced per API key and survives a process restart
- [ ] Exceeding it returns 429 with a `retryAfter` pointing at the next day boundary, matching the existing error shape
- [ ] The per-minute limit keeps working unchanged
- [ ] Tests: under limit passes, over limit 429s, counter resets at the boundary
- [ ] Redis being unavailable does not silently disable the quota — decide fail-open or fail-closed and document it

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L069 · `openapi.yaml` documents 7 of about 25 live routes

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background
`openapi.yaml` declares seven paths. The server registers roughly twenty-five, including `/basket`, `/volumes/:asset`, `/spreads/:asset`, `/compare/:asset`, `/screener`, `/benchmark`, `/prices/history`, the depth and TWAP/VWAP routes, `/webhooks`, `/usage/me`, `/admin/keys*`, `/discovery/resources`, `/verify`, `/supported`, `/settle`, `/metrics` and `/graphql`. The README table is barely better at eight.

The spec is auto-published to GitHub Pages on every push, so Lens ships a public contract that omits two thirds of its surface, and nothing stops the gap widening.

### Acceptance criteria
- [ ] A test boots the app, enumerates registered routes, and asserts every non-internal path has an `openapi.yaml` entry — fails before the spec is filled in
- [ ] The missing public data routes are documented with parameters, the shared `?network=` query param, and a response schema
- [ ] Internal routes are handled by an explicit, commented allow-list rather than being silently ignored
- [ ] The generator regenerates deterministically and the committed JSON matches
- [ ] The README endpoint table is brought in line in the same PR

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L070 · Make the price aggregator network-aware — `/price` still blends two chains

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:advanced

### Background
This is the largest remaining hole in the dual-network work, and `README.md` admits it in prose rather than in an issue: DB-backed reads are "still served from whichever network this instance is currently indexing".

**All eight queries in `src/aggregator/vwap.ts`** read `price_points` / `pool_snapshots` with no `network` predicate, as does `getAMMPrice` in `src/aggregator/bestRoute.ts:17-27`. `src/api/rest.ts:107-110` calls `getAggregatedPrice(pair.pairKey)` with no network at all and then stamps `network` onto the response at line 116 — a confidently mislabelled number.

The refresh worker compounds it: `src/jobs/aggregateRefresh.ts:8,63,65` pin the queue name and every `price_aggregates` upsert to `activeNetwork`, so the second enabled network never gets aggregates written and `/price/*/history` and `/screener` are permanently empty for it.

Explicitly outside the scope of #157, which covers `/volumes` and names only `/screener`, `/benchmark` and `/basket` as route-level follow-ups.

### Acceptance criteria
- [ ] Every function in `src/aggregator/vwap.ts` takes `network` as a required argument and filters on it; the stale comments claiming the tables have no network column are removed
- [ ] `getAMMPrice` filters `pool_snapshots` and its `pool_id` subquery by network
- [ ] `/price/:a/:b` passes `req.network` end to end, and the `network` field in the response is the one the numbers came from
- [ ] `aggregateRefresh` runs per enabled network — queue name, pair source and upsert all carry the job's network
- [ ] A test seeding the same `pairKey` on both networks with different prices asserts the two return different VWAPs — fails before
- [ ] The dual-network caveat in `README.md` is deleted, because it is no longer true

**Best done after L066**, so the refactor has a test safety net.

> **Drips Wave** · Complexity: **Advanced** · **200 points**

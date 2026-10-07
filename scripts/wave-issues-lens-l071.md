# Lens wave batch — query cost, network blindness, and a wrong number (DRAFT)

**Repo:** `Miracle656/Lens`. **IDs:** L071–L076. **Points:** Easy 100 · Intermediate 150 · Advanced 200.

## Shared with every issue

Lens aggregates SDEX trades and AMM pool prices into VWAP, OHLCV and best-route data. Node/TypeScript, TimescaleDB, deployed on Render. Tests are **vitest**.

The repo is in better shape than most — clean typecheck, 400 passing tests, OpenAPI publishing, Prometheus metrics. Its recurring weakness is a seam: everything written since the dual-network work is network-aware, and almost everything written before it silently pools testnet and mainnet. Two issues below are on that seam.

### Ground rules

- Every PR needs a test that fails before the change and passes after, unless the issue says otherwise.
- **A price with the wrong units, the wrong network or the wrong timestamp is worse than no price.** Prefer refusing to answer over answering confidently.
- **Validate every hard-coded `C…`/`G…`** with `StrKey.isValidContract` / `isValidEd25519PublicKey`. A length or shape check is not validation.
- Do not widen a Prometheus label to something unbounded. Pairs and networks are fine; issuers and pool ids are not.
- Never log or render an RPC URL — provider keys live in the URL path.
- Fork PRs run no CI here, so a green or absent check is not evidence. Verify locally and say what you ran.

### Two open issues are misleading, so do not be misled

**#146** ("broken `@stellar/stellar-sdk` vitest mock") **does not reproduce** — it was fixed in `041c2fc`/`7e2716a` and the issue is now closed. **#151** (flaky suite) **is real**, reproduced with rotating victims; the root cause nobody has fixed is that `src/config.ts:245-253` memoises each `NetworkConfig` in a module-level `Map`, and restoring `process.env` does not invalidate it — only `vi.resetModules()` does.

---

### L071 · `/screener` reports liquidity twice, and calls one of them market cap

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate

### Background
`src/routes/screener.ts:149-150`:

```sql
COALESCE(pl.liquidity::float, 0) AS liquidity,
COALESCE(pl.liquidity::float, 0) AS market_cap
```

The same value under two names. `market_cap` is a documented, sortable and filterable field (`screener.ts:29,46`), so sorting by market cap sorts by liquidity and filtering by market cap filters liquidity. A caller asking "show me pairs above $1M market cap" gets an answer that is confidently wrong, and nothing in the response says so.

### What to build
- Either compute market cap properly — which needs circulating supply per asset, and that may not be available, in which case say so — or **remove the field entirely** from the response, the sort allowlist and the filter set.
- Removing it is the honest default. A missing field is a question a caller can answer elsewhere; a wrong one is a decision they make badly.
- The route is also untested and has no network predicate on any of its three CTEs. Add the tests; note the network gap or fix it, but do not leave it silent.

### Acceptance criteria
- [ ] No response field carries a value that is not what its name says
- [ ] If `market_cap` is removed, it is gone from the response, the sort allowlist, the filter set, the README and `openapi.yaml` together
- [ ] `/screener` gains test coverage, including a sort and a filter
- [ ] The PR states what happened to the network predicate

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L072 · `/pairs` and `/pools` scan the whole history on every request

**Labels:** help wanted, Stellar Wave, area:api, difficulty:advanced

### Background
`src/routes/pairs.ts:11-15` is `SELECT DISTINCT ON (pair_key) … FROM price_points ORDER BY pair_key, timestamp DESC` with **no `WHERE` clause at all** — every request scans the entire price history of every network. `src/api/rest.ts:196-201` does the same over `pool_snapshots`.

These are the two endpoints most likely to be polled by a dashboard, and they get slower every minute the ingester runs. Right now that is invisible; it is the first thing that will fall over at scale, and it will fall over during traffic rather than in testing.

### What to build
- Bound the scan by time — the latest point per pair within a recent window — and filter by network.
- Add the supporting index and show the plan before and after. `EXPLAIN (ANALYZE, BUFFERS)` output in the PR is the deliverable that proves this worked.
- Decide what happens to a pair that has gone quiet for longer than the window: dropped, or surfaced as stale. Either is defensible; silently vanishing is not.
- TimescaleDB may offer a better shape here than `DISTINCT ON` — a continuous aggregate or `last()` is worth evaluating, and say why you chose what you chose.

### Acceptance criteria
- [ ] Neither endpoint scans unbounded history; the query plan proves it
- [ ] Both filter by network
- [ ] A pair outside the window is handled deliberately, and the behaviour is documented
- [ ] Timings and query plans are in the PR, from a table seeded to a realistic size
- [ ] Response shape is unchanged for pairs inside the window

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L073 · Webhooks and the price trackers are network-blind

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate

### Background
Two related gaps on the dual-network seam:

`src/webhookDispatcher.ts:17` filters webhooks by the **process's** `activeNetwork`, regardless of which ingester fired the event. And the module-level `lastPrice` maps in `src/ingesters/sdex.ts:12`, `amm.ts:9` and `soroswap.ts:34` are keyed by `pairKey` alone — so a mainnet tick supplies the "previous price" for a testnet threshold crossing, and vice versa.

The result is a price-alert webhook that can fire on the wrong chain's movement. For an alerting feature that is the whole product.

### What to build
- Key the `lastPrice` maps by `(network, pairKey)`.
- Dispatch webhooks for the network the event came from, not the one the process was started with.
- Check the rest of the module-level state in those ingesters for the same shape — anything keyed by pair alone is suspect.

### Acceptance criteria
- [ ] A tick on one network never supplies the previous price for the other
- [ ] A webhook fires for the network whose event triggered it
- [ ] A test drives both networks through the same pair and asserts the alerts do not cross
- [ ] No remaining module-level price state is keyed by `pairKey` alone

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L074 · `npm run seed` and fixtures, so a clone is usable

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background
A fresh clone plus `docker compose up` gives an empty database, so every price endpoint returns zeros. A contributor cannot tell working code from broken code, and the first hour goes into deciding which it is.

### What to build
- `npm run seed` writing deterministic `price_points`, `pool_snapshots` and `price_aggregates` for the default pair, across both networks.
- Idempotent — running it twice does not duplicate.
- A "seed and query" step in the README whose sample output is real, copied from an actual run.

### Acceptance criteria
- [ ] After seeding, `/price`, `/pairs` and `/pools` all return non-empty, sensible data
- [ ] Rows are tagged by network and the seed accepts a network flag
- [ ] Running it twice is a no-op
- [ ] The README's sample output matches what the command actually prints

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L075 · x402 gating matches on a raw URL prefix

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy

### Background
`src/middleware/x402.ts:33-37` decides whether a route is paid with `req.url.startsWith(prefix)` against the **full URL including the query string**. So `/pricing` and `/poolsize` match the `/price` prefix and become paid routes, and the match set is order-dependent.

Getting this wrong in either direction is bad: a free route that starts charging, or a paid route that stops.

### What to build
- Match on the routed path, at a path-segment boundary, never on the raw URL.
- Make the paid set explicit and ordered deliberately rather than by accident.
- A test table of paths that must and must not be gated, including the near-misses above.

### Acceptance criteria
- [ ] `/pricing` and `/poolsize` are not gated; `/price/...` is
- [ ] A query string cannot change whether a route is gated
- [ ] The paid set is declared in one place
- [ ] Tests cover every entry plus at least three near-misses

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L076 · A drift guard for `.env.example`

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:easy

### Background
`.env.example` has fallen behind the code. `DIRECT_DATABASE_URL` (read at `src/index.ts:5` and by the Prisma datasource), `RATE_LIMIT_IP_MAX` (`index.ts:114`), `ORACLE_PAYMENT_ADDRESS_{TESTNET,MAINNET}` and `REFLECTOR_CONTRACT_ID` are all missing.

Issue #25 ("document all environment variables") is closed, so re-documenting by hand just restarts the same decay. The useful version of this issue is the guard, not the list.

### What to build
- A test that scans the source for `process.env.X` reads and asserts each one appears in `.env.example`.
- An explicit, commented allow-list for variables that are deliberately undocumented — CI-only, platform-injected — so the test stays honest rather than being weakened when it first fails.
- Fix today's gaps as the first thing the new test catches.

### Acceptance criteria
- [ ] A new `process.env` read with no `.env.example` entry fails the test
- [ ] Today's four missing variables are added, with a comment saying what each is for
- [ ] The allow-list is explicit, and each entry says why
- [ ] It runs offline with no network access

> **Drips Wave** · Complexity: **Easy** · **100 points**

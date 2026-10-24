# Wave batch — Lens market analytics (L137–L161)

Drafted 2026-10-16. Lens answers "what is this worth" well. It cannot answer
any of the questions that follow: how deep is the market, what does it cost to
trade size, where is the yield, what is the ecosystem actually worth, and which
pegs are holding. Those are the numbers every Stellar dashboard, fund report
and ecosystem post needs, and nobody publishes them from a source that sees
every venue at once.

Each issue here is a question somebody has asked about Stellar and could not
answer. Scoped so they can be taken in parallel — mostly one route, one module,
one test file each.

## Shared with every issue

**Repo:** `Divinity-Labs/Lens`. Node + Fastify + Prisma + Postgres. Tests are **vitest** (`npm test`), not jest — jest against this repo fails every file and tells you nothing.

**`?network=` is not optional on a new route.** Every row carries a network and the indexes lead with it. Read `req.network ?? activeNetwork`, filter on it, echo it in the response, and declare the parameter in `openapi.yaml`. `tests/openapi.test.ts` boots the server and fails if a registered route is missing from the spec.

**A number without provenance is not an answer.** Every figure this batch adds must carry what it was computed from: which venues, how many samples, how fresh. The point of Lens is that its numbers can be checked.

**Never elide a contract id or an issuer.** Take addresses from the protocol's own documentation and write them whole. A sibling repo's issue wrote `CD2W5LUR…XZ4L` and five contributors invented plausible contract ids to fill the gap.

**Say when you cannot answer.** An asset with no liquidity, a pair with one venue, a window with a gap — each has an honest answer that is not zero and not a 500. Zero is a number people act on.

---

### L137 · There is no order-book depth, only a single execution price

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
`/price/:assetA/:assetB/depth` simulates one trade of one size and returns its slippage. `src/pricing/depth.ts` already builds `asks` and `bids` arrays internally. What no route exposes is the book itself — the ladder of price against cumulative size that anyone sizing a position actually needs.

### What to build
- `GET /book/:assetA/:assetB` returning aggregated levels across every venue, each level naming the venues contributing to it.
- AMM reserves become synthetic levels at a configurable step; order-book levels come through as they are. Both are labelled, because they behave differently under size.
- A `depth` parameter bounding how far from spot to walk.

### Acceptance criteria
- [ ] Aggregated levels with cumulative size, per side
- [ ] Every level names its venues and whether it is synthetic
- [ ] `?network=` honoured and declared
- [ ] A test covers a pair quoted by an AMM and an order book together

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L138 · Nobody can ask what it costs to trade a given size

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
The depth endpoint takes one amount. The question traders and treasuries actually ask is the shape: what does 100, 1,000, 10,000 cost me, and where does it stop being worth it.

### What to build
- `GET /impact/:assetA/:assetB` returning slippage at a ladder of sizes, in one call.
- The ladder adapts to the pair's liquidity rather than being fixed, so a thin pair is not described entirely in sizes it cannot fill.
- Name the size at which slippage crosses configurable thresholds — that single number is what most callers want.

### Acceptance criteria
- [ ] Slippage at a ladder of sizes in one response
- [ ] The ladder adapts to available liquidity
- [ ] Threshold crossings are reported explicitly
- [ ] A pair too thin for the smallest size says so rather than returning 100%

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L139 · `liquidity` is a column with no definition

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:easy, epic:data-quality

### Background
`src/routes/screener.ts` sorts and filters on `liquidity` and nothing documents what it is. The same file already carries a scar from this: `market_cap` was once a copy of `liquidity` and the route now refuses it with an explanation. The remaining field has the same problem one step removed — a caller filtering `liquidity >= 1000` has no idea what they asked for.

### What to build
- Define it, in the docs and in the spec: which reserves, valued in what, at which price, summed over which venues.
- If the stored value does not match the definition, fix the value, not the definition.
- Name the unit in the response.

### Acceptance criteria
- [ ] `liquidity` is defined in the spec with its unit and its sources
- [ ] The stored value matches the definition, with a test
- [ ] The response names the unit
- [ ] Any change to the number is called out in the PR

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L140 · No endpoint answers what Stellar DeFi is worth

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
Total value locked is the first number in every ecosystem report, and Stellar's is quoted by aggregators that cannot see Soroswap, Aquarius and the classic AMM together. Lens can, which makes this the single most citable thing it could publish.

### What to build
- `GET /tvl` — total, by venue, by asset, with the price source used for each valuation named.
- A pool holding an asset Lens cannot price is reported as unpriced, never counted as zero.
- A historical series, so the number can be charted rather than only sampled.

### Acceptance criteria
- [ ] Total and per-venue TVL with valuation sources named
- [ ] Unpriceable pools reported as unpriced
- [ ] A historical series is queryable
- [ ] `?network=` honoured and declared

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L141 · Pool yield is not computed anywhere

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
An AMM pool earns its providers fees proportional to volume against reserves. Lens already stores both. Nothing multiplies them, so "what does providing liquidity on Stellar pay" has no public answer.

### What to build
- Fee APR per pool from realised volume over a window and the pool's own fee rate, annualised, with the window stated.
- `GET /yield` listing pools by APR, with volume, reserves and fee rate shown so the figure can be checked.
- An APR from a window with gaps is marked as covering an incomplete period.

### Acceptance criteria
- [ ] Fee APR per pool, with the inputs visible in the response
- [ ] Windows of 24h, 7d and 30d
- [ ] An incomplete window is marked, never silently annualised
- [ ] A test pins the annualisation arithmetic

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L142 · Impermanent loss is invisible

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:advanced, epic:analytics

### Background
Fee APR alone is a half-truth that has cost liquidity providers real money across every chain. A pool paying 40% while its pair diverges 30% is a loss presented as a yield, and Lens holds the price history needed to say so.

### What to build
- Divergence loss per pool over a window, computed from the price history already stored.
- Reported beside the fee APR from L141, never separately — the two numbers are only meaningful together.
- A net figure, clearly labelled as an estimate with its assumptions stated.

### Acceptance criteria
- [ ] Divergence loss per pool over a window, from stored history
- [ ] Always returned alongside fee APR, never alone
- [ ] Assumptions stated in the response and the docs
- [ ] A test against a hand-computed two-point example

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L143 · Stablecoin pegs are checked one asset at a time

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:easy, epic:analytics

### Background
`/benchmark/:asset` reports peg deviation for one asset against a target. Stellar now carries several stablecoins and a growing set of tokenised real-world assets, and the question people ask is comparative: which pegs are holding today, and which are not.

### What to build
- `GET /pegs` — every asset Lens treats as pegged, its current deviation in basis points, and its worst deviation over the window.
- The peg target comes from configuration, not from a guess at the ticker.
- Assets not configured as pegged are absent rather than reported at zero deviation.

### Acceptance criteria
- [ ] All pegged assets in one response with current and worst deviation
- [ ] Targets are configured explicitly
- [ ] An unconfigured asset is absent, not zero
- [ ] `?network=` honoured and declared

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L144 · A depegging asset raises no alarm

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:analytics

### Background
`src/alerts/` already has threshold and arbitrage alerts and a dispatcher. A stablecoin leaving its peg is the single most consequential price event on any chain and there is no alert for it.

### What to build
- A peg-deviation alert through the existing alerts path, with a configurable band and a sustained-duration requirement so a single bad tick does not fire it.
- Recovery is an event too: say when it came back.

### Acceptance criteria
- [ ] Configurable band and sustained duration before firing
- [ ] Recovery raises its own event
- [ ] A single outlier tick does not fire, proven by a test
- [ ] Alerts carry the venues the deviation was observed on

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L145 · Nothing says which pairs are actually tradeable

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:analytics

### Background
`/pairs` lists what Lens watches. A watched pair with one stale venue and no volume for a week is not a market, and a wallet building an asset picker from this list will offer swaps that cannot fill.

### What to build
- A tradeable flag per pair, from recent volume, venue count and depth at a reference size.
- The criteria are configurable and stated in the response, so a caller can disagree with them.

### Acceptance criteria
- [ ] Each pair carries a tradeable flag and the reasons behind it
- [ ] Criteria are configurable and documented
- [ ] A pair failing on each criterion is covered by a test
- [ ] The flag is per network

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L146 · No route answers what an asset is worth in naira

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
Every price in Lens is quoted against another asset. The wallet consuming it serves users whose unit of account is naira, and it converts on its own, which means the conversion is unreviewable and inconsistent between clients.

### What to build
- `GET /price/:asset/fiat?currency=NGN` returning the asset's price in a fiat currency, naming the rate source and its age.
- Several currencies, from configuration, with the ones Lens cannot source refused explicitly.
- Never invent a cross rate without saying which two rates it was built from.

### Acceptance criteria
- [ ] Fiat-denominated prices with the rate source and its age named
- [ ] Unsupported currencies are refused with a list of supported ones
- [ ] A cross rate states both legs
- [ ] A stale fiat rate is marked, not silently used

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L147 · Arbitrage is detected and never quantified

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
`src/alerts/arbitrage.ts` fires when venues disagree. It says nothing about whether the gap is worth taking — and a spread smaller than the fees and slippage of closing it is not an opportunity, it is noise.

### What to build
- Net the gross spread against both legs' fees and the slippage at the size that would close it.
- Report the size at which the opportunity disappears.
- Alerts only on net-positive gaps, with the arithmetic in the payload.

### Acceptance criteria
- [ ] Gross and net spreads both reported
- [ ] The break-even size is computed
- [ ] Alerts fire on net, not gross
- [ ] A test covers a gross-positive, net-negative case

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L148 · There is no leaderboard of what is moving

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:analytics

### Background
`/screener` filters and sorts if you know what to ask for. The question a newcomer asks is open-ended: what is moving on Stellar today. That answer is one query away and nothing exposes it.

### What to build
- `GET /movers?window=24h` — biggest gainers, biggest losers, biggest volume change, each with the venues behind the move.
- A move seen on only one venue is labelled as such, because a single thin pool can print anything.

### Acceptance criteria
- [ ] Gainers, losers and volume movers in one response
- [ ] Single-venue moves are labelled
- [ ] Windows of 1h, 24h and 7d
- [ ] `?network=` honoured and declared

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L149 · Correlation between Stellar assets is uncomputed

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:analytics

### Background
Anyone holding a basket — and `/basket` exists, so Lens already expects them — needs to know what moves together. The price history is there; nothing correlates it.

### What to build
- `GET /correlation?assets=…` returning a matrix over a window, with the sample count per pair.
- A pair with too few overlapping samples is reported as insufficient rather than given a meaningless coefficient.

### Acceptance criteria
- [ ] A correlation matrix over a configurable window
- [ ] Sample count per pair in the response
- [ ] Insufficient overlap is reported, not computed
- [ ] A test against a hand-computed example

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L150 · Volatility has no endpoint

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:easy, epic:analytics

### Background
Volatility decides position sizing, slippage tolerance and whether a price is worth trusting. Lens stores everything needed and computes none of it.

### What to build
- Realised volatility per pair over configurable windows, annualised, with the method named.
- Returned alongside the sample count, because volatility from eleven samples is not a measurement.

### Acceptance criteria
- [ ] Realised volatility per pair with the method stated
- [ ] Sample count always returned
- [ ] Too few samples refuses rather than reports
- [ ] A test against a hand-computed series

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L151 · The best route ignores multi-hop paths

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:advanced, epic:routing

### Background
`src/aggregator/bestRoute.ts` compares venues for a direct pair. Stellar's native path payments route through intermediate assets, and for thin pairs the two-hop route through XLM or USDC is routinely better than anything direct. Lens recommends the worse trade and says it is best.

### What to build
- Multi-hop routing through a configurable set of intermediate assets, bounded in depth.
- The response shows each hop, its venue and its slippage, so the recommendation can be checked.
- A direct route still wins when it is better, and the comparison is shown.

### Acceptance criteria
- [ ] Routes of at least two hops are considered
- [ ] Every hop is named with its venue and slippage
- [ ] Hop depth and intermediates are configurable
- [ ] A test covers a thin pair where two hops beat direct

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L152 · Route recommendations are not split across venues

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:advanced, epic:routing

### Background
Best route picks one venue. For any size large enough to matter, splitting across venues beats routing all of it to the deepest one — which is the entire reason aggregators exist.

### What to build
- A split recommendation: proportions per venue that minimise total slippage for a given size.
- Returned only when splitting actually wins, with the single-venue alternative shown for comparison.

### Acceptance criteria
- [ ] Split proportions per venue for a given size
- [ ] Only returned when it beats the single-venue route
- [ ] The comparison is in the response
- [ ] A test covers a size where splitting wins and one where it does not

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L153 · Nothing records whether a recommendation was any good

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:data-quality

### Background
Lens recommends routes and predicts slippage. It never looks at what the chain did afterwards, so there is no evidence the predictions are accurate — and no way to notice when they stop being.

### What to build
- Sample executed trades for pairs Lens quoted and compare realised price against the prediction.
- A periodic accuracy report per venue and pair.
- Expose it, because publishing your own error bars is the most credible thing a price API can do.

### Acceptance criteria
- [ ] Predictions are stored and compared against realised trades
- [ ] Accuracy is reported per venue and pair
- [ ] The report is queryable through the API
- [ ] A test covers a predicted and a realised trade

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L154 · Fees are assumed, not read

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:data-quality

### Background
Slippage and execution arithmetic take a fee in basis points. `src/pricing/depth.ts` accepts `feeBp` as a parameter and the callers supply a constant. A pool whose fee differs — and protocols vary theirs per pool — is priced wrongly, consistently, in a direction nobody notices.

### What to build
- Read each pool's own fee from the venue, cache it, and use it everywhere a fee is needed.
- A pool whose fee cannot be read is excluded from execution estimates rather than estimated with a guess.

### Acceptance criteria
- [ ] Per-pool fees are read, not assumed
- [ ] Cached, with the cache tested
- [ ] A pool with an unknown fee is excluded and says so
- [ ] No fee constant remains in the pricing path

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L155 · There is no snapshot anyone can cite

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:analytics

### Background
Ecosystem reports, grant applications and dashboards all need the same thing: one object describing the state of Stellar markets at a moment, with a timestamp, that can be referenced later. Assembling it today means five calls and no guarantee they describe the same instant.

### What to build
- `GET /snapshot` — venues, TVL, 24h volume, top pairs, peg status and freshness, as one timestamped object.
- Assembled from one consistent read, so every figure in it describes the same moment.
- Cacheable and cheap, because this is the one people will poll.

### Acceptance criteria
- [ ] One object covering venues, TVL, volume, top pairs and pegs
- [ ] A single timestamp that every figure in it honours
- [ ] Cacheable, with the policy documented
- [ ] `?network=` honoured and declared

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L156 · Historical snapshots cannot be compared

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:analytics

### Background
With L155 giving a snapshot of now, the obvious next question is what changed since last month, and there is no way to ask it.

### What to build
- Persist snapshots on a schedule with their own retention.
- `GET /snapshot?at=…` for a past moment, and a diff between two.
- Say plainly when a requested moment falls in a gap.

### Acceptance criteria
- [ ] Snapshots persisted on a schedule with documented retention
- [ ] A past snapshot is retrievable by time
- [ ] A diff between two moments is available
- [ ] A gap is reported rather than interpolated

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L157 · Asset metadata is absent, so every client fetches its own

**Labels:** help wanted, Stellar Wave, area:api, difficulty:easy, epic:dx

### Background
A client showing a price also needs the asset's name, domain and decimals. Lens returns codes and issuers, so every consumer separately fetches `stellar.toml` files — and the sibling wallet had to proxy those server-side because its content-security policy blocked the reads.

### What to build
- `GET /assets` and `GET /assets/:code` with name, issuer, home domain, decimals and verification status.
- Verification means the issuer's own `stellar.toml` lists the asset, checked rather than assumed, with the check's date in the response.
- An issuer serving no toml is reported as unverified, which is a real state and not an error.

### Acceptance criteria
- [ ] Asset metadata with verification status and the date checked
- [ ] An absent toml yields unverified, not a failure
- [ ] Results are cached with a documented TTL
- [ ] No issuer address in the response is elided

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L158 · Volume is reported, concentration is not

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:easy, epic:analytics

### Background
A pair whose day was one large trade is not a liquid market, and a pair with a thousand small trades is. Both report the same volume, and `/volumes` cannot tell them apart.

### What to build
- Trade count, median size and the share of volume from the largest trade, alongside volume.
- A concentration figure, so a caller can filter on it.

### Acceptance criteria
- [ ] Trade count, median size and top-trade share beside volume
- [ ] A documented concentration measure
- [ ] A test covers one-large-trade and many-small-trades with equal volume
- [ ] `?network=` honoured

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L159 · Nothing reports how much of the market Lens can see

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:data-quality

### Background
Lens claims to unify Stellar pricing. The honest version of that claim is a number: of the trading activity on the network, what share passes through venues Lens indexes. Nobody can state it, including us.

### What to build
- Compare indexed volume against total network activity from Horizon over a window.
- Publish the coverage ratio per asset and overall, with the method documented.
- Report it even when it is unflattering — a coverage figure that only appears when high is worthless.

### Acceptance criteria
- [ ] A coverage ratio, overall and per asset
- [ ] The method is documented and reproducible
- [ ] It is published regardless of value
- [ ] A test pins the ratio arithmetic

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L160 · The oracle comparison has no history

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:easy, epic:oracles

### Background
`/compare/:asset` reports how far Lens is from an oracle right now. Right now is the least interesting version of that question: a feed that was wrong for six hours yesterday looks perfect today.

### What to build
- Persist each comparison and expose the series.
- Summary statistics per oracle over a window: mean deviation, worst, and time spent outside a band.

### Acceptance criteria
- [ ] Comparisons are persisted with retention
- [ ] A historical series is queryable
- [ ] Per-oracle summary statistics over a window
- [ ] A test covers an oracle that drifts and returns

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### L161 · No single page shows what Lens knows

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:docs

### Background
This batch adds a dozen analytical endpoints to a README that is already a twenty-five-row table. A developer cannot tell which question each answers, and the ones added here are exactly the ones that would attract someone who was not already looking for a price API.

### What to build
- A question-led index: the question in plain English, the route that answers it, one example.
- Generated from the spec where possible so it cannot drift.
- Ordered by what a newcomer asks first, not by URL.

### Acceptance criteria
- [ ] Every route appears under a plain-English question
- [ ] Generated from the spec where the data allows
- [ ] A test fails when a route exists with no question
- [ ] Ordered for a newcomer, with the reasoning stated

> **Drips Wave** · Complexity: **Easy** · **100 points**

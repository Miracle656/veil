# Wave batch — Lens data integrity (L097–L116)

Drafted 2026-10-15 by reading the schema against the queries that use it. Lens
stores prices as `Decimal(36, 18)` and then computes with them as IEEE-754
doubles in eighteen places; it writes to a table nothing ever prunes; and it has
no migration history at all. None of this is visible from the API, which is
exactly why it has survived.

## Shared with every issue

**Repo:** `Divinity-Labs/Lens`. Node + Fastify + Prisma + Postgres. Tests are **vitest** (`npm test`), not jest.

**The money table is `price_points`.** `prisma/schema.prisma` declares `price Decimal(36,18)`, `baseVolume` and `counterVolume` `Decimal(36,7)`, a composite primary key `(id, timestamp)` and two indexes on `(network, pairKey, …)`. Everything in this batch touches it or what reads it.

**`?network=` is not decoration.** Every row carries a `network` and the indexes lead with it. A query without a network predicate reads both chains and the planner cannot use the index properly either, so it is both wrong and slow.

**Never elide a contract id or an issuer.** Take addresses from the protocol's own documentation and write them whole. A sibling repo's issue wrote `CD2W5LUR…XZ4L` and five contributors invented contract ids to fill the gap.

**Prove it with a test that fails first.** Every issue here is a defect nothing currently detects. A PR that fixes one without a test that would have caught it has fixed it once.

---

### L097 · Prices are stored to 18 decimal places and computed as floats

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:advanced, epic:data-quality

### Background
`schema.prisma` declares `price Decimal(36, 18)`. Eighteen places in `src/` then cast it with `::float` — `src/routes/candles.ts` alone casts it five times, for open, high, low, close and volume. Postgres `float` is a 53-bit double: about 15 significant digits, with no exact representation of most decimal fractions.

For XLM/USDC the loss is below noise. For a pair quoted at 1e-7, or a volume summed over a day of ticks, it is not, and the error accumulates differently depending on row order — so the same window can produce two different closes. The precision was chosen deliberately in the schema and is thrown away at the point of use.

### What to build
- Keep `numeric` through the aggregation and cast once, at the edge, where the value is serialised.
- Decide and document the serialised precision rather than inheriting whatever `float` produces.
- A test with values chosen to differ between `numeric` and `float` arithmetic, asserting the exact expected output.

### Acceptance criteria
- [ ] No `::float` cast remains inside an aggregate expression
- [ ] Output precision is explicit and documented
- [ ] A test fails against the current code and passes after
- [ ] `/candles`, `/price/*/history` and `/volumes` all exercised

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L098 · `price_points` is never pruned

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:advanced, epic:performance

### Background
`src/jobs/snapshotRetention.ts` prunes `price_snapshots` and nothing else. `price_points` — the table every ingester writes to on every tick, for every pair, on every network — has no retention job, no partitioning and no archival. It grows without bound.

The venue batch now in flight adds several more writers to it. The shared Supabase instance is already near its tier limit, and the first symptom of running out will be writes failing across both Lens and its sibling service.

### What to build
- A retention policy for `price_points` with a configurable window, defaulting to something defensible and documented.
- Raw points older than the window must be rolled into an aggregate before deletion — the history is the product, and deleting it outright is not acceptable.
- Deletion in bounded batches with a pause between them, so it never holds a long lock.

### Acceptance criteria
- [ ] Raw points are rolled up before being pruned, with the rollup tested
- [ ] Retention window configurable; the default is documented with its reasoning
- [ ] Deletion is batched and yields; a test asserts the batch size is honoured
- [ ] Rows deleted and rolled up are exported as metrics

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L099 · The retention delete is a single unbounded statement

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:performance

### Background
`pruneOldSnapshots` issues one `DELETE FROM price_snapshots` for everything past the window. After an outage, or on first run against a table that has never been pruned, that is a single transaction over an unknown number of rows — a long lock, a large WAL burst, and a statement that may simply time out, in which case nothing is ever pruned and the problem compounds.

### What to build
- Delete in bounded batches with a configurable size, looping until done, yielding between batches.
- Report progress so a long run is visible rather than appearing hung.
- Make the job safe to run concurrently with itself — a second instance must not double-delete or deadlock.

### Acceptance criteria
- [ ] Batched deletion with a configurable limit
- [ ] A test asserts batching, including a run that needs several batches
- [ ] Concurrent invocation is safe
- [ ] Progress and totals are logged and exported

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L100 · There is no migration history, only `db push`

**Labels:** help wanted, Stellar Wave, area:ci, difficulty:advanced, epic:ci

### Background
`prisma/` contains `schema.prisma` and nothing else. There is no `migrations/` directory, so every schema change has been applied with `prisma db push`, which diffs the live database against the schema and applies whatever it decides.

That means no schema change is reviewable, no deploy is reproducible, and there is no way to roll one back. It has already caused an incident in the sibling service, where a push half-applied and left the database on a shape no commit describes. The schema in this batch needs new tables and new indexes, and doing that with `db push` compounds the problem.

### What to build
- Adopt `prisma migrate`. Generate a baseline migration matching the current production shape exactly, then commit it.
- CI must fail when `schema.prisma` and the migrations disagree.
- Document the deploy path so nobody reaches for `db push` again, and say why.

### Acceptance criteria
- [ ] A baseline migration reproduces the current schema exactly
- [ ] CI fails on drift between schema and migrations
- [ ] The deploy documentation uses `migrate deploy`, and `db push` is called out as unsafe
- [ ] A new migration can be generated, applied and rolled back in a clean database

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L101 · TWAP reads every network at once

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:network-awareness

### Background
`src/pricing/twap.ts` contains no reference to `network` at all, and neither does `src/routes/price.ts`, which registers `/price/twap/:assetA/:assetB`. So the time-weighted average price — the number specifically designed to be hard to manipulate — is computed across testnet and mainnet samples together.

That is worse than it sounds. Testnet prices are whatever a test script wrote, so a single testnet sample can move a mainnet TWAP arbitrarily, and the outlier rejection (`iqr`, `modified_zscore`) will discard genuine mainnet samples to accommodate it.

### What to build
- Read `req.network ?? activeNetwork` the way `src/api/rest.ts` does, thread it into `computeTWAP`, and filter on it.
- Echo the answered network in the response.
- Declare the `network` parameter and the response field in `openapi.yaml`.
- A test that seeds both networks at one `pairKey` and asserts the TWAP reflects only one.

### Acceptance criteria
- [ ] `/price/twap/*` filters on network and echoes it
- [ ] `openapi.yaml` declares the parameter; the coverage test passes
- [ ] A cross-network test fails before the fix
- [ ] Outlier rejection runs after the network filter, never before

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L102 · VWAP's route drops the network the aggregator supports

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:network-awareness

### Background
`src/aggregator/vwap.ts` references `network` thirty-three times — the aggregator is network-aware. `src/routes/price.ts`, which registers `/price/vwap/:assetA/:assetB`, references it zero times. The capability exists and the route never uses it, so the endpoint answers across both chains while the code underneath is perfectly able not to.

### What to build
- Thread the request's network through to the aggregator, which already takes it.
- Echo it, declare it in `openapi.yaml`, and cover it.
- Check the `source` filter interacts correctly: `?source=SDEX&network=mainnet` must mean both, not either.

### Acceptance criteria
- [ ] `/price/vwap/*` passes the request network to the aggregator
- [ ] `source` and `network` compose as a conjunction, with a test
- [ ] Spec updated and covered
- [ ] A cross-network test fails before the fix

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L103 · Window boundaries are inclusive at both ends

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:data-quality

### Background
`src/routes/candles.ts` filters `timestamp >= $3 AND timestamp <= $4`. Two adjacent windows requested back to back therefore both contain any sample landing exactly on the shared boundary. Summed volume across a series double-counts it, and a chart built by stitching windows shows a spike that is purely an artefact of how it was fetched.

### What to build
- Pick a convention — half-open `[from, to)` is the usual one — and apply it to every range query in the codebase, not just candles.
- Document it in `openapi.yaml` so callers know which end is exclusive.
- A test that fetches two adjacent windows and asserts each sample appears exactly once.

### Acceptance criteria
- [ ] One documented convention across every range query
- [ ] Adjacent windows never share a sample, proven by a test
- [ ] The convention is stated in the spec
- [ ] Existing callers' behaviour change is called out in the PR

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L104 · Nothing stops the same trade being written twice

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:advanced, epic:data-quality

### Background
`PricePoint` has `eventId String?` — optional, and not unique. An ingester that retries after a partial failure, or two instances briefly overlapping during a deploy, will write the same trade again. Nothing detects it, and a duplicated trade inflates volume and skews VWAP, which is weighted by exactly that volume.

### What to build
- A uniqueness constraint that makes a duplicate impossible rather than unlikely — on `(network, source, eventId)` where `eventId` exists.
- Decide what to do for sources with no natural event id, and document it; a synthesised id must be deterministic from the content, never random.
- Writes become idempotent upserts.

### Acceptance criteria
- [ ] A duplicate write is rejected or absorbed, never stored twice
- [ ] Sources without an event id have a documented, deterministic key
- [ ] A test replays the same batch twice and asserts the row count is unchanged
- [ ] The migration handles duplicates already in the table

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L105 · Outlier rejection exists only at read time

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:data-quality

### Background
`iqr` and `modified_zscore` are options on the TWAP and VWAP endpoints. Everything else — `/candles`, `/price`, `/screener`, the webhooks that fire on thresholds — reads the raw table. So a single bad tick from a thin pool reaches every consumer that does not happen to ask for outlier rejection, including the alerting path, where it fires a notification about a price that never existed.

### What to build
- A plausibility check at ingest: reject a point that deviates from the recent median of that pair by more than a configurable bound, and record the rejection rather than discarding it silently.
- Rejected points go to a quarantine table, so a genuine move is not lost and can be reviewed.
- A metric per source for accepted and rejected.

### Acceptance criteria
- [ ] Ingest-time plausibility check with a configurable bound
- [ ] Rejections are stored, not dropped, and are queryable
- [ ] Accept/reject counts exported per source
- [ ] A test drives a genuine 40% move and asserts it is quarantined, not silently lost

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L106 · Nothing reconciles two venues quoting the same pair

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:data-quality

### Background
Once several venues quote XLM/USDC, they will disagree — that is what arbitrage is. Lens aggregates them and never records how far apart they were, so there is no way to tell a healthy spread from one venue having gone stale or wrong.

### What to build
- A periodic reconciliation: for each pair, the dispersion across venues, and the venue furthest from the median.
- Persist it, so dispersion over time is queryable.
- Alert past a configurable dispersion, because a venue that has drifted is usually a venue that has broken.

### Acceptance criteria
- [ ] Per-pair dispersion computed and stored on a schedule
- [ ] The outlying venue is identified by name
- [ ] A configurable threshold raises an alert through the existing alerts path
- [ ] Tests cover agreement, one outlier, and a single-venue pair

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L107 · Timestamps mix chain time and wall clock

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:intermediate, epic:data-quality

### Background
`PricePoint` carries both `ledger` and `timestamp`. An SDEX trade has a ledger close time; an AMM reserve read has whatever time the reader happened to run; a CEX ticker has the exchange's own timestamp. All three land in the same column and are bucketed together, so a candle can contain samples whose times mean three different things.

### What to build
- Separate the observation time from the source's own time, with both stored, and document which is used for bucketing.
- Every adapter must state which it can provide; one that has no source time says so rather than silently supplying its own clock.
- Bucketing uses one of them, consistently.

### Acceptance criteria
- [ ] Observation time and source time are distinct columns
- [ ] Every adapter declares what it can supply
- [ ] Bucketing uses one, documented, consistently
- [ ] A test covers a source with no native timestamp

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L108 · There is no way to backfill

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:advanced, epic:operations

### Background
If an ingester is down for six hours, those six hours are simply missing. Nothing detects the gap and nothing can fill it, so every aggregate over that window is quietly wrong forever and no response says so.

### What to build
- Gap detection per source and pair: find the holes and record them.
- A backfill command that refetches a named range from a source that supports history, writing through the same idempotent path as live ingestion.
- A gap that cannot be filled — because the source has no history — is marked permanent, and any response covering it says the window is incomplete.

### Acceptance criteria
- [ ] Gaps are detected and recorded per source and pair
- [ ] A backfill command fills a named range idempotently
- [ ] Responses covering a known gap declare the window incomplete
- [ ] Tests cover detection, a successful fill and an unfillable gap

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L109 · `price_points` has no partitioning, though its key is built for it

**Labels:** help wanted, Stellar Wave, area:ingest, difficulty:advanced, epic:performance

### Background
The primary key is `(id, timestamp)` — a composite that only makes sense as preparation for partitioning by time, which was never done. The table instead grows as one heap, so retention means deleting rows rather than dropping a partition, every index covers the whole history, and a query for the last hour pays for three months of data it will not read.

### What to build
- Range partitioning on `timestamp`, with automatic creation of future partitions and dropping of expired ones.
- Migrate the existing table without losing rows and without a long outage; describe the cutover in the PR.
- Retention becomes a partition drop.

### Acceptance criteria
- [ ] `price_points` is partitioned by time, with partitions created ahead of need
- [ ] Retention drops partitions rather than deleting rows
- [ ] The migration preserves every row, proven by a count and a checksum
- [ ] A recent-window query's plan shows partition pruning

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L110 · A response never says how fresh it is

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:data-quality

### Background
Every pricing endpoint returns a number with no indication of when the underlying data was observed. A caller cannot tell a price from thirty seconds ago from one from an hour ago, and an ingester that died quietly keeps serving its last value indefinitely with full confidence.

### What to build
- Every pricing response carries the observation time of its newest input and the count of inputs used.
- A configurable staleness bound past which the response is explicitly marked stale rather than merely old.
- Declared in `openapi.yaml` on every affected route.

### Acceptance criteria
- [ ] Newest-input timestamp and input count on every pricing response
- [ ] A stale response is marked, with the bound configurable
- [ ] Spec updated for every route touched
- [ ] A test freezes time and asserts the transition to stale

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L111 · Volume is summed across venues that may be quoting the same trade

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:intermediate, epic:data-quality

### Background
`/volumes/:asset` adds up per-venue volume. An aggregator venue that routes through another venue reports the same underlying trade, and both reach Lens, so the total overstates real activity. Every ecosystem volume figure that has ever been wrong has been wrong for exactly this reason.

### What to build
- Mark each venue as a primary market or an aggregator in the venue registry.
- Totals report both figures — summed across primaries, and gross including aggregators — and label them.
- Document which venues are which, and why.

### Acceptance criteria
- [ ] Venues are classified in the registry
- [ ] Totals report net and gross separately, both labelled
- [ ] The classification is documented with reasoning
- [ ] A test covers a pair traded on a primary and an aggregator

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L112 · Nothing records which inputs produced a published price

**Labels:** help wanted, Stellar Wave, area:pricing, difficulty:advanced, epic:data-quality

### Background
When a Lens price is disputed — and once a contract reads it, it will be — there is no way to reconstruct it. The inputs are in `price_points`, but which of them the aggregate used, which were rejected and why, is not recorded anywhere.

### What to build
- An audit record per published aggregate: the inputs used, those rejected with the reason, the method and its parameters.
- Retrievable for a past timestamp, so a dispute can be settled.
- Bounded in size, since this is written on every aggregation.

### Acceptance criteria
- [ ] Each published aggregate has a retrievable audit record
- [ ] Rejected inputs appear with their reason
- [ ] An endpoint or command reconstructs a past price from its record
- [ ] Storage growth is bounded and documented

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### L113 · The seed script is the only fixture, and it is not a dataset

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate, epic:testing

### Background
`npm run seed` makes a clone usable, which is what it was for. It is not a dataset anyone can reason about: there is no known-good set of prices with known-correct answers, so every test that needs data invents its own and no two tests agree on what a correct VWAP is.

### What to build
- A fixture dataset with hand-computed expected outputs for VWAP, TWAP, OHLC and depth, documented so the expected values can be checked by hand.
- Tests assert against those, not against whatever the code currently returns.
- At least one case per known edge: a single sample, zero volume, both networks, a gap.

### Acceptance criteria
- [ ] A documented fixture dataset with hand-derived expected values
- [ ] Each pricing module has a test against it
- [ ] Edge cases covered explicitly
- [ ] The expected values are explained, so a reviewer can verify them independently

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L114 · Nothing fails when a query forgets the network predicate

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate, epic:network-awareness

### Background
Two endpoints shipped without a network filter and both were found by reading, not by failing. Several more are being fixed in this batch. Nothing prevents the next one.

### What to build
- A test that enumerates every raw SQL query touching a network-scoped table and asserts it carries a network predicate.
- An explicit, commented allow-list for the few that genuinely read across networks.
- Wire it into CI so a new query without a predicate fails the build.

### Acceptance criteria
- [ ] Every network-scoped query is checked automatically
- [ ] Exceptions are an allow-list with a stated reason each
- [ ] CI fails on a new unscoped query
- [ ] The test catches today's known offenders before they are fixed

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L115 · Decimal values cross the API boundary as JSON numbers

**Labels:** help wanted, Stellar Wave, area:api, difficulty:intermediate, epic:data-quality

### Background
A `Decimal(36,18)` serialised into JSON becomes a double in every JavaScript client, which is the same precision loss as L097 — just moved to the caller, where Lens cannot fix it. A price of eighteen significant digits is not representable in a JSON number, and no client can opt out.

### What to build
- Serialise decimal quantities as strings, as every financial API does.
- Version the change or gate it behind a header; silently changing a field's JSON type breaks every existing consumer.
- Document it, and update the examples.

### Acceptance criteria
- [ ] Decimal quantities serialise as strings, exactly
- [ ] The change is versioned or negotiated, never silent
- [ ] `openapi.yaml` types updated to match
- [ ] A test asserts an 18-decimal value survives a round trip intact

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### L116 · There is no statement of what the data is supposed to be

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy, epic:docs

### Background
Freshness, completeness, precision and which venues count are decided in this batch, one issue at a time. Nothing will record the decisions, so the next contributor re-decides them, and a consumer has no way to know what they are entitled to rely on.

### What to build
- A `docs/data-quality.md` stating the guarantees: how fresh, how complete, what precision, which venues are included in what, and what happens when each is violated.
- Every number in it is a link to the code or config that enforces it.
- A test fails when a documented bound and its configured value disagree.

### Acceptance criteria
- [ ] The document exists and states each guarantee with its enforcing code
- [ ] A test catches drift between the document and the configuration
- [ ] It is linked from the README and the OpenAPI description

> **Drips Wave** · Complexity: **Easy** · **100 points**

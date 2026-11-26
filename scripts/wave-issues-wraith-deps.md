# Wave batch — two upgrades that are real migrations (W112–W113)

Both came out of reviewing dependabot PRs on 2026-10-21. Each is blocked for a
specific, verified reason, and each is a genuine piece of work rather than a
version bump. The dependabot PRs stay open as the tracking reference.

## Shared with every issue

**Repo:** `Miracle656/wraith`. Install with `npm ci`, typecheck with
`npx tsc --noEmit`, test with `npx jest --runInBand` (this repo uses **jest**,
not vitest). The spec is regenerated with `npm run docs:openapi` and must come
out byte-identical unless you meant to change it.

**This backend carries live money.** The naira rails and the offramp run
against a real provider, and `src/api/linqWebhook.ts` verifies a signature over
the raw request body — so anything that changes body parsing, route matching or
middleware order needs the webhook tests to stay green, not merely compile.

**Do not relax a failing assertion to get green.** If a guard fails, either the
code is wrong or the guard needs rewriting for a new reality — say which in the
PR. `src/__tests__/openapiCoverage.test.ts` in particular is load-bearing: it
is the only thing that catches a live route shipping undocumented, which has
already happened once with `GET /fees`.

---

### W112 · Express 5 is three pieces of work, and one of them is a rewrite

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced

### Background

Dependabot #232 bumps `express` 4.18 → 5.3 and `@types/express` to match. I
took it as far as it goes locally; it is blocked three times over.

**1. It does not install.** `npm ci` fails before any code runs:

```
npm error While resolving: @as-integrations/express4@1.1.2
npm error Found: express@5.3.0
npm error Could not resolve dependency:
npm error peer express@"^4.0.0" from @as-integrations/express4@1.1.2
```

That is Apollo's Express **4** integration, imported in `src/graphql/server.ts`.
`@as-integrations/express5@1.1.2` is published and is a drop-in; Apollo Server
5.5.1 loads fine on Express 5 once swapped.

**2. Five type errors, all route params.** Express 5 types `req.params[x]` as
`string | string[]`, because a wildcard segment can repeat:

```
src/api/accounts.ts(48,42)  src/api/ngn.ts(561,51)  src/api/ngn.ts(563,85)
src/api/ngn.ts(659,49)      src/api/ngn.ts(661,85)
```

All five are single named params, so they are always strings at runtime.

With 1 and 2 done, **tsc is clean and 1024 of 1026 tests pass.**

**3. The last two failures are the actual work.** Both are in
`src/__tests__/openapiCoverage.test.ts`, and one of them is its own
`finds the routes this issue is about (guards the guard)` case — which exists
for exactly this, as its comment says:

> If express internals ever change and the walker starts returning an empty or
> partial list, the assertion above would pass vacuously.

The walker is pinned to Express 4 in two places. It reads `app._router.stack`,
which Express 5 renames to `router`. And `mountPrefix()` reconstructs each
mount path by reverse-engineering the compiled Layer regexp, explicitly
"Pinned to path-to-regexp@0.1.13 (express 4's fixed dependency)" — Express 5
ships path-to-regexp 8, which compiles nothing like it.

### What to build

One PR doing all four:

- `@as-integrations/express4` → `@as-integrations/express5`, import updated
- the five `req.params` narrowings
- `collectRoutes` / `mountPrefix` rewritten for Express 5's router internals,
  with the guard-the-guard anchors still passing and `KNOWN_UNDOCUMENTED`
  unchanged
- full suite green and `npm run docs:openapi` byte-identical

Worth checking while you are in there: Express 5 keeps the original mount path
on the layer, so the regexp reverse-engineering can probably be **deleted**
rather than ported. That would leave the walker simpler than it is today, which
is the right outcome for a test everything else depends on.

### Acceptance criteria

- [ ] `npm ci` resolves with no peer conflict and no `--legacy-peer-deps`
- [ ] `npx tsc --noEmit` clean
- [ ] All tests pass, including every `linqWebhook` / raw-body signature test
- [ ] `openapiCoverage` passes without any assertion being weakened
- [ ] `KNOWN_UNDOCUMENTED` is unchanged — no route becomes newly "known"
- [ ] `npm run docs:openapi` regenerates `openapi.json` byte-identical
- [ ] The PR says what Express 5 changes about error handling on async routes

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### W113 · stellar-sdk 17 removes the XDR accessors the indexer decodes with

**Labels:** help wanted, Stellar Wave, area:backend, difficulty:advanced

### Background

Dependabot #233 bumps `@stellar/stellar-sdk` 15.0.1 → 17.2.1. It installs
cleanly, then `npx tsc --noEmit` gives **16 errors across 5 files**:

```
src/decoder.ts
src/indexer/lp-shares.ts
src/indexer/sac-detect.ts
src/ingester/nft.ts
src/__tests__/nft.test.ts
```

One root cause: v17 turns the XDR unions into discriminated types, so the
accessor-call style is gone.

```
error TS2339: Property 'switch' does not exist on type 'ScVal'.
  Property 'switch' does not exist on type 'ScValBool'.
error TS2349: This expression is not callable.
  Type 'ScValType' has no call signatures.
error TS2339: Property 'contractData' does not exist on type 'LedgerEntryData'.
  Property 'contractData' does not exist on type 'LedgerEntryDataAccount'.
```

### What to build

The migration — but carefully, because of where it lands. Every one of those
files is in the path that decodes contract data off the chain, and a wrong
branch there **does not throw**. It indexes the wrong value, and we find out
from a balance that disagrees with the network.

So this is not a find-and-replace over `.switch()`:

- Work through each union by hand and say, in the PR, which variant each branch
  used to match and which it matches now.
- Add tests that decode **known ledger entries** — real XDR captured from the
  network, with the expected decoded value asserted — so the migration is
  proven rather than assumed. That is the artifact that makes this safe, and it
  keeps paying off the next time the SDK moves.
- `src/indexer/sac-detect.ts` needs the most care: it decides whether a
  contract is a SAC, and getting that wrong mislabels assets everywhere
  downstream.

### Acceptance criteria

- [ ] `npx tsc --noEmit` clean on stellar-sdk 17
- [ ] Every test passes, including the full indexer suite
- [ ] New tests decode captured real XDR and assert the decoded values
- [ ] SAC detection is covered by a test for both the SAC and non-SAC case
- [ ] The PR states, per union, what each branch matched before and after
- [ ] No contract id or ledger key in the diff or fixtures is shortened

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

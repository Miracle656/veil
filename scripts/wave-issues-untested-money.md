# Wave batch — the money paths nothing tests (V337–V356)

Drafted 2026-10-21 by reading `Miracle656/veil` at `main`, running coverage on
the web wallet, and inspecting the published SDK package. Checked against all
139 open issues first; nothing here duplicates one.

Three things shaped this batch.

**One live bug, found by sweeping every navigation target against the screens
that exist.** `frontend/mobile/app/airtime.tsx` sends people to a screen that
is not in the app. It is the KYC step, so it fires exactly when someone is
trying to spend money for the first time.

**The web wallet's largest modules have no tests at all.** Not thin coverage —
zero. `recovery.ts` is 394 lines at 0%, `vault.ts` 432 at 0%,
`walletConnect.ts` 597 at 0%, `multisig.ts` 322 at 0%, and `blend.ts` 280 at
0%. That last one is the module behind the yield number we publish.

**The SDK is on npm and its package metadata is empty.** `invisible-wallet-sdk`
is published at 0.2.0 with no `repository`, no `homepage`, no `bugs` and no
`sideEffects`. For a package whose purpose is to be depended on, that is the
cheapest unclaimed win in the repo.

## Shared with every issue

**Repo:** `Miracle656/veil`. The web wallet is `frontend/wallet` (Next.js), the
app is `frontend/mobile` (Expo / React Native), the SDK is `sdk/`, contracts are
`contracts/` (Rust / Soroban). The backend is the sibling repo
`Miracle656/wraith`.

**Run things:** `npm test` in `frontend/wallet` or `frontend/mobile` (jest; the
app uses jest-expo), `cargo test` in `contracts/`. **Install the app with plain
`npm install`** — never `--legacy-peer-deps`, which corrupts that lockfile. The
SDK needs `npm install --legacy-peer-deps`, because of a pre-existing
react18/react-dom19 mismatch on `main`.

**This wallet holds real money on mainnet.** Keys derive from a passkey, so a
mis-derivation loses funds. Never weaken a test to make a signing path pass.

**Never elide an address, a contract id or a key** — not in code, not in a
comment, not in sample output. A previous batch shortened a contract id and five
contributors invented plausible ones to fill the gap. Write them in full or not
at all. This applies to a 56-character Stellar public key in particular: it is
easy to truncate one by accident and hard to notice.

**A NIN, a phone number and a meter number are personal data** under Nigeria's
NDPA. They are never stored, never logged, and never put in a fixture.

**Write tests that say what they defend.** A one-line comment naming what breaks
if the assertion fails is what stops the next person deleting it.

---

### V337 · The airtime flow sends people to a screen that does not exist

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

`frontend/mobile/app/airtime.tsx:256`:

```ts
const continueFromForm = useCallback(async () => {
  if (await isNairaVerified()) {
    setStep('confirm');
    return;
  }
  router.push({
    pathname: '/verify',
    params: { returnTo: '/airtime', label: 'Airtime', summary: `Airtime · ₦${ngn} to ${phone}` },
  });
}, [router, ngn, phone]);
```

There is no `verify` screen in `frontend/mobile/app`. The web wallet has
`app/verify/`; the app does not, anywhere, including inside route groups — I
checked every navigation target in the app against the files that exist and
this is the only one with nothing behind it.

So an unverified user who fills in the airtime form and presses continue is
pushed to an unmatched route. They have done nothing wrong, the app is working
as designed up to that line, and the KYC step they need is unreachable.

It fires at the worst possible moment: the first time someone tries to spend.

### What to build

- A `verify` screen in the app that accepts the `returnTo`, `label` and
  `summary` params this call already passes, and returns the user to where they
  were on success.
- The same flow is needed by every rail that requires verification, so build it
  as the shared destination rather than an airtime-specific screen. Check which
  other screens need it before choosing the shape.
- Handle the reachable failures honestly: verification declined, already
  verified, and the provider being unreachable are three different things.

**The NIN is personal data.** Submit it and forget it — do not store it, do not
log it, do not keep it in component state longer than the request needs.

### Acceptance criteria

- [ ] `/verify` resolves to a real screen in the app
- [ ] `returnTo`, `label` and `summary` are honoured, and success returns the
      user to the flow they left
- [ ] Declined, already-verified and provider-unreachable are distinguished
- [ ] No NIN is logged, persisted or left in storage
- [ ] A test asserts the navigation target exists, so this cannot regress

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V338 · A swap fee can still tip a swap into failing

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

The platform fee now rides along with a classic SDEX swap, and it checks
affordability first, under an explicit rule stated in the code: *a fee the user
did not ask for must never cause a swap to fail.*

The check does not quite reach that rule. In both `frontend/mobile/lib/sdexSwap.ts`
and `frontend/wallet/app/swap/page.tsx`:

```ts
if (available >= Number(amountIn) + Number(platformFee.amount)) { … }
```

Two things are outside that comparison.

**The transaction fee.** `available` comes from `spendableNativeXlm(account)`,
which subtracts `(2 + subentries) * 0.5` and selling liabilities — but not the
inclusion fee. And adding the fee operation *raises* that inclusion fee, since
it scales with operation count. So the transaction costs slightly more than the
amount the check approved.

**A trustline added by the same transaction.** `spendableNativeXlm` reads
`subentry_count` as it is now. When the swap also adds a `changeTrust`, the
reserve rises by 0.5 XLM once it settles, which the pre-check cannot see.

Both only bite an account spending to its last stroop, and the failure is a
failed swap rather than lost money. But the rule the code states is absolute,
and it is a good rule.

### What to build

- Include the inclusion fee in the margin, accounting for the extra operation
  the fee itself adds.
- Subtract an additional base reserve when the same transaction adds a
  trustline.
- A test for each: an account that can afford the swap but not the swap plus
  fee plus network fee, and one that can afford both but not the new subentry.
  In both cases the swap must go out **without** the fee rather than fail.

### Acceptance criteria

- [ ] The affordability margin includes the inclusion fee, at the operation
      count the transaction will actually have
- [ ] A trustline added in the same transaction is accounted for
- [ ] Tests cover both edges and assert the swap succeeds feeless
- [ ] Mobile and web use the same rule, not two slightly different ones

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V339 · The app has privacy screens and no prover

**Labels:** help wanted, Stellar Wave, area:privacy, difficulty:advanced

### Background

`frontend/mobile/app/privacy/` contains `index`, `send`, `shield`, `unshield`
and `benchmark`. The app cannot perform any of them.

`stellar-private-payments` is **not a dependency of `frontend/mobile`**. Grep
the app for it and every hit is a comment, plus two files that describe a
prover still to be built:

- `frontend/mobile/lib/prover/native/NativeProver.ts` — "1. A Rust crate
  wrapping `stellar-private-payments/sdk/native` with a …"
- `frontend/mobile/lib/prover/webview/ProverWebView.tsx` — "… SDK import."

The web wallet, by contrast, really does it: `frontend/wallet/lib/privacy/client.ts:136`
dynamically imports the SDK, and `app/spp/circuits/[...path]/route.ts` serves
the circuit files.

So the app's privacy section is ahead of the machinery underneath it, and the
published SDK is **browser-only** — `Storage.open()` throws under Node — which
is why a native prover is a real piece of work rather than an import.

### What to build

Pick one of the two routes the repo already sketches, and say in the PR why:

- **WebView prover** — run the browser-only SDK inside a WebView and pass
  proofs across the bridge. Lower risk, and the constraint that forces it is
  already documented.
- **Native prover** — a Rust crate wrapping the native SDK. Faster, much more
  work, and it needs a build story for both platforms.

Either way the screens must stop offering what they cannot do until it works.
A gate that says "not on this device yet" is honest; a button that fails is not.

### Acceptance criteria

- [ ] The app can produce a proof, by whichever route you chose, with the
      reasoning in the PR
- [ ] The privacy screens are gated on that capability actually being present
- [ ] A device that cannot prove says so plainly instead of failing mid-flow
- [ ] The browser-only constraint is documented where the next person will hit it
- [ ] No contract id or pool id in the diff is shortened

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V340 · No private payment has ever been proven end to end

**Labels:** help wanted, Stellar Wave, area:privacy, difficulty:advanced

### Background

The web wallet's privacy integration is wired to the real testnet deployment —
the ASP contracts and both XLM pools are pinned in
`frontend/wallet/lib/privacy/config.ts`, and `client.ts` loads the real SDK.

Nothing proves a private payment has ever completed. Every test that touches
the send path mocks the SDK:

```ts
// frontend/wallet/lib/privacy/__tests__/privateSendClient.test.ts
jest.requireMock('stellar-private-payments')
```

and the only live test, `drift.live.test.ts`, compares our pinned configuration
against upstream `deployments.json` — it checks configuration, not a payment.
The fee figures in `docs/PRIVACY_COST.md` were measured from Nethermind's own
transactions on their pool, not ours.

Privacy is the headline claim of this project. The evidence for it is currently
that the code looks right.

### What to build

- A real end-to-end run: shield, send, unshield, against testnet, with the
  transaction hashes recorded.
- It has to drive a **browser**, not a script — the pinned SDK is browser-only
  and `Storage.open()` dies under Node, so Playwright or equivalent rather than
  a Node harness.
- Make it runnable deliberately rather than on every PR; it depends on a third
  party being up, and a privacy pool is not something to hammer in CI.
- Record what it produced somewhere durable. The artifact of this issue is a
  verifiable hash, not a green tick.

Expect the pinned SDK version to be behind the deployed contracts and to need
re-pinning first. That is part of the work, and
`frontend/wallet/lib/privacy/drift.ts` already exists to detect it.

### Acceptance criteria

- [ ] A browser-driven run completes shield, send and unshield on testnet
- [ ] The transaction hashes are recorded in the repo, written in full
- [ ] The run is reproducible by someone else from the instructions
- [ ] It does not run on every PR
- [ ] Any re-pin needed is a separate, explained commit

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V341 · Nothing proves a wallet can be recovered

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:advanced

### Background

`frontend/wallet/lib/recovery.ts` is 394 lines. Its coverage, from
`npx jest --coverage` in `frontend/wallet`:

```
recovery.ts   0 % stmts   0 % branch   0 % funcs   lines 1-394 uncovered
```

Not thin. Zero. No test executes any line of it.

Recovery is the single feature that decides whether a self-custodial wallet is
trustworthy, and it is the one nobody exercises until the day they have lost
their device — at which point a bug in it is unrecoverable by definition.

### What to build

- Tests across the real paths in that module: what recovery accepts, what it
  refuses, and what it does with a partially-valid input.
- The refusals matter more than the successes. A recovery that wrongly succeeds
  hands someone the wrong wallet; prove it rejects a mismatched credential.
- Cover the no-PRF case, since that is the one with a documented history
  (`docs/MOBILE_PRF_FINDINGS.md`).

Related: #1050 asks for recovery proven on a real device. This is the unit-level
complement, and neither replaces the other.

### Acceptance criteria

- [ ] Every exported function in `recovery.ts` is exercised
- [ ] A mismatched credential is proven to be refused, not silently accepted
- [ ] The no-PRF path is covered
- [ ] Each test names what breaks if it fails
- [ ] No key material appears in output

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V342 · The yield number we publish comes from an untested module

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`frontend/wallet/lib/blend.ts` is 280 lines at **0% coverage** — lines 1-280,
nothing executed.

That module is where the Blend lending rate comes from: the number shown on the
earn screen and quoted publicly. A rate that is computed wrongly is not a
cosmetic bug. It is a number people make a decision with, and being wrong about
it in either direction is bad — too high and we have misled someone into a
position, too low and we have talked them out of a real one.

### What to build

- Tests for the rate computation against known pool inputs, including the
  arithmetic that converts whatever Blend reports into the figure we display.
- Cover the states that are not a number: pool unreachable, pool empty, zero
  utilisation, and a rate that arrives malformed. Each should be visibly
  unavailable rather than rendered as a plausible figure.
- Assert the rounding and the units explicitly. A rate presented as a
  percentage when it is a fraction is a factor-of-100 error of the kind this
  codebase has already met once on the naira side.

### Acceptance criteria

- [ ] The rate computation is covered against known inputs
- [ ] Unreachable, empty and malformed responses are each tested
- [ ] No failure path renders a number that looks real
- [ ] Units and rounding are asserted, not assumed
- [ ] Coverage on `blend.ts` is materially above 0%

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V343 · The vault holds money and has no tests

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:advanced

### Background

`frontend/wallet/lib/vault.ts` is 432 lines at **0% coverage** — the largest
untested module in the web wallet after `walletConnect.ts`.

A vault is a place people put money to make it harder to spend. That means its
value is entirely in its restrictions, and a restriction nobody tests is a
restriction nobody knows is there.

### What to build

- Tests for deposit, withdrawal and whatever the module's locking rules are.
- Prove the restrictions hold: whatever the vault is supposed to prevent, write
  the test that attempts it and asserts it fails.
- Cover the boundaries — zero, the exact limit, one over, and a withdrawal
  while another is pending.

Read the module first and write down what it promises before testing it. If a
promise turns out not to hold, that is a finding and belongs in the PR rather
than being quietly tested around.

### Acceptance criteria

- [ ] Deposit and withdrawal paths are covered
- [ ] Each restriction has a test that attempts to violate it
- [ ] Boundary amounts are covered
- [ ] Anything the module does not actually enforce is reported in the PR
- [ ] Coverage on `vault.ts` is materially above 0%

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V344 · Multisig is 322 untested lines

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:advanced

### Background

`frontend/wallet/lib/multisig.ts` is 322 lines at **0% coverage**.

Multisig exists so that no single key can move money alone. The whole feature is
a threshold check, and a threshold check that is off by one either blocks a
legitimate payment or permits one that should have needed another signature.

The second of those is the one that loses money, and it is also the one a
happy-path test will never find.

### What to build

- Tests for signer management and threshold evaluation.
- Specifically prove the under-threshold case **fails**: a transaction with one
  signature fewer than required must not go out. That is the assertion worth
  having.
- Cover removing a signer below the threshold, and a duplicate signature
  counting once rather than twice.

### Acceptance criteria

- [ ] Threshold evaluation is covered, including exactly-at and one-below
- [ ] A duplicate signature does not count twice
- [ ] Dropping below the threshold by removing a signer is handled
- [ ] Each test states what it defends
- [ ] Coverage on `multisig.ts` is materially above 0%

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V345 · WalletConnect is the largest untested module in the wallet

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:advanced

### Background

`frontend/wallet/lib/walletConnect.ts` is 597 lines at **0% coverage** — lines
3-597, nothing executed.

This is the surface through which other applications ask this wallet to sign
things. It is, by construction, the part of the wallet most exposed to input we
do not control.

### What to build

- Tests for session handling and for each request type the module accepts.
- Lead with the rejections. A malformed request, an unsupported method, a
  request for a chain we are not on, and a session that has expired should each
  be refused in a way a test can pin.
- Prove that nothing is signed without the user's approval step, for every
  request type that signs.

### Acceptance criteria

- [ ] Session lifecycle is covered, including expiry
- [ ] Every accepted request type has a test
- [ ] Malformed, unsupported and wrong-network requests are proven refused
- [ ] No signing path can complete without the approval step, proven by test
- [ ] Coverage on `walletConnect.ts` is materially above 0%

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V346 · Naira formatting has 10% branch coverage

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:easy

### Background

`frontend/wallet/lib/currency.ts`:

```
currency.ts   33.33 % stmts   10.81 % branch   6.25 % funcs
uncovered: 65, 75-76, 110, 115, 123-146, 158-159, 163-165, 170, 181-191, 196-203, 215-222
```

Branch coverage near ten per cent on the module that formats money. Almost
every decision it makes is untested, and formatting is nothing but decisions:
where the separator goes, how many decimals survive, what happens to a very
large or very small number, what a zero looks like, what a negative looks like.

Nigerian amounts routinely run to seven figures, and kobo is two decimal
places. Both ends of that range need to be right.

### What to build

- Tests for each branch: large amounts with separators, kobo precision, zero,
  negative, and whatever the module does with a value it cannot parse.
- Assert exact output strings. A formatting test that checks "contains a comma"
  is not a formatting test.
- Cover the naira and crypto paths separately if the module handles both; their
  rounding rules are not the same.

### Acceptance criteria

- [ ] Every branch in `currency.ts` is exercised
- [ ] Assertions are on exact strings
- [ ] Seven-figure amounts, kobo precision, zero and negative are covered
- [ ] Unparseable input has a defined, tested result
- [ ] Branch coverage is materially above 10%

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V347 · Deploying a wallet is 27% covered

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

`frontend/wallet/lib/walletDeployment.ts`:

```
walletDeployment.ts   27.5 % stmts   25 % branch   40 % funcs
uncovered: 30-36, 77-87, 102-125
```

Deployment happens once per user and is the moment their wallet address comes
into existence. It is also unrepeatable: the factory refuses a duplicate, so a
deployment that half-fails cannot simply be retried into a clean state.

The uncovered ranges are the error handling.

### What to build

- Tests for the failure paths specifically: the factory refusing because the
  wallet already exists, the fee payer being unfunded, and the simulation
  succeeding while submission fails.
- Prove that a failed deployment leaves something a retry can act on, and that
  a retry after an apparent failure does not produce a second wallet or a lost
  one.
- Cover the counterfactual address calculation if that lives here — an address
  predicted wrongly means money sent somewhere nobody controls.

### Acceptance criteria

- [ ] The uncovered error paths are exercised
- [ ] Already-deployed, unfunded fee payer and submission failure are covered
- [ ] A retry after a failure is proven safe
- [ ] Any address derivation is asserted against a known expected value
- [ ] Coverage on `walletDeployment.ts` is materially above 27%

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V348 · The privacy fee sampler is untested, and it is what our cost claims rest on

**Labels:** help wanted, Stellar Wave, area:privacy, difficulty:intermediate

### Background

`frontend/wallet/lib/privacy/sponsoredSubmit.ts` is at **0% coverage** —
lines 14-72.

`docs/PRIVACY_COST.md` says this helper "can resample these numbers from a live
pool", and the fee figures in that document are the basis for every statement
we make about what privacy costs. A sampler that miscounts, or silently samples
nothing and reports a default, produces a number we would then repeat in public.

### What to build

- Tests for the sampling and the aggregation: a known set of transactions in,
  the expected median out.
- Cover the empty case explicitly. Zero samples must be distinguishable from a
  sample of zero cost, and must not produce a figure.
- Cover a partial fetch, since this reads from a third party that can answer
  incompletely.

### Acceptance criteria

- [ ] Sampling and median calculation are covered against known inputs
- [ ] An empty sample yields no figure, not a default
- [ ] A partial or failed fetch is handled and tested
- [ ] The documented figures can be regenerated by running it
- [ ] Coverage on `sponsoredSubmit.ts` is materially above 0%

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V349 · The activity feed and schedules have no tests

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:intermediate

### Background

Two modules in `frontend/wallet/lib`, both at **0% coverage**:

```
activityFeed.ts   lines 3-90    uncovered
schedules.ts      lines 1-101   uncovered
```

The activity feed is how a user checks whether something happened — the first
place anyone looks when they are unsure whether a payment went out. Schedules
move money without anyone present, which makes an error in them harder to
notice and longer-lived.

### What to build

- For the feed: ordering, de-duplication, and how an entry that is still
  unconfirmed is represented. An activity list that shows a pending payment as
  complete is worse than one that omits it.
- For schedules: the next-run calculation, including across a month boundary and
  a daylight-saving change, and what happens when a run is missed because the
  app was closed.
- Both: an empty state that is distinguishable from a failed load.

### Acceptance criteria

- [ ] Feed ordering and de-duplication are covered
- [ ] An unconfirmed entry is never shown as confirmed, proven by test
- [ ] Next-run calculation covers month boundaries and a missed run
- [ ] Empty and failed-to-load are distinguished in both modules
- [ ] Coverage on both files is materially above 0%

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V350 · The bank list is data nobody checks

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:easy

### Background

`frontend/wallet/lib/nigerianBanks.ts` is at **0% coverage**, lines 17-36.

It is a lookup table of Nigerian banks, used where a user names the account
their cash-out should land in. A wrong or missing bank code sends money to the
wrong institution, and that is not a failure the user can see before it
happens — they pick a familiar name from a list and trust the code behind it.

Bank lists also go stale: banks merge, rename, and change codes.

### What to build

- Tests for the lookup: a known bank resolves to its known code, an unknown
  name is refused rather than defaulted, and the table has no duplicate codes
  or duplicate names.
- A check that every entry has both a name and a code, so a half-filled row
  cannot ship.
- Say in the PR where the list came from and when, so the next person knows how
  stale it is. If there is an authoritative source that can be fetched, note
  whether it is worth doing.

### Acceptance criteria

- [ ] Known names resolve to the correct codes, asserted individually
- [ ] An unknown bank is refused, never defaulted
- [ ] No duplicate names or codes, proven by test
- [ ] Every entry is complete
- [ ] The list's provenance and date are documented

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V351 · The SDK is on npm with no links back to anything

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:easy

### Background

`invisible-wallet-sdk` is published at 0.2.0. Its `package.json` has:

```
repository: undefined
homepage:   undefined
bugs:       undefined
engines:    undefined
```

So the npm page has no link to the source, no link to documentation and no way
to report a problem. Someone who finds the package has nowhere to go, and
someone evaluating it sees a package that could be from anyone.

This matters more here than it would for most packages. Being depended on is
the point of publishing this SDK, and this is the cheapest possible obstacle to
that, removable in one commit.

`repository` is also a prerequisite for npm provenance, which the OIDC
publishing work in #402 set up — without it, a published build cannot be linked
to the commit that produced it.

### What to build

- `repository`, `homepage` and `bugs`, pointing at the real places.
- `engines`, stating the Node versions this is actually tested on rather than a
  guess.
- Check the npm page after publishing and confirm the links resolve. A
  `repository` field with a slightly wrong URL renders as a broken link, which
  is worse than none.

### Acceptance criteria

- [ ] `repository`, `homepage` and `bugs` are present and resolve
- [ ] `engines` reflects what CI actually tests
- [ ] The rendered npm page is checked, not just the JSON
- [ ] Nothing else in the published surface changes

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V352 · Every consumer of the SDK ships all of it

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:intermediate

### Background

`sdk/package.json` declares no `sideEffects` field. Without it a bundler must
assume every module in the package might do something on import, so it cannot
drop the ones a consumer never touches.

The SDK is not small. `sdk/src` contains the core, WebAuthn, crypto, recovery,
backup, bulk payout, claimable balances, SEP-7, SEP-8, outbox, reserves,
federation and framework adapters for five frameworks. A site that imports one
function to sign a message currently pays for the lot.

For a browser SDK that is a direct cost to every page that uses it, and the fix
is a one-line declaration plus the work of making it true.

### What to build

- Audit the package for genuine import-time side effects — module-level code
  that registers, mutates globals or starts anything. Those are what the field
  is about.
- Remove or defer what you find, then declare `sideEffects` honestly. If some
  files genuinely have them, list those files rather than claiming `false` for
  the package.
- Measure it. `npm run size` exists; record before and after in the PR for a
  realistic single-function import.

Declaring `sideEffects: false` while a side effect remains is worse than leaving
it out, because the bundler will then remove code the package needed.

### Acceptance criteria

- [ ] Import-time side effects are audited and the findings listed
- [ ] `sideEffects` is declared accurately — `false`, or a file list
- [ ] Before and after sizes for a single-function import are in the PR
- [ ] The full test suite still passes, and so does `npm run test:surface`

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V353 · The SDK claims two module formats and ships one

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:advanced

### Background

From `sdk/package.json`:

```json
"main":   "dist/index.js",
"module": "dist/index.js",
"type":   undefined
```

`main` and `module` point at the **same file**, and there is no `type` field, so
the package is CommonJS by default. `module` exists to tell a bundler where the
ESM build is; pointing it at the CommonJS one tells it something untrue.

The `exports` map has the same gap — seven subpaths, each with `types` and
`default` (plus `react-native` on two), and none with `import` or `require`
conditions:

```json
".": { "types": "./dist/index.d.ts", "react-native": "./src/index.ts", "default": "./dist/index.js" }
```

So an ESM consumer and a CommonJS consumer resolve to the same file. One of
them is being handed the wrong format, and which one breaks depends on their
bundler.

### What to build

- Decide what the package actually ships: dual ESM and CommonJS, or ESM only.
  Both are defensible for a browser and React Native SDK; argue the choice.
- Make `main`, `module`, `type` and the `exports` conditions describe that
  truthfully, including the six subpaths beyond the root.
- Keep the `react-native` condition working — it deliberately points at
  TypeScript source, which is correct for Metro and must not be broken.
- Test it from outside: a small ESM consumer and a CommonJS consumer that both
  import and run something. That is the only check that actually proves this.

### Acceptance criteria

- [ ] The declared format matches what is built, for every subpath
- [ ] An ESM consumer and a CommonJS consumer both work, proven by a test
      that imports the published layout
- [ ] The `react-native` condition still resolves to source
- [ ] `npm run test:surface` and the type tests still pass
- [ ] The PR states the chosen format strategy and why

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V354 · Tooling cannot read the SDK's own package.json

**Labels:** help wanted, Stellar Wave, area:sdk, difficulty:easy

### Background

The `exports` map in `sdk/package.json` lists seven subpaths and does not
include `./package.json`. Once a package declares `exports`, anything not
listed is unreachable — including the manifest itself.

Plenty of tooling reads it: bundler plugins resolving versions, test runners,
framework CLIs, and anything checking what version of the SDK is installed. For
those, this is not a style question; the import simply fails.

It is one line, and it is the kind of thing nobody notices until a consumer
files a confusing bug report.

### What to build

- Add `"./package.json": "./package.json"` to `exports`.
- While in there, check the six non-root subpaths resolve as declared. `./vue`,
  `./svelte`, `./solid` and `./angular` each point into `dist/`, and `files`
  also ships top-level `vue`, `svelte`, `solid` and `angular` directories —
  worth confirming those two facts agree, and simplifying if they do not.

### Acceptance criteria

- [ ] `./package.json` is exported
- [ ] Every declared subpath resolves in a packed tarball, checked with
      `npm pack` rather than from the working tree
- [ ] Any disagreement between `exports` and `files` is resolved or explained

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V355 · Nobody can tell which client is meant to do what

**Labels:** help wanted, Stellar Wave, area:docs, difficulty:easy

### Background

The two clients have drifted and nothing records which differences are
deliberate.

The web wallet has `invest`, `spp`, `verify`, `bills`, `earn` and `agent`
surfaces. The app has `airtime`, `pay`, `fonts`, `ui` and a dApp browser. Both
have `privacy`, `dapps`, `vault`, `multisig`, `pools`, `send`, `receive`,
`swap`, `withdraw`, `settings` and `offline`.

Some of those gaps are correct — a phone can do things a browser cannot, and
the reverse. Others are drift, and one of them is a live bug: `verify` exists on
web, the app navigates to it, and the app does not have it (V337).

Because nothing is written down, every parity question gets re-argued from
memory, and a missing screen looks the same as a deliberate omission.

### What to build

- One table in `docs/`, listing every top-level surface of both clients, and
  marking each as deliberately platform-specific or an unclosed gap.
- For the gaps, say which direction they should close in.
- Keep it one table. A long document will not be maintained and the value here
  is entirely in it staying current.

### Acceptance criteria

- [ ] Every top-level surface of both clients appears
- [ ] Each is marked deliberate or a gap, with a direction for the gaps
- [ ] It is short enough to stay current
- [ ] It links to the issues tracking the gaps that are already known

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V356 · The branded QR download is untested and user-facing

**Labels:** help wanted, Stellar Wave, area:tests, difficulty:easy

### Background

`frontend/wallet/lib/downloadBrandedQr.ts` is 143 lines at **0% coverage**,
lines 1-143.

It renders a QR code with branding and hands the user a file. Two things make
that worth testing despite looking cosmetic.

The first is that a QR code is machine-read. A code that renders but scans
wrongly — wrong quiet zone, insufficient contrast, logo covering too much of
the pattern — sends money to the wrong place, and it looks perfect to the
person who made it.

The second is that it encodes an address. If the encoded payload is ever
truncated or re-encoded, that is the elided-address problem in a form nobody
can read by eye.

### What to build

- Assert the encoded payload is the full address, byte for byte, with no
  truncation and no normalisation.
- Decode the generated QR in the test and compare it to the input. Rendering it
  is not enough; the test has to read it back.
- Cover the branding not breaking scannability: whatever overlay is applied, the
  decoded result must still match.

### Acceptance criteria

- [ ] The generated code is decoded in the test and matches the input exactly
- [ ] The full address is encoded, never shortened
- [ ] Branding is proven not to break decoding
- [ ] Coverage on `downloadBrandedQr.ts` is materially above 0%

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

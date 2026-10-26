# Wave batch — the bill rails we already have (V295–V306)

Drafted 2026-10-19 by reading `Miracle656/veil` at `main` and the wraith
backend. Checked against all 98 open veil issues first; nothing here
duplicates one.

The theme: **wraith can already pay five kinds of Nigerian bill. The apps offer
one.**

```ts
// wraith src/linq/bills.ts
export type BillCategory = "airtime" | "data" | "electricity" | "cabletv" | "betting";
```

`POST /ngn/bills` and `GET /ngn/bills/:orderId` are live. Mobile ships one of
those five — airtime — and advertises the rest as *coming soon*:

```ts
// frontend/mobile/components/PayForGrid.tsx
{ id: 'airtime', … status: 'live', route: '/airtime' },
{ id: 'data',    … status: 'soon' },
{ id: 'power',   … status: 'soon' },
{ id: 'tv',      … status: 'soon' },
{ id: 'bills',   … status: 'soon' },
{ id: 'betting', … status: 'soon' },
```

So this is not a batch about building a rail. The rail exists, it is paid for,
and four of its five categories have no way in.

## Shared with every issue

**Repo:** `Miracle656/veil`. Mobile is `frontend/mobile` (Expo / React Native),
the web wallet is `frontend/wallet` (Next.js). The backend is the sibling repo
`Miracle656/wraith`; bills live in `src/linq/bills.ts` and `src/api/ngn.ts`.

**Run the tests:** `npm test` in `frontend/mobile` (jest via jest-expo) or
`frontend/wallet`. `Maestro — Android emulator` and `Wallet E2E Tests` are
pre-existing red on `main`; they are not your PR.

**Install with plain `npm install` in `frontend/mobile`** — never
`--legacy-peer-deps`, which corrupts that lockfile.

**This wallet holds real money on mainnet and these flows spend it.** A bill is
paid from the user's own crypto and cannot be reversed. Two rules follow, and
`frontend/mobile/app/airtime.tsx` already honours both — read it before you
write anything:

- **A fee the user only discovers afterwards is not a fee, it is a surprise.**
  `previewSpendFee` exists so a screen can show the charge before the passkey
  prompt.
- **"We could not confirm this" is not "this failed."** The person has already
  been charged. Telling them it failed invites them to pay twice.

**Linq has no sandbox.** Every call against the real provider moves real money,
which is why the whole `/ngn` surface is mainnet-gated at the router. Test
against mocks, never against the live provider.

**Never elide an address, a contract id or a key** in code, comments or test
fixtures. A previous batch shortened a contract id in an issue and five
contributors invented plausible-looking ids to fill the gap.

---

### V295 · The web wallet's bills page says nothing is live. It is now wrong.

**Labels:** help wanted, Stellar Wave, area:web, difficulty:easy

### Background

`frontend/wallet/app/bills/page.tsx` opens with this:

```
 * The service grid and layout are real; the rails behind them are not wired
 * yet, and deliberately so. Paying a Nigerian bill from crypto needs a
 * naira conversion leg, and `docs/NGN_RAILS.md` records why that leg is
 * currently blocked on licensing rather than on engineering.
```

That was true when it was written and it is not true now. The naira leg shipped
on Linq, `POST /ngn/bills` is live in wraith, and a user paid for airtime from
the mobile app today. The page is a static grid of seven services that does
nothing, fronted by a comment explaining that nothing can be done.

The instinct behind it was right — **a fake purchase history would be the most
misleading thing in the wallet** — and that instinct should survive whatever
replaces it. But a screen that says a working feature is unavailable is its own
kind of lie, and the comment will keep misleading whoever reads the file next.

### What to build

- Decide what this page is now: the real bills surface, or an honest signpost
  to the mobile app. Either is defensible; the current state is neither.
- If it becomes real, it goes through the same `/ngn/bills` route the mobile app
  uses — do not grow a second client.
- If it stays a signpost, say *why* in one sentence a user can act on, and
  correct the comment so the next reader is not told the rails are blocked.
- `docs/NGN_RAILS.md` needs the same correction either way.

### Acceptance criteria

- [ ] The page no longer states that the rails are unavailable
- [ ] The file comment describes what is true today
- [ ] Nothing invented is shown — no fake balances, no fake history
- [ ] `docs/NGN_RAILS.md` reflects that the naira leg shipped
- [ ] If the page calls the backend, it shares the client the rest of the wallet uses

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V296 · One bill flow, not five copies of `airtime.tsx`

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:advanced

### Background

`frontend/mobile/app/airtime.tsx` is 844 lines with 22 `useState`/`useEffect`
calls. Inside it: amount entry, contact picking, fee preview, a confirm step, a
passkey spend, order creation, status polling, and the terminal states.

Four more categories are coming — data, electricity, cable TV, betting. If each
one copies this file, the wallet ends up with five near-identical 800-line
screens, and the next fix to the spend path or the poll loop has to be made five
times. It will be made three times, and nobody will know which two were missed.

**This issue must land before V297–V300.** It is the one that decides whether
this batch leaves the codebase better or four times worse.

### What to build

- Extract the parts that are the same for every bill: amount and asset choice,
  the fee preview, the confirm-and-spend step, order creation, status polling,
  and the terminal states.
- Leave a per-category seam for what genuinely differs — the identifier a
  category needs (V299), its validation, its labels, and its provider lookups.
- `airtime.tsx` becomes the first consumer of the shared flow. Its behaviour
  must not change; the existing tests are the proof.
- Do not generalise what you cannot see yet. Two categories is enough to find
  the shape; five hypothetical ones is how an abstraction becomes a maze.

### Acceptance criteria

- [ ] The shared flow exists and `airtime.tsx` uses it
- [ ] Airtime behaviour is unchanged, demonstrated by the existing tests passing untouched
- [ ] A second category can be added without copying the flow
- [ ] The per-category seam is documented with what belongs on each side
- [ ] No category-specific logic leaks into the shared path

> **Drips Wave** · Complexity: **Advanced** · **200 points**

---

### V297 · Data bundles: the backend sells them, the app says "soon"

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

`BillCategory` includes `"data"`, `POST /ngn/bills` accepts it, and the mobile
tile reads `status: 'soon'`.

Data differs from airtime in one way that matters: airtime is an arbitrary
amount, a data bundle is a **product chosen from a list** — 1GB for 30 days,
and so on — and the list is per network operator. A screen that asks for an
amount in naira is the wrong shape for it.

### What to build

- Build on the shared flow from **V296**; do not copy `airtime.tsx`.
- Fetch the bundle list for the chosen operator and let the user pick one. The
  price comes from the selected bundle, not from a free-text amount.
- Show what the bundle actually is — size and validity — not just a price. A
  list of naira amounts tells the user nothing about what they are buying.
- Handle an operator with no bundles available without implying the purchase
  failed.
- Flip the tile to `live` with its route only once the flow works end to end.

### Acceptance criteria

- [ ] A data bundle can be bought end to end against a mocked provider
- [ ] Bundles are listed per operator with size and validity, not price alone
- [ ] The fee is shown before the passkey prompt
- [ ] An empty bundle list is reported as such, not as a failure
- [ ] The tile goes `live` only when the flow is complete

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V298 · Electricity: a meter number is not a phone number

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

`BillCategory` includes `"electricity"`; the `power` tile says `soon`.

Electricity is the category where a typo costs the most. The user enters a
**meter number** belonging to a disco, and prepaid meters answer with a token
the customer must then enter on the meter itself. Paying the wrong meter credits
a stranger's electricity, and there is no reversal.

### What to build

- Build on the shared flow from **V296**.
- Collect the disco and the meter number, and distinguish prepaid from postpaid
  if the provider does.
- **Verify the meter before taking money**, and show the returned customer name
  so the user can confirm it is theirs. This is the single most valuable control
  in the flow and it belongs before the spend, not after.
- Surface the prepaid token prominently on success, and make it copyable — a
  token the user cannot retrieve is a payment they cannot use.
- The token must survive leaving the screen. Put it where the order record is.

### Acceptance criteria

- [ ] The meter is verified and the customer name shown before any spend
- [ ] The user must confirm the name before the passkey prompt
- [ ] A prepaid token is displayed, copyable, and retrievable after leaving the screen
- [ ] An unverifiable meter blocks the purchase rather than proceeding
- [ ] Tests cover verification success, failure, and a token-bearing success

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V299 · Each category needs a different identifier, and none of them are validated

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

Airtime takes a phone number. Data takes a phone number and an operator.
Electricity takes a meter number and a disco. Cable TV takes a smartcard or IUC
number. Betting takes an account id.

These are different shapes with different rules, and getting one wrong sends
money to a stranger's account. There is no shared place that knows what each
category requires or how to check it.

### What to build

- One declaration per category of the identifier it needs: its label, its
  format, and how to validate it.
- Validate **before** the confirm step, with a message naming what is wrong —
  not "invalid input".
- Where the provider offers a lookup that returns the account holder's name,
  prefer it over format checks. A correctly-formatted wrong number is the
  dangerous case, and only the provider can catch it.
- This is the per-category seam **V296** leaves open; build it against that
  rather than beside it.

### Acceptance criteria

- [ ] Each category declares its identifier, label and validation in one place
- [ ] Validation runs before the confirm step and names the specific problem
- [ ] A provider lookup is used where one exists, and the returned name is shown
- [ ] Adding a category means adding a declaration, not editing a flow
- [ ] Tests cover a valid id, a malformed id, and a well-formed id the provider rejects

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V300 · Cable TV and betting, the last two categories

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

`cabletv` and `betting` complete the five the backend supports. Both are
mostly the shared flow plus their own identifier, so they are the smallest of
the four once **V296** and **V299** exist.

Cable TV has one wrinkle worth naming: subscriptions are usually **packages**
rather than amounts, and a smartcard lookup returns the current package and due
date — information the user needs before paying, not after.

### What to build

- Both categories on the shared flow, with their identifiers declared per V299.
- Cable TV: look the smartcard up, show the customer name, current package and
  due date before the spend, and let the user choose the package.
- Betting: account id, verified by lookup where the provider supports it.
- Flip each tile to `live` only when its flow works end to end.
- If either provider is unavailable, say so rather than hiding the category —
  "we cannot reach the provider" and "this does not exist" are different.

### Acceptance criteria

- [ ] Both categories complete a purchase end to end against a mocked provider
- [ ] A smartcard lookup shows name, package and due date before any spend
- [ ] Each tile goes `live` only when complete
- [ ] A provider outage is reported as an outage, not as an unavailable feature
- [ ] Tests cover one success and one lookup failure per category

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V301 · A bill purchase has no history

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

A bill is paid, a screen says it succeeded, and the user navigates away. There
is no record in the app. For electricity that is worse than untidy — the prepaid
token shown on the success screen is the thing the purchase was *for*, and
leaving the screen loses it.

`GET /ngn/bills/:orderId` exists, so the backend can answer about an order the
app knows the id of. Nothing in the app keeps the id.

### What to build

- Persist each bill order locally: category, identifier, amount, asset, order
  id, status, time — and the prepaid token where one was returned.
- A list showing recent purchases, with the token retrievable for electricity.
- Re-check status for anything not in a terminal state, so an order that was
  pending when the app closed resolves rather than staying pending forever.
- Do **not** store anything that is not needed. A meter number is a customer
  identifier; a NIN must never appear here at all.

### Acceptance criteria

- [ ] Bill orders are persisted with enough to re-query them
- [ ] A prepaid token is retrievable after leaving the success screen
- [ ] Non-terminal orders are re-checked on next open
- [ ] No NIN or other identity data is stored
- [ ] A test proves a pending order resolves after a restart

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V302 · "We could not confirm it" must survive the shared flow

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

A bill purchase spends the user's crypto first and then asks the provider
whether it worked. The poll can fail, and the honest answer at that point is
**"we do not know"** — not "it failed". The person has already been charged;
telling them it failed invites them to pay twice.

Airtime is getting a bounded poll with an `unconfirmed` terminal state. When
**V296** extracts the shared flow, that behaviour has to come with it, or the
four new categories inherit a spinner that never resolves.

### What to build

- The shared flow owns polling: a bounded number of attempts, visible retries,
  and a terminal `unconfirmed` state distinct from `failed`.
- `unconfirmed` must say what the user should do — check with the provider, do
  not pay again, here is the order reference.
- A poll error and a poll timeout are different reasons and should be reported
  as such.
- Never render an unbounded spinner. A screen that waits forever is
  indistinguishable from a hang.

### Acceptance criteria

- [ ] Polling is bounded and the bound is documented
- [ ] `unconfirmed` is a distinct terminal state from `failed`
- [ ] The copy tells the user not to pay again and gives them the reference
- [ ] Error and timeout are distinguishable
- [ ] Tests cover success, timeout and repeated poll failure

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V303 · Buying with naira exists on a branch and not on `main`

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:intermediate

### Background

`frontend/mobile/app/buy-ngn.tsx` does not exist on `main`. It exists on
`feat/buy-with-naira`, which is what the installed APK was built from — the same
gap airtime had until it was brought across.

The `buy-ngn` tile is absent from `main`'s `PayForGrid`, so the onramp is
reachable in the shipped app and nowhere in the branch that deploys. Every
future fix to it has the argument airtime's fix just had: the file it changes is
not on `main`.

### What to build

- Bring the naira onramp screen to `main` the way airtime was brought: take only
  what it needs, verify it typechecks and tests, and do not merge the branch
  wholesale — `main` and that branch have diverged in both directions.
- Add its tile to `PayForGrid` with the correct route.
- Check what it imports that `main` lacks. Airtime needed `lib/platformFee.ts`,
  `lib/pickContact.ts`, an icon and a `sendPayment` signature change; this will
  have its own list.
- The full mobile suite must pass.

### Acceptance criteria

- [ ] The onramp screen is on `main` and reachable from the grid
- [ ] Only what the screen needs is brought across, listed in the PR
- [ ] `frontend/mobile` typechecks and the full suite passes
- [ ] No unrelated branch work rides along
- [ ] The PR says what was deliberately left behind

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V304 · A tile that says "soon" forever is worse than no tile

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy

### Background

`PayForGrid` renders seven services; five say `soon`. One of them — `bills`,
"Water · waste" — is not a category the backend supports at all, so it is not
"soon", it is **not planned**.

A grid of mostly-unavailable tiles trains people to ignore the grid. And a user
who taps four things that do nothing stops tapping the fifth, which is the one
that works.

### What to build

- Decide per tile: shipping soon, or not planned. They should not look the same.
- Hide or clearly separate what is not planned. `water` is not in
  `BillCategory`; pretending otherwise is a promise nobody made.
- Give a `soon` tile something to do — tell the user what it will be, or let
  them register interest — or do not render it.
- The grid should still read as a coherent surface when only two tiles are live.

### Acceptance criteria

- [ ] "Coming soon" and "not planned" are visually and semantically distinct
- [ ] No tile implies a capability the backend does not have
- [ ] Tapping an unavailable tile explains rather than doing nothing
- [ ] The grid looks deliberate with two live tiles
- [ ] A test asserts every live tile has a route that resolves

> **Drips Wave** · Complexity: **Easy** · **100 points**

---

### V305 · The bill flow has no tests above the unit level

**Labels:** help wanted, Stellar Wave, area:testing, difficulty:intermediate

### Background

Airtime spends real crypto, calls a provider with no sandbox, polls for a
result and has several terminal states. The pieces have unit tests;
the **flow** — enter, preview the fee, confirm, spend, poll, land in a terminal
state — has none.

That matters most where it is hardest to reason about: a spend that succeeds
while the poll fails, a poll that times out, a provider that answers after the
screen has given up.

### What to build

- Flow-level tests driving the screen against a mocked provider and a mocked
  spend path: the happy path, an unaffordable fee, a spend that fails, a poll
  that times out, and a poll that errors repeatedly.
- Assert the user-visible outcome, not internal state. The question is what the
  person is told, because that is what decides whether they pay twice.
- Once **V296** lands, these run against the shared flow and cover every
  category at once — which is most of the argument for extracting it.
- Never call the real provider. Linq has no sandbox and every call moves money.

### Acceptance criteria

- [ ] The flow is driven end to end against mocks
- [ ] Fee-unaffordable, spend-failed, poll-timeout and poll-error are each covered
- [ ] Assertions are on what the user sees
- [ ] No test touches the live provider
- [ ] The tests run in CI with the rest of the mobile suite

> **Drips Wave** · Complexity: **Intermediate** · **150 points**

---

### V306 · Nothing tells a user which asset a bill will be paid from

**Labels:** help wanted, Stellar Wave, area:mobile, difficulty:easy

### Background

`BillCoin` is `"xlm" | "usdc"`, so every bill is funded from one of two assets
and the choice changes what leaves the wallet. A user holding both should be
told which one is about to be spent, and ideally be allowed to choose.

This compounds with the fee: `previewSpendFee` quotes a charge in the asset
being spent, so an unexplained asset choice makes the fee unexplained too.

### What to build

- Show which asset will fund the bill, before the confirm step, next to the fee.
- Let the user choose when they hold both, and remember the choice.
- When only one asset can cover it, say so rather than silently picking — "paid
  with USDC because your XLM balance is short" is an explanation; a silent
  switch is a surprise.
- Use the reserve-aware spendable balance for XLM, not the raw balance. Base
  reserve plus trustlines is why a balance that looks sufficient is not, and it
  is how a payment underfunded by 0.00023 XLM rolled back an entire transaction.

### Acceptance criteria

- [ ] The funding asset is visible before the passkey prompt
- [ ] The user can choose when both assets can cover the bill
- [ ] An automatic choice is explained, not silent
- [ ] XLM affordability uses the reserve-aware spendable balance
- [ ] A test covers both-affordable, one-affordable and neither-affordable

> **Drips Wave** · Complexity: **Easy** · **100 points**

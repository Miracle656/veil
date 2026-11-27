# Payment-link claim spike — how someone with no wallet claims money from a link

**Status:** decision made; mechanism proven end to end on testnet. No product code written — this document and `scripts/spikes/link-claim-spike.mjs` are the deliverable.
**Date:** 2026-11-20 · **Updated:** 2026-11-27 — fee-payer seed arithmetic corrected (a 1 XLM seed is all reserve and cannot pay a fee); the spike now submits a real transaction from the seeded fee payer; `balance_id` finding reframed as a testnet observation.
**Issue:** #1283 · Spike branch: `spike/link-claim-decision`

## The problem in one line

The product is "put money in a link, the recipient taps it, signs a passkey, the money
is in their new wallet" — but a Stellar claimable balance names its claimants at
creation time, and claiming is an operation whose source must be an existing account
that can pay a fee. The recipient, by definition, has none of that when the link is
created. The existing escrow code (`sdk/src/claimableBalance.ts`) serves "pay a Veil
user who is slow to collect"; it does not serve this.

## The decision

**Claimable balance to an ephemeral claimant, with sponsored account creation at claim
time — plus one addition the three candidates as written all missed: the claim also
seeds the recipient's fee-payer account.**

The link carries a single-use ephemeral Stellar secret key. The sender funds a
claimable balance whose claimants are:

1. the ephemeral key — **unconditional** (can claim any time), and
2. the sender — `Not(BeforeAbsoluteTime(deadline))` (reclaim after expiry).

At claim time, three things happen in four small transactions:

```
   sender                      Veil sponsor (server)               recipient's device
     │                                │                                  │
     │ createClaimableBalance         │                                  │
     │   claimant[0]: ephemeral       │                                  │
     │   claimant[1]: sender          │                                  │
     │   (unconditional)  (after deadline)                               │
     │──────────────────────────────────────────────────────────────────>│ taps link
     │                                │                                  │ creates wallet
     │                                │                                  │ (standard create-wallet
     │                                │                                  │  flow → register())
     │                                │ ① beginSponsoring(ephemeral)     │
     │                                │   createAccount(ephemeral, 0)    │
     │                                │   endSponsoring(ephemeral)       │
     │                                │ ② claim → seed fee payer         │ ← signed by the
     │                                │ ③ SAC transfer → C… wallet       │   secret in the link,
     │                                │ ④ merge ephemeral → sponsor      │   fee-bumped by sponsor
     │                                │                                  │
     │                          money is in the new wallet, gas in the    │
     │                          fee payer, ephemeral account gone         │
```

- **① Sponsor creates the ephemeral account** under CAP-33 (`beginSponsoringFutureReserves`
  → `createAccount(ephemeral, 0)` → `endSponsoringFutureReserves`), exactly the bracket
  `frontend/wallet/app/api/sponsor-trustline/route.ts` already uses for trustlines.
  Note the CAP-33 details the route codifies: the bracket's closing
  `endSponsoringFutureReserves` carries the *sponsored* account as its source, and for a
  brand-new account that source's signature **is** required (verified empirically — the
  sponsor-only signature fails `op_bad_auth`; see "Findings that will bite" below).
- **②③④ One secret signs everything in the claim**: the ephemeral key from the link signs
  three inner transactions (claim + fee-payer seed; the native-SAC transfer into the
  wallet; the self-merge back into the sponsor), and Veil's sponsor fee-bumps each one
  so the link amount arrives intact and the recipient's wallet never touches fees.
- The ephemeral account exists for the duration of the claim — seconds — and merges
  away, releasing the borrowed base reserve. **Nothing is stranded.**

The recipient's `C…` wallet address is *counterfactual*: the factory derives it
deterministically from the passkey public key (`sdk/src/utils.ts`
`computeWalletAddress`), so it can receive a native-SAC transfer **before the wallet
contract is ever deployed**. The spike proved exactly that — the transfer in step ③
landed on an address with no deployed contract, no account, and no balance anywhere.

### Why the fee-payer seeding step is part of the decision, not a detail

Veil's two-account model (ADR 0001) means a passkey wallet is gasless: every
transaction is signed by the PRF-derived `G…` fee-payer account (ADR 0003). A brand-new
user's fee payer starts empty, and on mainnet there is no faucet — `deploy()`'s source
account *is* the fee payer (`sdk/src/core.ts`), so a funded `C…` wallet with an empty
`G…` still cannot deploy or spend. The claim therefore carves a seed out of the link
amount and creates the fee-payer account with it (`createAccount`, since classic
`payment` cannot create accounts — see findings).

The arithmetic matters: a Stellar account's minimum balance is **two base reserves,
which is 1 XLM, entirely locked**. A fee payer created with exactly 1 XLM has zero
spendable and cannot pay a fee — an earlier draft of this document seeded 1 XLM and
called the wallet operational, which was wrong, and the transaction-from-fee-payer
check below is what exposed it. The spike seeds **2 XLM: 1 XLM locked in the reserve +
1 XLM spendable gas**, and proves the spendable part is real by submitting a classic
transaction *from the seeded fee payer* — signed by it, fee paid by it, 0.1 XLM paid
out of it (see the proof table). What the fee payer still cannot do on testnet today
is submit the wallet deploy itself: the deployed testnet factory traps on every
`deploy` call (an observed environment failure — see findings #7), which is the repo's
known stale-testnet-factory gap, not a property of this design. On a network whose
factory works, the same seed shape makes the wallet fully operational: balance in the
contract, spendable gas in the fee payer, deploy paid from the fee payer.

## Why the other two candidates were rejected

**1. Ephemeral keypair holding the funds directly — rejected.**
It is strictly dominated by the chosen mechanism. Funding an account per link strands
the base reserve (1 XLM) for the life of every outstanding link and leaves dust
accounts behind on dead links. The chosen mechanism keeps the funds in a claimable
balance — no per-link account exists until the claim starts, and the one account that
is created is destroyed in the same flow. Bearer risk is identical between the two
(see below), so it cannot justify the difference.

**3. Soroban escrow contract keyed by a hash — rejected for now, revisited later.**
It is the better long-term shape (no ephemeral secret in the link at all — the link
could carry a preimage, the contract releases to whoever presents it; reclaim is a
contract call, not a predicate). But: no Veil contract is upgradeable, so a bug in this
contract is permanent; it needs its own review and probably an audit; and it duplicates
machinery — claimable balances already give us expiry-predicates, first-claim-wins
semantics, and a sender reclaim path. The decision is to ship the claimable-balance
mechanism now and record the contract as the candidate to replace it if links become a
significant volume or the bearer risk (below) proves unacceptable in practice.

## What the spike proved (testnet, 2026-11-27)

`node scripts/spikes/link-claim-spike.mjs` — fresh keys every run, complete run ~90s
(93s on the recorded run; longer only when the dev network flakes).
Last full run:

| Step | Result | Evidence |
|---|---|---|
| Recipient verified absent | no `G…` account (Horizon 404), zero SAC balance, `C…` never deployed (no contract instance on-ledger) | pre-claim assertions |
| Sender funds the link | `createClaimableBalance` 25 XLM; claimants: ephemeral (unconditional) + sender (after deadline) | tx on testnet |
| Sponsor creates ephemeral account | CAP-33 bracket, sponsored reserve, `startingBalance: '0'` | tx on testnet |
| Claim + fee-payer seed | claim succeeds; fee-payer `G…` created with 2 XLM — 1 XLM locked reserve (the account minimum is two base reserves) + 1 XLM spendable | `951e49d8…901b1763` (run of 2026-11-27) |
| SAC transfer into the undeployed wallet | native-SAC `transfer` → counterfactual `C…` | `3a8b0d82…a336ecb` |
| Merge back to sponsor | ephemeral account gone (Horizon 404), reserve released | `8bec144c…95f9d4` |
| **A real transaction from the seeded fee payer** | classic `payment` signed AND fee-paid by the fee payer: 0.1 XLM leaves the spendable seed, inclusion fee paid from it | `4dbae08c…4a8a92ee` |
| Wallet deploy via the testnet factory | **blocked on testnet, observed:** the deployed factory `CAUK4…` traps on every `deploy` call — `(WasmVm, InvalidAction)`, even for an off-curve key that should fail validation cleanly. Stale-factory gap (SCF_STRATEGY.md), not a design property | simulation, deterministic across 4 runs |
| Recipient balance confirmed | wallet holds exactly `25 − 2 = 23 XLM` in the SAC; fee payer holds `2 − 0.1 − fees = 1.89999 XLM`, i.e. **0.9 XLM spendable** above the 1 XLM reserve | read back from the SAC + Horizon |
| Reclaim + expiry | second link left unclaimed; after the deadline the sender reclaimed it | `5e16c1fc…031abfa9b` |

The deploy row is the honest limit of what testnet proves today: the fee payer's
ability to transact is demonstrated on-chain, the wallet deploy itself is blocked by
the stale testnet factory (known repo gap), and the claim flow needs no change for
that — the deploy runs unchanged once the factory is redeployed.

### What Veil pays per claim (measured)

| Sponsor step | Charged (stroops) |
|---|---|
| bracket: create the ephemeral account | 300 |
| claim + fee-payer seed (fee-bumped) | 300 |
| SAC transfer into the wallet (fee-bumped) | 151,437 |
| merge the ephemeral away (fee-bumped) | 200 |
| **Total per claim** | **152,237 stroops ≈ 0.0152 XLM** |

The cost is dominated by the Soroban resource fee of the single SAC transfer (inner
fee 177,962 stroops before the 2× fee-bump markup). The base reserve is borrowed and
returned by the merge — it does not appear in the total. At current XLM prices this is
a rounding error per claim; the fee-bump declarations are deliberately generous (2× the
inner fee), and Horizon charged less than declared on every bump, so a production route
can tune these down further.

Separately — and paid by the *recipient*, not Veil — the fee payer spent its own
spendable seed during the proof: 0.1 XLM moved plus a 100-stroop fee for its
transaction. The fee payer's 1 XLM reserve stays locked for the life of the account;
that permanent reserve comes out of the link amount and is part of the seed's purpose.

The sender pays plain classic fees for the link-creating transaction (~100–300
stroops; spike measured 0.00003 XLM across three link transactions) and nothing else —
no reserve is locked, and an unclaimed link costs nothing over time.

## The bearer-risk question, answered explicitly

**The link is a bearer instrument. Whoever holds the ephemeral secret holds the
money. That is inherent to every candidate (including the hash contract, whose link
carries the preimage) and the decision accepts it with mitigations, not magic:**

1. **The secret lives in the URL fragment** (`#…`), which browsers never send to any
   server — no server log, proxy, or referrer header ever sees it. Only things running
   in the recipient's browser/tab context can read the fragment.
2. **Risk window is bounded**: an unclaimed link is reclaimable by the sender after the
   expiry deadline (spike default: configurable, seconds to days). Money in limbo has
   a hard backstop.
3. **Delivery channel is the real control**, and the product must say so: the link
   should travel over a channel the sender already trusts (chat, DM). A payment link
   pasted into a public forum is cash on a table — the UI should present expiry,
   reclaim, and "anyone with this link can take the money" at creation time.
4. **Per-link amounts should stay modest** until the contract-based candidate (option 3)
   can add a second factor (e.g. a claim PIN mixed into the preimage) — that is the
   recorded path to reducing bearer risk structurally rather than procedurally.

## Reclaim and expiry

Covered by the design and proven in the spike; nothing new to build:

- The sender is the second claimant with a `Not(BeforeAbsoluteTime(deadline))`
  predicate — reclaim is the existing `reclaimEscrow()` shape in
  `sdk/src/claimableBalance.ts`, executable any time after the deadline.
- Expiry is enforced by the ledger predicate, not by Veil's infrastructure: a link
  nobody claims reverts to the sender with one classic transaction, and an
  unclaimed link costs nothing in the meantime (no account, no reserve).
- Deadline default and UI warning are product decisions to settle when the claim
  screen is built; the mechanism supports any value.

## Ground rules honored

- **Everything signs through the existing path — and this design barely signs at all.**
  The claim mechanics require no passkey ceremony and no `__check_auth` work: the
  ephemeral key is a classic Ed25519 key signing classic transactions, and the SAC
  transfer's authorization comes from the ephemeral account being the transaction
  source (implicit, no auth entries). The only passkey ceremony in the flow is the
  standard wallet-creation one, which is `signXdrPayload()`-compatible by
  construction. The six-things rule (`__check_auth`'s host function, low-S signature,
  expiration ledger, re-simulated footprint, live fee-payer sequence, 5-element
  vector) is simply not exercised by claiming — there is no address credential to
  sign — and that is a feature: the claim works for a wallet that does not exist yet.
- **`register()` stays in the create-wallet flow.** The claim screen must route a
  wallet-less recipient through the standard create-wallet screens
  (`frontend/mobile/app/create-wallet.tsx` → `createPasskeyWallet()`,
  `frontend/wallet/app/page.tsx` → `wallet.register()` under its existing
  `hasStoredPasskey` guard). The claim flow itself never calls `register()`; it reads
  the resulting address and key id after the normal flow has written them.

## Findings that will bite whoever builds the product flow

These were discovered by the spike and are otherwise undocumented:

1. **Horizon testnet no longer returns `balance_id` on the `create_claimable_balance`
   operation record** — *observed on Horizon testnet* during this spike (post-protocol-23
   response shape there). This is a testnet observation, not a settled protocol fact:
   mainnet and other Horizon deployments were not checked. The spike works around it by
   looking the balance up by claimant:
   `server.claimableBalances().claimant(addr)` and match on amount. The existing
   `createEscrow()` in `sdk/src/claimableBalance.ts` reads `result.balance_id` from the
   transaction response; **if** the same response shape holds on the Horizon deployment
   it runs against, that lookup would come back empty. Verify against the Horizon
   deployment `createEscrow()` actually targets before treating it as a bug — the spike
   only proves the shape on testnet.
2. **Classic `payment` cannot create accounts** (`op_no_destination`); seeding the fee
   payer must use `createAccount`. Its `startingBalance` *includes* the full account
   minimum — **two base reserves, 1 XLM, entirely locked** — so a 1 XLM seed creates an
   account with zero spendable that cannot pay a fee (the first draft of this spike
   seeded 1 XLM; the real-transaction check exposed it). The seed must clear the
   minimum with real spendable gas on top: the spike seeds 2 XLM — 1 XLM locked in the
   reserve, 1 XLM spendable.
3. **The CAP-33 bracket for a brand-new account needs the sponsored account's
   signature on the closing `endSponsoringFutureReserves`** even though the account
   was created earlier in the same transaction — sponsor-only signing fails
   `op_bad_auth`, and putting the sponsored account as the source of `createAccount`
   itself fails `op_malformed`. The working shape is: begin (sponsor source),
   createAccount (sponsor source, destination = sponsored), end (sponsored source),
   co-signed by the ephemeral secret from the link.
4. **Soroban RPC `simulateTransaction` rejects multi-operation transactions**
   ("Transaction contains more than one operation"), so the SAC invoke cannot share a
   transaction with the classic ops — the spike splits the claim into three
   ephemeral-sourced transactions, which also keeps each fee-bump small.
5. **`TransactionBuilder.buildFeeBumpTransaction()` returns an envelope with the fee
   source *unsigned*** — the caller must `.sign(feeSource)` afterwards. The SDK's own
   `signForSubmission()` does this; client code that skips it gets an opaque
   `tx_bad_auth`.
6. **The fee-bump declarations are charged by Horizon at less than declared** on every
   bump in the spike. Production should declare tight-but-safe fees and record actual
   `fee_charged` for cost monitoring.
7. **The deployed testnet factory cannot execute `deploy`** — *observed, not inferred*:
   every `factory.deploy` simulation on testnet traps with `(WasmVm, InvalidAction)`
   ("VM call trapped: UnreachableCodeReached"), deterministically across four runs and
   four fresh keys, and even for an off-curve public key that should return a clean
   `FactoryError::InvalidPublicKey`. The factory wasm on testnet is an older build
   (`soroban-sdk 22.0.11`, exports only `init`/`deploy`) and the repo already records
   the testnet factory as stale relative to `expected-hashes.json`
   (`docs/SCF_STRATEGY.md`, known gap #1). Consequence for this design: the claim
   flow's wallet-deploy step cannot be exercised on testnet until the testnet factory
   is redeployed — the spike proves the fee payer can transact with a classic payment
   instead, and the deploy leg is recorded as blocked-by-environment. This affects
   testnet wallet creation generally, not just links; the mainnet factory verifies.

## What is deliberately not built here

- The `/claim` route in the web wallet and the claim screen in mobile (the link URL
  builder `buildClaimLink()` already points at `app.veil.xyz/claim/{balanceId}`).
- The server route that validates and fee-bumps the recipient-signed claim
  transactions — the shape and the validation checklist are the sponsor-trustline
  route's: re-verify balance id, destinations (wallet `C…`, fee payer `G…`), that the
  merge destination is the sponsor, and that the declared fee is within policy, then
  co-sign and submit.
- Amount caps, expiry defaults, abuse/rate limiting on the sponsor endpoint.
- The option-3 contract and its audit.

The spike script is the reference implementation of the mechanics; the screen and the
route are the next issue's work.

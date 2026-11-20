# Payment-link claim spike — how someone with no wallet claims money from a link

**Status:** decision made; mechanism proven end to end on testnet. No product code written — this document and `scripts/spikes/link-claim-spike.mjs` are the deliverable.
**Date:** 2026-11-20
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
`G…` still cannot deploy or spend. The claim therefore carves a small, configurable
seed (spike: 1 XLM) out of the link amount and creates the fee-payer account with it
(`createAccount`, since classic `payment` cannot create accounts — see findings). The
wallet a person ends up with after claiming is fully operational: balance in the
contract, gas in the fee payer.

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

## What the spike proved (testnet, 2026-11-20)

`node scripts/spikes/link-claim-spike.mjs` — fresh keys every run, complete run ~65s.
Last full run:

| Step | Result | Evidence |
|---|---|---|
| Recipient verified absent | no `G…` account (Horizon 404), zero SAC balance, `C…` never deployed | pre-claim assertions |
| Sender funds the link | `createClaimableBalance` 25 XLM; claimants: ephemeral (unconditional) + sender (after deadline) | tx on testnet |
| Sponsor creates ephemeral account | CAP-33 bracket, sponsored reserve, `startingBalance: '0'` | tx on testnet |
| Claim + fee-payer seed | claim succeeds; fee-payer `G…` created with 1 XLM (incl. its 0.5 reserve) | `54c8a83f…1d88d5cad0` (run of 04:42) |
| SAC transfer into the undeployed wallet | native-SAC `transfer` → counterfactual `C…` | `5e84aab6…8c160bd` |
| Merge back to sponsor | ephemeral account gone (Horizon 404), reserve released | `a7c54dec…21b22fce` |
| Recipient balance confirmed | wallet holds exactly `25 − 1 = 24 XLM` in the SAC; fee payer funded with 1 XLM | read back from the SAC |
| Reclaim + expiry | second link left unclaimed; after the deadline the sender reclaimed it | `c71ebfbe…061a21b22fce` |

### What Veil pays per claim (measured)

| Sponsor step | Charged (stroops) |
|---|---|
| bracket: create the ephemeral account | 300 |
| claim + fee-payer seed (fee-bumped) | 300 |
| SAC transfer into the wallet (fee-bumped) | 121,010 |
| merge the ephemeral away (fee-bumped) | 200 |
| **Total per claim** | **121,810 stroops ≈ 0.0122 XLM** |

The cost is dominated by the Soroban resource fee of the single SAC transfer (~60k
stroops before the 2× fee-bump markup). The base reserve is borrowed and returned by
the merge — it does not appear in the total. At current XLM prices this is a rounding
error per claim; the fee-bump declarations are deliberately generous (2× the inner
fee), and Horizon charged less than declared on every bump, so a production route can
tune these down further.

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

1. **Horizon no longer returns `balance_id` on the `create_claimable_balance` operation
   record** (post-protocol-23 response shape). Look the balance up by claimant:
   `server.claimableBalances().claimant(addr)` and match on amount. The existing
   `createEscrow()` in `sdk/src/claimableBalance.ts` still reads
   `result.balance_id` from the transaction response and is affected by the same
   change — worth a follow-up fix when the claim flow lands.
2. **Classic `payment` cannot create accounts** (`op_no_destination`); seeding the fee
   payer must use `createAccount`. Its `startingBalance` *includes* the 0.5 XLM base
   reserve — of the 1 XLM seed, 0.5 is spendable gas and 0.5 is locked forever.
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

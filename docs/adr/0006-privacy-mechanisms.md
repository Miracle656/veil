# ADR 0006 — Privacy Mechanisms: Which Problem Each One Solves

| Field     | Value                                              |
|-----------|----------------------------------------------------|
| Status    | Accepted — naming and mechanism policy             |
| Date      | 2026-11-21                                         |
| Deciders  | Veil core team                                     |
| Issue     | [#1318](https://github.com/Miracle656/veil/issues/1318) |

---

## Decision

Stealth addresses and the shielded pool are **complementary mechanisms, not
alternatives**. Veil will describe a privacy control by the mechanism actually
behind it, not by the undifferentiated word “private”.

- **Stealth addresses** hide *who was paid*. They hide nothing about payment
  amounts.
- A **shielded pool** hides *how much* is moved inside the pool. A shielded
  pool does not by itself hide every public actor or every public phase of a
  transfer.
- **Together**, stealth addresses and a shielded pool can hide both the
  recipient identity and the in-pool amount. They do not remove public
  transaction fees, timestamps, pool deposits or withdrawals, or other
  transaction metadata.

This decision supersedes the blanket label “private” only for privacy
presentation. The existing cost and threat documents remain scoped to the
Nethermind/SDF Stellar Private Payments (SPP) pool; they do not describe stealth
addresses. Issues [#713](https://github.com/Miracle656/veil/issues/713),
[#715](https://github.com/Miracle656/veil/issues/715),
[#718](https://github.com/Miracle656/veil/issues/718),
[#721](https://github.com/Miracle656/veil/issues/721),
[#724](https://github.com/Miracle656/veil/issues/724),
[#1202](https://github.com/Miracle656/veil/issues/1202), and
[#1203](https://github.com/Miracle656/veil/issues/1203) belong to the shielded
pool work unless an issue explicitly says otherwise.

## Observer view

### Stealth addresses

An observer still sees:
- the public sender or fee-payer account used for the transaction;
- the public one-time payment address;
- the asset and exact amount;
- the fee, ledger, timestamp and transaction structure.

The one-time address prevents a straightforward published-address → recipient
link, but it does not hide the payment amount or the fact that the public payer
funded the transaction.

### Shielded pool

An observer still sees:
- public shield deposits and public unshield withdrawals;
- which public account and pool participate in a public deposit or withdrawal;
- pool usage timing, transaction fees and ledger metadata;
- pool-membership and anonymity-set limits;
- who the pool operator or a global-view-key holder can identify, if that
  pool is configured to expose such authority.

Inside a successful private pool transfer, the observer does not learn the
in-pool amount or the pool recipient from the pool proof. That is not the same
as hiding every public participant.

### Stealth plus shielded pool

An observer still sees:
- public amounts and participants in shield/unshield phases;
- public fees, timestamps and pool activity;
- links that remain available in public funding, withdrawal or operator data;
- anonymity-set limits and use of a pool view key, if applicable.

When both are used for a private pool send, the sender/recipient linkage and
the in-pool amount are protected by different mechanisms. They compose, but
they do not make the whole ledger or wallet history invisible.

## Controls in the app today

This table is based on the current code, not the issue plan.

| Control | Mechanism today | Honest status |
|---|---|---|
| Web “Private Send”, “Shield into private balance”, and “Unshield Funds” | Intended to be the Nethermind/SDF shielded pool (`frontend/wallet/lib/privacy/client.ts`) | SPP is testnet-only and behind `NEXT_PUBLIC_PRIVACY_FEATURE_FLAG`; mainnet is forced off in `frontend/wallet/lib/privacy/config.ts`. The controls require the web SPP client and have not produced a verified app proof. |
| Web Privacy settings “Open Private Send” / “Unshield Funds” | Shielded pool | Testnet-only SPP links; no stealth implementation (`frontend/wallet/app/settings/privacy/page.tsx`) |
| Mobile “Shielded transfers” and mobile shield/send/unshield preview | No working mechanism | Mobile explicitly reports no SPP client and returns `ENGINE_PENDING_MESSAGE` (`frontend/mobile/lib/privacy.ts`); shield/send/unshield do not sign or broadcast (`frontend/mobile/app/privacy/shield.tsx`, `send.tsx`, `unshield.tsx`). |
| Stealth-address controls | No mechanism | There is no stealth-address implementation or control in the repo today. |

Every privacy control must name the mechanism in its UI copy. Use:

- **“Private pool send”** — SPP shielded pool;
- **“Stealth payment”** — stealth address only;
- **“Private pool send to a stealth address”** — both mechanisms.

Do not label an SPP deposit or an ordinary send “private” when the pool or
stealth mechanism is not actually used. Deposit and withdrawal actions must say
that the public chain phase remains visible. Mobile controls that do not work
must say “preview” or “not available”; they must not imply that a proof or
payment occurred.

## Mainnet stealth cost

**No measured mainnet stealth-payment figure is present in the repo.** The
existing mainnet transaction hashes in `docs/SCF_STRATEGY.md` prove ordinary
wallet and passkey operations, not stealth payments, and must not be reused as
stealth cost evidence.

TODO(measure on mainnet): use one or more real stealth payments and list the
full transaction hashes, base fee paid, XLM reserves for every ledger entry or
account created per payment, and the fee payer's charged fee.

TODO(measure on mainnet): measure whether the recipient must hold a base reserve
before sweeping, the XLM reserve added to the recipient account or note
account, and the reserve released or retained after the sweep.

TODO(measure on mainnet): measure the sweep transaction fee and whether any
intermediate claim or merge transaction adds another fee or reserve.

There is no repo script identified as a dedicated stealth mainnet measurement.
The general `scripts/smoke_test.ts` flow proves current wallet operations, and
the shielded-pool live test command in `docs/PRIVACY_COST.md` measures SPP testnet
pool submissions only. Neither may claim to measure a stealth payment. This
blocks the acceptance criterion for a measured stealth per-payment cost.

## Why finish the shielded pool

Stealth addresses and a shielded pool solve different privacy questions. A
working stealth address flow should ship first if it reaches mainnet sooner,
but it does not remove the amount-privacy gap.

The shielded pool remains worth finishing because it:
- hides transfer amounts and pool recipients inside the pool;
- provides disclosure and compliance workflows, including the pool's view-key
  and association-set mechanisms;
- composes with stealth addresses for both identity and amount privacy;
- shares a canonical Nethermind/SDF pool rather than requiring Veil to build
  and audit its own circuits and contracts.

The integration is not cheap: it needs a prover, circuits, a bootnode, a trusted
setup upstream of Veil, and a SPP audit before mainnet. It is currently
unaudited and testnet-only. Repo evidence also says no proof has been produced
by the app in [#1202](https://github.com/Miracle656/veil/issues/1202) and
[#1203](https://github.com/Miracle656/veil/issues/1203); that is a
proof-and-integration gap, not a reason to call existing controls “private”.

## Consequences

- Issue work must be labeled as stealth or pool work, because [#713],
  [#715], [#718], [#721], [#724], [#1202], and [#1203] are a mix of pool
  integration pieces rather than an undifferentiated privacy backlog.
- UI copy must state the mechanism or state that no mechanism is working.
- A measured stealth mainnet cost is an acceptance gate before a stealth
  payment is advertised as shipped.
- The pool can ship later than stealth addresses, but it remains necessary for
  amount-hiding privacy and for a combined identity-and-amount design.

## Open questions

- What exact one-time-account or claim protocol is intended for Veil stealth
  payments, and whether recipient reserve/costs differ by account creation?
- When, if ever, will a completed stealth payment provide a measured mainnet
  transaction record with full hashes?
- Which authority can see pool amounts and identity data under a mainnet
  SPP deployment, and which view-key mode Veil would present?

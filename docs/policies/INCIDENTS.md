# Incidents and reimbursement

What we do when a user loses money, or loses access to it.

Veil is non-custodial. We never hold a user's keys and cannot move their
funds, reverse a payment, or reach into an account. That is a fact about how
the wallet works, and it is not a reason to do nothing when our software is
what caused a loss.

## What counts as an incident

- A user cannot reach money that is theirs.
- Money moved somewhere the user did not intend, because of what the app
  showed or did.
- A defect that would cause either of the above, found before it has.
- Anything that stops new users creating a wallet, or existing users paying.

## What we do, in order

1. **Stop it getting worse.** If money is still arriving at an address nobody
   can sign for, tell the user to stop the sender first. Everything else waits.
2. **Establish the facts from the chain**, not from memory or from a date.
   Addresses, balances, the last transaction each key signed. Compare the
   addresses the user's passkey actually derives against the one holding the
   funds before telling them anything is recoverable.
3. **Tell the user what we know, what we do not, and what we got wrong.** If
   an earlier message from us was wrong, correct it in the next one.
4. **Fix the cause**, with a test built from the incident's own figures.
5. **Write it down** in `docs/incidents/`, without the user's name.
6. **Check who else is exposed** and warn them before they find out the way
   the first user did.

## Response times

| | Target |
|---|---|
| First reply to a user reporting lost money or access | 24 hours |
| Facts established and shared with the user | 72 hours |
| Decision on reimbursement | 7 days from the report |

## What users should and should not send us

- Send: wallet addresses (`C…` and `G…`), screenshots, the "Copy for bug
  report" text from the fee-payer settings screen. None of it is secret.
- Never send: a secret key (56 characters starting with `S`), a recovery
  phrase, or a passkey. We will never ask for one. Anyone who does is not us.

## Reimbursement

**Decision needed.** Everything in this section is a proposal for the project
owner to confirm or change. Nothing here is a commitment until then.

### When we reimburse (proposed)

We reimburse a loss out of goodwill when all of these hold:

1. The loss was caused by a defect in Veil's software, not by the user sharing
   a key, sending to a wrong address they typed, or a third party's failure.
2. The user used the app the way it told them to. "Your passkey is your
   account" means a user who saved no key did nothing wrong.
3. The loss can be verified on the chain.
4. It was reported within 90 days of the user being able to notice it.

### What we do not reimburse (proposed)

- Losses from a secret key or passkey the user gave to someone else.
- Payments sent to the wrong address by the user or a third party.
- Changes in the price of an asset.
- Failures of a payment provider, exchange or bank. We help chase those.
- Money sent to a stuck address after we told the user to stop the sender.

### Amounts (proposed)

| | Proposal |
|---|---|
| Per incident | The verified amount, up to 100 USDC equivalent |
| Above that | Decided case by case by the project owner |
| Paid in | USDC on Stellar, to an address the user controls and has confirmed |
| Paid from | A project wallet set aside for this. Never from another user's funds |

Veil has no insurance and no reserve fund today. A cap exists so that a
promise we make is one we can keep.

### Who decides (proposed)

The project owner. A reimbursement is recorded in the incident file with the
amount and the transaction hash.

## Public disclosure

- A defect that lost a user money is disclosed in the release notes of the
  build that fixes it, in plain words.
- A defect that could be used by an attacker is not described publicly until
  the fix has shipped. See `SECURITY.md`.
- We do not name affected users or publish their addresses in the incident
  record. Addresses are public on the chain, but connecting one to a story
  about a person is our choice, and we choose not to.

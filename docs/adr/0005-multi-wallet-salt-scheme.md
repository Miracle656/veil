# ADR 0005 — Multi-Wallet Salt Scheme (decided now, shipped later)

| Field     | Value                                        |
|-----------|----------------------------------------------|
| Status    | Accepted — scheme fixed; implementation deferred |
| Date      | 2026-10-22                                   |
| Deciders  | Veil core team                               |
| Relates   | `docs/CONTRACTS_V2.md` §6, ADR 0001, ADR 0003 |

---

## Context

A wallet's address is the deployer-derived contract address of the factory
salted with `SHA-256(public_key)` — the factory computes the salt itself in
`deploy()` (`contracts/factory/src/lib.rs`, step 3), so one passkey maps to
exactly one wallet and `AlreadyDeployed` refuses a second. §6 of
`docs/CONTRACTS_V2.md` leaves multi-wallet open and proposes
`SHA-256(public_key ‖ index)` with index 0 keeping today's address.

Two facts shape the decision:

1. **The salt scheme is one-shot.** Whatever rule maps `(public_key, index)`
   to a salt becomes part of every user's address the moment the first
   multi-wallet deploys. Changing it afterwards strands funds at addresses no
   client derives any more. So the scheme must be written down *before* anyone
   ships one, even if nobody ships one soon — that is this ADR.
2. **The deployed factory cannot change.** `deploy()` takes no index and the
   deployed code has no upgrade path, so any multi-wallet factory is a new
   factory at a new address. (The `set_wasm_hash` added for #1171 swaps the
   *wallet* code a factory deploys; it cannot add a parameter to the factory's
   own interface.)

## Decision

### The scheme (fixed now)

For uncompressed P-256 public key `pk` (65 bytes, `0x04`-prefixed — the only
shape `validate_public_key` accepts) and wallet index `i`:

```
salt(pk, 0) = SHA-256(pk)                     // today's salt, by definition
salt(pk, i) = SHA-256(pk ‖ be32(i))  for i ≥ 1
```

where `be32(i)` is the index as exactly 4 big-endian bytes. The wallet address
remains the deployer-derived address of (factory, salt), unchanged in formula.

- **Index 0 is not `SHA-256(pk ‖ be32(0))`.** It is *defined* as the bare
  `SHA-256(pk)`, byte-identical to what the deployed factory computes today, so
  every existing wallet — including every wallet holding money on mainnet — is
  retroactively "index 0 of its key" without moving. A test in
  `contracts/factory/src/lib.rs` (`multi_wallet_index_zero_salt_is_todays_salt`)
  pins this: the ADR's index-0 salt deploys to the same address `deploy()`
  produces for the same key.
- The 4-byte fixed-width index means no two `(pk, i)` pairs can collide by
  concatenation ambiguity (a variable-length index could make
  `pk ‖ "1" ‖ "2"` meet `pk ‖ "12"`), and bounds the scheme at 2³² wallets per
  key, which is not a real limit.
- The domain stays separated from every other hash in the system: fee-payer
  derivation hashes PRF output (ADR 0003), breadcrumbs hash nothing, and the
  factory's salt input is either 65 or 69 bytes — never confusable.

### Implementation: not now

Nothing ships today beyond this document and the pinning test. Reasons, in
order of weight:

1. **No demonstrated demand.** §6 itself says to ask users what they want
   multi-wallet *for*; the one concrete motive raised so far — separating
   savings — is already served by the vault contract. Shipping a second wallet
   per passkey before a use-case exists adds a switcher, a recovery scan and a
   migration story to every client for nobody.
2. **The salt is the easy third of the work.** A real multi-wallet needs:
   - a **per-index fee payer** — the PRF salt (`invisible-wallet/prf/feepayer/v1`)
     is index-blind, so index 1 would today share index 0's fee payer and its
     spending history; a `/v2/<index>` PRF-salt family has to be designed with
     the same care ADR 0003 applied to v1;
   - **per-index breadcrumbs** — `veil:pk1`/`veil:pk2` on the fee payer
     (#1177's invariant) record one wallet; a second wallet on the same
     fee payer has nowhere to write itself without a new naming scheme, and a
     second fee payer doubles the user's locked reserves;
   - **index discovery on recovery** (scan 0, 1, 2… to the first empty) and a
     **wallet switcher** on web and mobile — client surface on two codebases.
3. **A new factory is a mainnet event.** The factory address is pinned in two
   clients, the breadcrumbs verifier, and users' muscle memory; redeploying it
   is the kind of change that should ride a batch of v2 work (ideally the §9
   OpenZeppelin decision), not go out alone for a speculative feature.

### What would change this

Any of: (a) real user requests that the vault contract demonstrably does not
cover; (b) the v2 factory being redeployed anyway, at which point adding
`deploy_with_index(public_key, index, rp_id, origin)` implementing this scheme
costs almost nothing; (c) a product decision to separate spending identities
(e.g. a "work wallet") that needs distinct addresses rather than distinct
balances.

When that happens, the implementation inherits this scheme as written — the
decision that must not be remade under deadline is already made here.

## Client implications (written for the future implementer)

- **Existing users are untouched.** Their wallet *is* index 0; no migration, no
  address change, no re-registration. A client that never grows multi-wallet
  support keeps working against a multi-wallet factory, because plain
  `deploy(pk)` and `salt(pk, 0)` coincide.
- **Recovery** becomes a scan: derive index 0, check on-chain existence, then
  index 1, … stopping at the first index that has never deployed. Gaps must be
  impossible, so the factory must refuse `deploy_with_index(pk, i)` unless
  `i == 0` or index `i − 1` exists.
- **Display**: a switcher lists indices with balances; index 0 is "Main". A
  client must never label index 0 anything that implies it is new — it is the
  user's existing wallet.
- **Fee payers and breadcrumbs** follow the per-index designs above; until
  those exist, no client may deploy an index ≥ 1 even against a factory that
  allows it, because the wallet would be unrecoverable by #1177's standard.

## Consequences

- The irreversible choice (the address formula) is locked in while there is no
  deadline pressure, with a test pinning its only compatibility invariant.
- The reversible choice (whether and when to ship) stays open, with its
  triggers named.
- `docs/CONTRACTS_V2.md` §6's "Decide multi-wallet" checkbox is resolved:
  **scheme yes, feature not now.**

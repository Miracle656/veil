# Mainnet Readiness

This note tracks security findings from the 2026-08-05 external assessment. It is not a
claim that all findings are closed.

## Findings

| ID | Description | Status |
|----|-------------|--------|
| M1 | `authData` flags validation | Open |
| M2 | Ceremony type validation | Open |
| M3 | On-curve public-key validation in production WASM | Fixed in future factory deployments |
| C4 | Authentication on `factory.init` | Fixed in source; deployment must be verified |

The following findings remain open: C2 (credential-id key derivation), C3 (localStorage S-key),
H2, H4, and M4-M7.

## M3 - On-curve public-key validation

`contracts/factory/src/validation.rs` now calls
`p256::ecdsa::VerifyingKey::from_sec1_bytes` unconditionally. The production dependency uses
`default-features = false` with the `ecdsa` feature, so the check compiles for
`wasm32-unknown-unknown` without enabling `std` or pulling in the incompatible default
`getrandom` path.

This change applies only to factories deployed from the new WASM. Soroban contracts are not
upgradeable. The factory already deployed on mainnet retains its previous code, so closing M3
for mainnet requires deploying this build as a new factory at a new address and updating users
to that address.

### Evidence and release artifacts

- A testnet transaction proving rejection of `0x04 || 0x01*64` with `InvalidPublicKey` has not
  yet been recorded. The acceptance criterion remains open.
- The PR review measured the factory WASM at 4,249 bytes before this change and 24,911 bytes
  after it: +20,662 bytes, approximately 5.9x. This increase requires an explicit decision
  against the constraints in [`wasm-size-optimization.md`](wasm-size-optimization.md).
- `contracts/expected-hashes.json` must be updated with the factory hash from the reproducible
  CI build. A local build hash is not canonical and must not be used for that update.

## Remaining pre-mainnet work

1. Deploy the new factory to testnet and record the invalid-key rejection transaction.
2. Run the pinned reproducible build and update `contracts/expected-hashes.json` from its CI log.
3. Resolve the remaining audit findings and complete legal, monitoring, and operational sign-off.

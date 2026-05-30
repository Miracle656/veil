# Veil Wallet — Formal Proof Harnesses

This document describes the Kani proof harnesses in
`contracts/invisible_wallet/src/proofs.rs`.

## What is Kani?

[Kani](https://model-checking.github.io/kani/) is a bit-precise model checker
for Rust.  Unlike fuzzing it exhaustively explores all possible inputs within
a bounded state space, so a passing proof is stronger than a passing fuzz run.

The harnesses are gated behind `#[cfg(kani)]` so they have zero impact on the
production binary or normal `cargo test` runs.

## Running locally

```bash
cargo install kani-verifier
cargo kani --harness proof_low_s_invariant
cargo kani --harness proof_nonce_monotonicity
cargo kani --harness proof_session_key_expiry
```

## Harnesses

| Harness | Invariant | File |
|---|---|---|
| `proof_low_s_invariant` | ECDSA signatures must have low-S (s ≤ n/2). A high-S value indicates tampering. | `src/proofs.rs` |
| `proof_nonce_monotonicity` | After each successful `__check_auth`, the stored nonce increases by exactly 1 and never overflows. | `src/proofs.rs` |
| `proof_session_key_expiry` | A session key with `expiry < now` is always rejected; a key is valid at exactly its expiry second. | `src/proofs.rs` |

## Future harnesses

- `proof_allowance_deduction` — spending never reduces allowance by more than the requested amount.
- `proof_signer_count_nonzero` — `remove_signer` never reduces signers below 1.
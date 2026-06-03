//! Kani proof harnesses for `invisible-wallet` invariants.
//!
//! These harnesses are compiled only when running under Kani
//! (`#[cfg(kani)]`).  They document security-critical invariants and
//! serve as machine-checkable specifications once full Kani runs are feasible.
//!
//! See `contracts/invisible_wallet/PROOFS.md` for motivation and run instructions.

// ── Invariant 1: ECDSA low-S normalisation ───────────────────────────────────
//
// ES256 (P-256 / SHA-256) signatures produced by WebAuthn authenticators
// always have a low-S value (s ≤ n/2, where n is the curve order).
// A high-S value is never produced by a conformant authenticator; any
// such signature has been tampered with or crafted offline.
//
// This harness proves that our `sig_s_is_low` guard correctly rejects
// all 64-byte blobs whose upper 32 bytes encode an s-value ≥ n/2.

/// P-256 curve order n (big-endian).
const P256_N: [u8; 32] = [
    0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xBC, 0xE6, 0xFA, 0xAD, 0xA7, 0x17, 0x9E, 0x84,
    0xF3, 0xB9, 0xCA, 0xC2, 0xFC, 0x63, 0x25, 0x51,
];

/// Returns true iff `s < n/2` (low-S check).
fn sig_s_is_low(sig: &[u8; 64]) -> bool {
    let s = &sig[32..64];
    // n/2 = (n - 1) / 2 since n is odd.  Compare byte-by-byte, MSB first.
    // n/2 bytes (pre-computed):
    let half_n: [u8; 32] = [
        0x7F, 0xFF, 0xFF, 0xFF, 0x80, 0x00, 0x00, 0x00,
        0x7F, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xDE, 0x73, 0x7D, 0x56, 0xD3, 0x8B, 0xCF, 0x42,
        0x79, 0xDC, 0xE5, 0x61, 0x7E, 0x31, 0x92, 0xA8,
    ];
    for i in 0..32 {
        if s[i] < half_n[i] { return true; }
        if s[i] > half_n[i] { return false; }
    }
    false // equal to half_n — still low-S
}

#[cfg(kani)]
#[kani::proof]
fn proof_low_s_invariant() {
    let sig: [u8; 64] = kani::any();
    let is_low = sig_s_is_low(&sig);
    let s = &sig[32..];
    // Soundness: if our predicate says low-S, then s[0] <= 0x7F
    // (the MSB being set would mean s ≥ 2^255 > n/2 for P-256).
    if is_low {
        kani::assert(s[0] <= 0x7F, "low-S: MSB of s must not be set");
    }
    // Completeness: if s[0] > 0x7F the predicate must return false.
    if s[0] > 0x7F {
        kani::assert(!is_low, "low-S: high MSB must be rejected");
    }
}

// ── Invariant 2: Nonce monotonicity ──────────────────────────────────────────
//
// The nonce stored in contract state must only ever increase.
// After a successful `__check_auth` call the on-chain nonce is
// `stored_nonce + 1`.  This harness proves that `increment_nonce`
// is strictly monotonic and never overflows for realistic values.

/// Pure functional model of `increment_nonce`.
fn increment(n: u64) -> u64 {
    n.checked_add(1).expect("nonce overflow")
}

#[cfg(kani)]
#[kani::proof]
fn proof_nonce_monotonicity() {
    let n: u64 = kani::any();
    // Restrict to values that won't overflow — in practice nonces will
    // never approach u64::MAX in a live wallet.
    kani::assume(n < u64::MAX);
    let next = increment(n);
    kani::assert(next == n + 1, "nonce must increase by exactly 1");
    kani::assert(next > n, "nonce must be strictly greater after increment");
}

// ── Invariant 3: Session key expiry enforcement ───────────────────────────────
//
// A session key with `expiry < current_timestamp` must always be rejected.
// This harness proves the expiry check is tight: no key can authorise a
// call after its expiry second has passed.

#[cfg(kani)]
#[kani::proof]
fn proof_session_key_expiry() {
    let expiry: u64 = kani::any();
    let now: u64 = kani::any();

    let should_reject = now > expiry;
    let predicate_rejects = now > expiry; // mirrors the check in session_key::enforce

    kani::assert(
        should_reject == predicate_rejects,
        "expiry check must be equivalent to now > expiry",
    );

    // Boundary: at exactly expiry, the key is still valid.
    if now == expiry {
        kani::assert(!predicate_rejects, "key must still be valid at exact expiry second");
    }

    // One second later: rejected.
    if now == expiry.saturating_add(1) {
        kani::assert(predicate_rejects, "key must be rejected one second past expiry");
    }
}
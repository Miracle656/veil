//! Expiration handling for time-bound credentials (session keys, allowances).
//!
//! # Why a dedicated module
//!
//! Several credentials in this wallet carry a wall-clock expiry: session keys
//! (`SessionKeyAcl::expiry`) and token allowances (`Allowance::expiry`). Each one
//! is rejected once it has expired during `__check_auth`. Centralising the
//! comparison here means the expiry semantics — and the clock-skew tolerance
//! described below — are defined in exactly one place and unit-tested in
//! isolation, rather than duplicated as inline `now > expiry` checks.
//!
//! # What the expiry value means, and where skew comes from
//!
//! The comparison is performed against [`soroban_sdk::Ledger::timestamp`], the
//! Unix timestamp of the ledger that is closing. That timestamp is part of
//! consensus: every validator that votes on a given ledger sees the **same**
//! value, so there is no validator-to-validator skew on the *contract* side. A
//! strict `now > expiry` comparison is therefore correct and deterministic
//! on-chain.
//!
//! The skew the wallet has to defend against is entirely **client-side**. A
//! client typically picks an expiry by reading its local wall clock and, for
//! ledger-bound credentials, projecting forward with an assumed ledger rate
//! (~5 s/ledger). Two independent errors creep in:
//!
//!   * the client's local clock can drift from network time, and
//!   * the real ledger close rate varies, so a "valid until ledger N" target
//!     converted back to seconds does not land on an exact second.
//!
//! When the intended lifetime is short, those errors can place the stored
//! `expiry` a few seconds *before* the moment the user actually expects the
//! credential to still work, producing a spurious `SessionKeyExpired` /
//! `AllowanceExpired` rejection at the boundary.
//!
//! # The fix: a small, bounded grace window
//!
//! [`is_expired`] treats a credential as expired only once `now` is past
//! `expiry` extended by [`CLOCK_SKEW_TOLERANCE_SECS`]. This absorbs the
//! client-side estimation error above while keeping the relaxation small,
//! fixed, and auditable — a credential never lives more than the tolerance
//! beyond its stated expiry. Callers that need the exact, un-graced boundary
//! (for documentation or assertions) can use [`is_expired_strict`].
//!
//! The grace window only ever *extends* validity; it can never cause an
//! unexpired credential to be rejected, so it cannot weaken any check other
//! than expiry, and it does so by at most a bounded, constant amount.

use crate::WalletError;

/// Grace period, in seconds, added to every wall-clock expiry comparison to
/// absorb client-side clock skew and ledger-rate estimation error.
///
/// Chosen as 60 s: comfortably larger than realistic client clock drift and
/// ledger-rate rounding for short-lived credentials, yet small enough that the
/// extra validity window is operationally negligible (and never a substitute
/// for explicit revocation via [`crate::session_key::revoke`]).
pub const CLOCK_SKEW_TOLERANCE_SECS: u64 = 60;

/// Returns `true` iff `now` is strictly past `expiry` extended by
/// [`CLOCK_SKEW_TOLERANCE_SECS`].
///
/// `expiry` and `now` are both Unix timestamps in seconds. The grace window is
/// added with a saturating add so an `expiry` near `u64::MAX` cannot overflow
/// (it simply never expires, which is the intended behaviour for a maximal
/// expiry).
#[inline]
pub fn is_expired(now: u64, expiry: u64) -> bool {
    now > expiry.saturating_add(CLOCK_SKEW_TOLERANCE_SECS)
}

/// Strict expiry comparison with **no** clock-skew tolerance: `now > expiry`.
///
/// Exposed for callers and tests that need the exact ledger-timestamp boundary
/// (the on-chain comparison described in the module docs). Production auth
/// paths use [`is_expired`] so that the documented tolerance is applied.
#[inline]
pub fn is_expired_strict(now: u64, expiry: u64) -> bool {
    now > expiry
}

/// Map an expiry check to a `Result`, returning `err` when the credential has
/// expired (with tolerance applied).
///
/// Lets each caller surface its own error variant (`SessionKeyExpired`,
/// `AllowanceExpired`, …) while keeping the comparison logic in one place.
#[inline]
pub fn ensure_not_expired(now: u64, expiry: u64, err: WalletError) -> Result<(), WalletError> {
    if is_expired(now, expiry) {
        Err(err)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A representative expiry; values are timestamps in seconds.
    const EXPIRY: u64 = 1_000_000;

    // ── Boundary behaviour with tolerance ─────────────────────────────────────

    #[test]
    fn not_expired_before_expiry() {
        assert!(!is_expired(EXPIRY - 1, EXPIRY));
    }

    #[test]
    fn not_expired_exactly_at_expiry() {
        // At the stated expiry the credential is still considered valid:
        // the comparison is strictly-greater-than.
        assert!(!is_expired(EXPIRY, EXPIRY));
    }

    #[test]
    fn not_expired_one_second_past_expiry_within_grace() {
        // The whole point of the grace window: a credential one second past its
        // stated expiry (e.g. due to client clock skew) is NOT rejected.
        assert!(!is_expired(EXPIRY + 1, EXPIRY));
    }

    #[test]
    fn not_expired_at_edge_of_grace_window() {
        assert!(!is_expired(EXPIRY + CLOCK_SKEW_TOLERANCE_SECS, EXPIRY));
    }

    #[test]
    fn expired_one_second_past_grace_window() {
        // One second beyond the grace window the credential is finally expired.
        assert!(is_expired(EXPIRY + CLOCK_SKEW_TOLERANCE_SECS + 1, EXPIRY));
    }

    #[test]
    fn expired_far_past_expiry() {
        assert!(is_expired(EXPIRY + 10_000, EXPIRY));
    }

    // ── Strict boundary (no tolerance) ────────────────────────────────────────

    #[test]
    fn strict_boundary_is_exact() {
        assert!(!is_expired_strict(EXPIRY - 1, EXPIRY));
        assert!(!is_expired_strict(EXPIRY, EXPIRY));
        assert!(is_expired_strict(EXPIRY + 1, EXPIRY));
    }

    // ── Overflow safety ───────────────────────────────────────────────────────

    #[test]
    fn max_expiry_never_expires() {
        // A maximal expiry plus the grace window must not overflow; the
        // credential simply never expires.
        assert!(!is_expired(u64::MAX, u64::MAX));
        assert!(!is_expired(u64::MAX - 1, u64::MAX));
    }

    #[test]
    fn zero_expiry_is_expired_after_grace() {
        assert!(!is_expired(CLOCK_SKEW_TOLERANCE_SECS, 0));
        assert!(is_expired(CLOCK_SKEW_TOLERANCE_SECS + 1, 0));
    }

    // ── Result helper ─────────────────────────────────────────────────────────

    #[test]
    fn ensure_not_expired_maps_error() {
        assert_eq!(
            ensure_not_expired(EXPIRY, EXPIRY, WalletError::SessionKeyExpired),
            Ok(())
        );
        assert_eq!(
            ensure_not_expired(
                EXPIRY + CLOCK_SKEW_TOLERANCE_SECS + 1,
                EXPIRY,
                WalletError::SessionKeyExpired
            ),
            Err(WalletError::SessionKeyExpired)
        );
        // The caller's chosen variant is propagated unchanged.
        assert_eq!(
            ensure_not_expired(
                EXPIRY + CLOCK_SKEW_TOLERANCE_SECS + 1,
                EXPIRY,
                WalletError::AllowanceExpired
            ),
            Err(WalletError::AllowanceExpired)
        );
    }
}

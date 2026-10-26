//! Signer recovery.
//!
//! # One slot, two ways in (#1182)
//!
//! The wallet has two recovery systems, and both are kept on purpose:
//!
//! * **Guardian**: `set_guardian` / `initiate_recovery` / `complete_recovery`,
//!   3-day timelock. A party the owner trusts (another account they hold, a
//!   friend, a custodian) vouches for a new signer. This is the path the web
//!   docs describe for key rotation.
//! * **Recovery key**: `set_recovery_key` / `request_recovery` /
//!   `finalize_recovery`, 7-day timelock. The address is normally controlled by
//!   SEP-30 recovery servers that co-sign after re-verifying the owner's
//!   identities; it is what the mobile app uses after device loss.
//!
//! Removing either would break the client built on it, and the two answer
//! different "who vouches for me" questions. What nobody chose is that they
//! ran independently: both could be pending at once, racing two timelocks,
//! and each cancel only saw its own. So the two systems now share **one
//! recovery slot**:
//!
//! * Starting a recovery in either system fails while *either* is pending,
//!   with an error naming the system that holds the slot
//!   (`GuardianRecoveryPending` or `RecoveryKeyRequestPending`). Every write
//!   of `RecoveryPending` / `RecoveryKeyPending` goes through [`claim_slot`],
//!   which checks both, so at most one of the two keys is ever set.
//! * Cancelling through either `cancel_recovery` or `cancel_recovery_request`
//!   clears the slot whichever system holds it, so an owner who cancels has
//!   nothing left counting down. `get_pending_recovery` reports what, if
//!   anything, is pending and from which system.
//! * Completing through the other system's entrypoint names the system that
//!   holds the slot instead of claiming that nothing is pending.
//!
//! The two delays are unchanged; changing them is a separate decision.

use soroban_sdk::{contracttype, symbol_short, Address, BytesN, Env};

use crate::storage::{DataKey, PendingRecovery};
use crate::WalletError;

/// 7-day timelock in seconds.
pub const RECOVERY_KEY_DELAY: u64 = 604_800;

/// Which recovery system holds the wallet's single recovery slot.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RecoverySource {
    /// Started by the guardian through `initiate_recovery`.
    Guardian,
    /// Started by the recovery key through `request_recovery`.
    RecoveryKey,
}

/// What `get_pending_recovery` reports about the slot.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRecoveryStatus {
    pub source: RecoverySource,
    pub new_public_key: BytesN<65>,
    pub recovery_unlock_time: u64,
}

fn slot_key(source: RecoverySource) -> DataKey {
    match source {
        RecoverySource::Guardian => DataKey::RecoveryPending,
        RecoverySource::RecoveryKey => DataKey::RecoveryKeyPending,
    }
}

fn held_error(source: RecoverySource) -> WalletError {
    match source {
        RecoverySource::Guardian => WalletError::GuardianRecoveryPending,
        RecoverySource::RecoveryKey => WalletError::RecoveryKeyRequestPending,
    }
}

/// The pending recovery, if any, and which system started it.
pub fn pending(env: &Env) -> Option<PendingRecoveryStatus> {
    for source in [RecoverySource::Guardian, RecoverySource::RecoveryKey] {
        let stored: Option<PendingRecovery> = env.storage().persistent().get(&slot_key(source));
        if let Some(p) = stored {
            return Some(PendingRecoveryStatus {
                source,
                new_public_key: p.new_public_key,
                recovery_unlock_time: p.recovery_unlock_time,
            });
        }
    }
    None
}

/// Record a new pending recovery for `source` and return its unlock time.
/// The only writer of either pending key: it refuses while the slot is held
/// by either system.
pub fn claim_slot(
    env: &Env,
    source: RecoverySource,
    new_public_key: &BytesN<65>,
    delay: u64,
) -> Result<u64, WalletError> {
    if let Some(held) = pending(env) {
        return Err(held_error(held.source));
    }
    let recovery_unlock_time = env.ledger().timestamp() + delay;
    let record = PendingRecovery {
        new_public_key: new_public_key.clone(),
        recovery_unlock_time,
    };
    env.storage().persistent().set(&slot_key(source), &record);
    Ok(recovery_unlock_time)
}

/// The pending recovery that `source` may complete. If the slot is held by
/// the other system, say so rather than reporting that nothing is pending.
pub fn pending_for(env: &Env, source: RecoverySource) -> Result<PendingRecovery, WalletError> {
    match pending(env) {
        None => Err(WalletError::RecoveryNotPending),
        Some(held) if held.source != source => Err(held_error(held.source)),
        Some(held) => Ok(PendingRecovery {
            new_public_key: held.new_public_key,
            recovery_unlock_time: held.recovery_unlock_time,
        }),
    }
}

/// Clear the slot, whichever system holds it, and return which one that was.
/// Callers must already have required the wallet's own authorisation.
pub fn cancel_any(env: &Env) -> Result<RecoverySource, WalletError> {
    let held = pending(env).ok_or(WalletError::RecoveryNotPending)?;
    // Remove both keys, not just the one found: an owner who cancels must be
    // left with nothing counting down.
    env.storage().persistent().remove(&DataKey::RecoveryPending);
    env.storage().persistent().remove(&DataKey::RecoveryKeyPending);
    Ok(held.source)
}

/// Install a recovered signer and release the slot.
///
/// This deliberately **replaces** the whole signer map with the recovered key
/// at index 0 rather than merging it in. Recovery is only needed when the
/// owner cannot authorise with *any* registered signer: an owner holding even
/// one working signer can cancel, `add_signer` or `rotate_signer` instead. So
/// every signer present at recovery time is lost or, worse, in someone else's
/// hands. Keeping them would leave a thief who took one device with a seat on
/// the recovered wallet; merging would make recovery unable to evict a
/// compromised key, which is the case it most needs to handle.
///
/// Not touched: the guardian, the recovery key, token allowances, spend limits
/// and session keys. Session keys live in temporary storage keyed by id and
/// cannot be enumerated from here; they lapse at their own expiry and the
/// recovered signer can revoke them.
pub fn install_recovered_signer(env: &Env, source: RecoverySource, new_public_key: &BytesN<65>) {
    crate::storage::init_signers(env, new_public_key);
    env.storage().persistent().remove(&slot_key(source));
}

pub fn set_recovery_key(env: &Env, key: &Address) {
    env.storage().persistent().set(&DataKey::RecoveryKey, key);
    env.events().publish(
        (symbol_short!("rec_key"), symbol_short!("set")),
        key.clone(),
    );
}

pub fn request_recovery(env: &Env, new_signer: BytesN<65>) -> Result<(), WalletError> {
    let recovery_key: Address = env
        .storage()
        .persistent()
        .get(&DataKey::RecoveryKey)
        .ok_or(WalletError::NoRecoveryKeySet)?;

    recovery_key.require_auth();

    let unlock_at = claim_slot(env, RecoverySource::RecoveryKey, &new_signer, RECOVERY_KEY_DELAY)?;

    env.events().publish(
        (symbol_short!("rec_key"), symbol_short!("request")),
        (new_signer, unlock_at),
    );

    Ok(())
}

pub fn finalize_recovery(env: &Env) -> Result<(), WalletError> {
    let pending = pending_for(env, RecoverySource::RecoveryKey)?;

    if env.ledger().timestamp() <= pending.recovery_unlock_time {
        return Err(WalletError::RecoveryTimelockActive);
    }

    install_recovered_signer(env, RecoverySource::RecoveryKey, &pending.new_public_key);

    env.events().publish(
        (symbol_short!("rec_key"), symbol_short!("done")),
        pending.new_public_key,
    );

    Ok(())
}

/// Cancel whatever recovery is pending, from either system. Requires current
/// signer (contract) auth, which the caller checks.
pub fn cancel_recovery_request(env: &Env) -> Result<(), WalletError> {
    let cancelled = cancel_any(env)?;

    env.events().publish(
        (symbol_short!("rec_key"), symbol_short!("cancel")),
        cancelled,
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
    use soroban_sdk::{Address, BytesN, Env};

    use crate::{InvisibleWallet, InvisibleWalletClient};

    fn setup() -> (Env, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let id = env.register_contract(None, InvisibleWallet);
        (env, id)
    }

    fn mock_key(env: &Env, seed: u8) -> BytesN<65> {
        let mut b = [0u8; 65];
        b[0] = 0x04;
        b[1] = seed;
        BytesN::from_array(env, &b)
    }

    fn advance_time(env: &Env, secs: u64) {
        let mut info: LedgerInfo = env.ledger().get();
        info.timestamp += secs;
        env.ledger().set(info);
    }

    // ── happy path ──────────────────────────────────────────────────────────────

    // Guards the full recovery flow: request, wait out the timelock, finalize.
    // If this fails, a legitimate recovery key holder cannot rotate the signer,
    // which means a lost passkey permanently locks the wallet's funds.
    #[test]
    fn test_request_and_finalize_recovery() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);

        let recovery_addr = Address::generate(&env);
        let initial_key = mock_key(&env, 0x01);
        let new_key = mock_key(&env, 0x42);

        client.init(
            &initial_key,
            &soroban_sdk::Bytes::new(&env),
            &soroban_sdk::Bytes::new(&env),
        );
        client.set_recovery_key(&recovery_addr);
        client.request_recovery(&new_key);

        // Cannot finalize before timelock expires.
        assert!(
            client.try_finalize_recovery().is_err(),
            "finalize before cooldown must fail"
        );

        advance_time(&env, RECOVERY_KEY_DELAY + 1);
        client.finalize_recovery();

        assert!(
            client.has_signer(&new_key),
            "new signer must be registered after finalize"
        );
    }

    // ── timelock boundary ───────────────────────────────────────────────────────

    // Guards the exact unlock boundary: finalize must fail at unlock_at and
    // succeed only strictly after it. If this fails, the 7-day delay can be
    // bypassed, letting a compromised recovery key drain the wallet instantly.
    #[test]
    fn test_timelock_boundary() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);

        let recovery_addr = Address::generate(&env);
        let initial_key = mock_key(&env, 0x01);
        let new_key = mock_key(&env, 0x42);

        client.init(
            &initial_key,
            &soroban_sdk::Bytes::new(&env),
            &soroban_sdk::Bytes::new(&env),
        );
        client.set_recovery_key(&recovery_addr);
        client.request_recovery(&new_key);

        // One second before unlock.
        advance_time(&env, RECOVERY_KEY_DELAY - 1);
        assert!(client.try_finalize_recovery().is_err());

        // Exactly at unlock_at (timestamp == unlock_at is still locked; need >).
        advance_time(&env, 1);
        assert!(client.try_finalize_recovery().is_err());

        // One second past unlock.
        advance_time(&env, 1);
        client.finalize_recovery();
    }

    // ── cancellation ────────────────────────────────────────────────────────────

    // Guards that cancelling a pending request actually clears it. If this
    // fails, the original signer cannot abort a hostile recovery request and
    // the attacker's signer gets installed once the timelock elapses.
    #[test]
    fn test_cancel_recovery_request() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);

        let recovery_addr = Address::generate(&env);
        let initial_key = mock_key(&env, 0x01);
        let new_key = mock_key(&env, 0x42);

        client.init(
            &initial_key,
            &soroban_sdk::Bytes::new(&env),
            &soroban_sdk::Bytes::new(&env),
        );
        client.set_recovery_key(&recovery_addr);
        client.request_recovery(&new_key);
        client.cancel_recovery_request();

        // After cancellation finalize must fail.
        advance_time(&env, RECOVERY_KEY_DELAY + 1);
        assert!(
            client.try_finalize_recovery().is_err(),
            "finalize after cancel must fail"
        );
    }

    // Guards that cancel without a pending request errors instead of silently
    // succeeding. If this fails, callers cannot distinguish "nothing to cancel"
    // from "cancelled", masking state bugs around the pending recovery slot.
    #[test]
    fn test_cancel_without_pending_fails() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);
        assert!(client.try_cancel_recovery_request().is_err());
    }

    // ── error paths ─────────────────────────────────────────────────────────────

    // Guards that recovery cannot be initiated without a configured recovery
    // key. If this fails, anyone could request a recovery and, after the
    // timelock, take over a wallet that never opted into recovery.
    #[test]
    fn test_request_without_recovery_key_fails() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);
        let new_key = mock_key(&env, 0x42);
        assert!(client.try_request_recovery(&new_key).is_err());
    }

    // Guards that only one recovery request can be pending at a time. If this
    // fails, a second request could overwrite the first, resetting the timelock
    // and letting an attacker keep a recovery perpetually one step from finalizing.
    #[test]
    fn test_duplicate_request_rejected() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);

        let recovery_addr = Address::generate(&env);
        let initial_key = mock_key(&env, 0x01);
        let key1 = mock_key(&env, 0x11);
        let key2 = mock_key(&env, 0x22);

        client.init(
            &initial_key,
            &soroban_sdk::Bytes::new(&env),
            &soroban_sdk::Bytes::new(&env),
        );
        client.set_recovery_key(&recovery_addr);
        client.request_recovery(&key1);

        assert!(
            client.try_request_recovery(&key2).is_err(),
            "second request while one is pending must fail"
        );
    }

    // Guards that finalize without a pending request errors. If this fails,
    // finalize could be called with no request in flight, potentially
    // installing an unset or stale signer and bricking the wallet.
    #[test]
    fn test_finalize_without_pending_fails() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);
        assert!(client.try_finalize_recovery().is_err());
    }
}

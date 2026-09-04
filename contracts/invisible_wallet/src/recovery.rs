use soroban_sdk::{symbol_short, Address, BytesN, Env};

use crate::storage::{DataKey, PendingRecovery};
use crate::WalletError;

/// 7-day timelock in seconds.
pub const RECOVERY_KEY_DELAY: u64 = 604_800;

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

    if env.storage().persistent().has(&DataKey::RecoveryKeyPending) {
        return Err(WalletError::RecoveryAlreadyPending);
    }

    let unlock_at = env.ledger().timestamp() + RECOVERY_KEY_DELAY;
    let pending = PendingRecovery {
        new_public_key: new_signer.clone(),
        recovery_unlock_time: unlock_at,
    };
    env.storage()
        .persistent()
        .set(&DataKey::RecoveryKeyPending, &pending);

    env.events().publish(
        (symbol_short!("rec_key"), symbol_short!("request")),
        (new_signer, unlock_at),
    );

    Ok(())
}

pub fn finalize_recovery(env: &Env) -> Result<(), WalletError> {
    let pending: PendingRecovery = env
        .storage()
        .persistent()
        .get(&DataKey::RecoveryKeyPending)
        .ok_or(WalletError::RecoveryNotPending)?;

    if env.ledger().timestamp() <= pending.recovery_unlock_time {
        return Err(WalletError::RecoveryTimelockActive);
    }

    crate::storage::init_signers(env, &pending.new_public_key);
    env.storage()
        .persistent()
        .remove(&DataKey::RecoveryKeyPending);

    env.events().publish(
        (symbol_short!("rec_key"), symbol_short!("done")),
        pending.new_public_key,
    );

    Ok(())
}

/// Cancel a pending recovery-key request. Requires current signer (contract) auth.
pub fn cancel_recovery_request(env: &Env) -> Result<(), WalletError> {
    if !env
        .storage()
        .persistent()
        .has(&DataKey::RecoveryKeyPending)
    {
        return Err(WalletError::RecoveryNotPending);
    }

    env.storage()
        .persistent()
        .remove(&DataKey::RecoveryKeyPending);

    env.events().publish(
        (symbol_short!("rec_key"), symbol_short!("cancel")),
        (),
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

    #[test]
    fn test_cancel_without_pending_fails() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);
        assert!(client.try_cancel_recovery_request().is_err());
    }

    // ── error paths ─────────────────────────────────────────────────────────────

    #[test]
    fn test_request_without_recovery_key_fails() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);
        let new_key = mock_key(&env, 0x42);
        assert!(client.try_request_recovery(&new_key).is_err());
    }

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

    #[test]
    fn test_finalize_without_pending_fails() {
        let (env, id) = setup();
        let client = InvisibleWalletClient::new(&env, &id);
        assert!(client.try_finalize_recovery().is_err());
    }
}

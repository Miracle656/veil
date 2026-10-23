#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{Address, BytesN, Env};

fn setup_env() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, InvisibleWallet);
    (env, contract_id)
}

fn mock_public_key(env: &Env, seed: u8) -> BytesN<65> {
    let mut key_bytes = [0u8; 65];
    key_bytes[0] = 0x04; // uncompressed public key prefix
    key_bytes[1] = seed;
    BytesN::from_array(env, &key_bytes)
}

/// Helper to advance the ledger timestamp by a given number of seconds.
fn advance_ledger_time(env: &Env, seconds: u64) {
    let mut ledger_info = env.ledger().get();
    ledger_info.timestamp += seconds;
    env.ledger().set(ledger_info);
}

// ============================================================================
// Recovery lifecycle: the happy path a guardian is meant to walk.
// ============================================================================

// Guards the end-to-end recovery path: if this fails, a guardian can no longer
// hand control of the wallet to a new key, and a lost passkey means lost funds.
#[test]
fn test_full_guardian_recovery_flow() {
    let (env, contract_id) = setup_env();
    let client = InvisibleWalletClient::new(&env, &contract_id);

    let guardian = Address::generate(&env);
    let new_key = mock_public_key(&env, 0x42);

    // Set the guardian
    client.set_guardian(&guardian);

    // Initiate recovery
    client.initiate_recovery(&new_key);

    // Advance past the 3-day timelock
    advance_ledger_time(&env, 259_201);

    // Complete recovery
    client.complete_recovery();
}

// ============================================================================
// Limits: the timelock is the only window the owner has to react.
// ============================================================================

// Guards the 3-day timelock: if this fails, a compromised guardian can swap the
// signing key instantly and drain the wallet before the owner notices.
#[test]
fn test_timelock_enforcement() {
    let (env, contract_id) = setup_env();
    let client = InvisibleWalletClient::new(&env, &contract_id);

    let guardian = Address::generate(&env);
    let new_key = mock_public_key(&env, 0x42);

    client.set_guardian(&guardian);
    client.initiate_recovery(&new_key);

    // Try to complete before timelock expires - should fail
    let result = client.try_complete_recovery();
    assert!(result.is_err(), "complete_recovery should fail before timelock expires");

    // Advance to just before expiry
    advance_ledger_time(&env, 259_199);
    let result = client.try_complete_recovery();
    assert!(result.is_err(), "complete_recovery should fail 1 second before timelock expires");

    // Advance past expiry
    advance_ledger_time(&env, 2);
    client.complete_recovery();
}

// ============================================================================
// Authorisation: who is allowed to start a recovery at all.
// ============================================================================

// Guards against recovery with no guardian configured: if this fails, anyone
// could initiate a key swap on a wallet that never opted into social recovery.
#[test]
fn test_no_guardian_rejection() {
    let (env, contract_id) = setup_env();
    let client = InvisibleWalletClient::new(&env, &contract_id);

    let new_key = mock_public_key(&env, 0x42);

    // Initiate recovery without setting a guardian - should fail
    let result = client.try_initiate_recovery(&new_key);
    assert!(result.is_err(), "initiate_recovery should fail when no guardian is set");
}

// ============================================================================
// Recovery: cancellation is the owner's escape hatch from a hostile recovery.
// ============================================================================

// Guards the owner's ability to abort a pending recovery: if this fails, a
// malicious guardian's key swap completes even after the owner cancels it.
#[test]
fn test_cancel_recovery() {
    let (env, contract_id) = setup_env();
    let client = InvisibleWalletClient::new(&env, &contract_id);

    let guardian = Address::generate(&env);
    let new_key = mock_public_key(&env, 0x42);

    client.set_guardian(&guardian);
    client.initiate_recovery(&new_key);

    // Cancel the recovery
    client.cancel_recovery();

    // Advance time and try to complete - should fail because it was cancelled
    advance_ledger_time(&env, 259_201);
    let result = client.try_complete_recovery();
    assert!(result.is_err(), "complete_recovery should fail after cancellation");
}

// Guards against cancelling a non-existent recovery: if this fails, the
// cancellation state can be corrupted without any recovery actually pending.
#[test]
fn test_cancel_without_pending_recovery() {
    let (env, contract_id) = setup_env();
    let client = InvisibleWalletClient::new(&env, &contract_id);

    // Cancel without any pending recovery - should fail
    let result = client.try_cancel_recovery();
    assert!(result.is_err(), "cancel_recovery should fail when no recovery is pending");
}

// Guards against completing a non-existent recovery: if this fails, a key swap
// could be finalised without ever passing through initiate_recovery.
#[test]
fn test_complete_without_pending_recovery() {
    let (env, contract_id) = setup_env();
    let client = InvisibleWalletClient::new(&env, &contract_id);

    // Complete without any pending recovery - should fail
    let result = client.try_complete_recovery();
    assert!(result.is_err(), "complete_recovery should fail when no recovery is pending");
}

// Guards against overlapping recoveries: if this fails, a second initiate can
// overwrite the pending key and reset the timelock, defeating the delay.
#[test]
fn test_duplicate_initiate_recovery_rejected() {
    let (env, contract_id) = setup_env();
    let client = InvisibleWalletClient::new(&env, &contract_id);

    let guardian = Address::generate(&env);
    let key1 = mock_public_key(&env, 0x01);
    let key2 = mock_public_key(&env, 0x02);

    client.set_guardian(&guardian);
    client.initiate_recovery(&key1);

    // Second initiate should fail
    let result = client.try_initiate_recovery(&key2);
    assert!(result.is_err(), "second initiate_recovery should be rejected while one is pending");
}
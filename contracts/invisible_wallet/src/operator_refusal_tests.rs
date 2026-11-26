#![cfg(test)]

//! Operator refusal suite (#1175).
//!
//! The wallet's security rests on one claim: **only the passkey holder can
//! authorise a spend**. Every test here is a refusal — it hands a privileged
//! role its own, fully valid signature for the exact call under test and
//! asserts the wallet still says no, because the authorisation the contract
//! demands (`env.current_contract_address().require_auth()`, satisfied only
//! through `__check_auth`, i.e. the passkey) was never produced.
//!
//! Roles covered, singly and in combination:
//! - the **fee payer** — the classic Stellar account that submits and funds
//!   transactions for the wallet;
//! - the **factory admin** — the account that deployed the factory and can
//!   point *future* wallets at new code;
//! - the **guardian** — the one role with any designed power, and that power
//!   is exactly one thing: a timelocked signer replacement the owner can
//!   cancel. Nothing else.
//!
//! A test proving what an attacker cannot do is worth more than several
//! proving the happy path works.

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke};
use soroban_sdk::{vec, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec};

fn mock_public_key(env: &Env, seed: u8) -> BytesN<65> {
    let mut key_bytes = [0u8; 65];
    key_bytes[0] = 0x04;
    key_bytes[1] = seed;
    BytesN::from_array(env, &key_bytes)
}

/// A wallet with one passkey signer and a guardian configured. All auths are
/// mocked only for this setup; every test then narrows to the exact signature
/// it wants to prove insufficient.
fn setup_wallet_with_guardian(env: &Env) -> (Address, Address) {
    env.mock_all_auths();
    let contract_id = env.register_contract(None, InvisibleWallet);
    let client = InvisibleWalletClient::new(env, &contract_id);
    client.init(
        &mock_public_key(env, 0x01),
        &Bytes::from_slice(env, b"localhost"),
        &Bytes::from_slice(env, b"http://localhost:3000"),
    );
    let guardian = Address::generate(env);
    client.set_guardian(&guardian);
    (contract_id, guardian)
}

/// Mock exactly one address's authorisation for one call on the wallet.
/// This is the strongest thing the role can ever present: a real signature,
/// for this contract, this function, these arguments.
fn mock_role_auth(env: &Env, role: &Address, contract: &Address, fn_name: &'static str, args: Vec<Val>) {
    env.mock_auths(&[MockAuth {
        address: role,
        invoke: &MockAuthInvoke {
            contract,
            fn_name,
            args,
            sub_invokes: &[],
        },
    }]);
}

/// For one privileged role: its own signature must not spend, must not add,
/// rotate or remove a signer, and must not install or change a guardian.
/// Shared by the fee-payer, factory-admin and guardian cases so every role is
/// held to the identical standard.
fn assert_role_cannot_control_wallet(env: &Env, contract_id: &Address, role: &Address) {
    let client = InvisibleWalletClient::new(env, contract_id);
    let target = Address::generate(env);
    let func = Symbol::new(env, "transfer");
    let call_args: Vec<Val> = vec![env];

    // Spend, path 1: arbitrary invocation through execute().
    // If this failed, the role could move every asset the wallet holds.
    mock_role_auth(
        env,
        role,
        contract_id,
        "execute",
        (target.clone(), func.clone(), call_args.clone()).into_val(env),
    );
    assert!(
        client.try_execute(&target, &func, &call_args).is_err(),
        "a non-passkey role authorised execute()"
    );

    // Spend, path 2: granting itself an allowance to drain later.
    // If this failed, the role would not need execute() at all — it could
    // write itself a standing permission and spend through Branch 1 of
    // __check_auth forever.
    let token = Address::generate(env);
    mock_role_auth(
        env,
        role,
        contract_id,
        "approve",
        (role.clone(), token.clone(), 1_000_000i128, Option::<u64>::None).into_val(env),
    );
    assert!(
        client
            .try_approve(&role.clone(), &token, &1_000_000i128, &None)
            .is_err(),
        "a non-passkey role authorised approve()"
    );

    // Signer set: add. If this failed, the role could register a key it
    // controls and become the user.
    let rogue_key = mock_public_key(env, 0xEE);
    mock_role_auth(env, role, contract_id, "add_signer", (rogue_key.clone(),).into_val(env));
    assert!(
        client.try_add_signer(&rogue_key).is_err(),
        "a non-passkey role authorised add_signer()"
    );

    // Signer set: rotate. If this failed, the role could swap the user's
    // passkey for its own — a silent, total takeover.
    let owner_key = mock_public_key(env, 0x01);
    mock_role_auth(
        env,
        role,
        contract_id,
        "rotate_signer",
        (owner_key.clone(), rogue_key.clone()).into_val(env),
    );
    assert!(
        client.try_rotate_signer(&owner_key, &rogue_key).is_err(),
        "a non-passkey role authorised rotate_signer()"
    );

    // Signer set: remove. If this failed, the role could lock the user out
    // even without gaining access itself.
    mock_role_auth(env, role, contract_id, "remove_signer", (0u32,).into_val(env));
    assert!(
        client.try_remove_signer(&0u32).is_err(),
        "a non-passkey role authorised remove_signer()"
    );

    // Guardianship: installing or replacing the guardian is itself an owner
    // decision. If this failed, the role could appoint a guardian it controls
    // and walk through the recovery door three days later.
    let rogue_guardian = Address::generate(env);
    mock_role_auth(env, role, contract_id, "set_guardian", (rogue_guardian.clone(),).into_val(env));
    assert!(
        client.try_set_guardian(&rogue_guardian).is_err(),
        "a non-passkey role authorised set_guardian()"
    );
}

#[test]
fn fee_payer_cannot_spend_or_take_over() {
    // The fee payer signs and funds the wallet's transactions every day; its
    // signature is the one an operator always has. If any assertion in here
    // failed, operating the service would mean being able to steal from it.
    let env = Env::default();
    let (contract_id, _guardian) = setup_wallet_with_guardian(&env);
    let fee_payer = Address::generate(&env);
    assert_role_cannot_control_wallet(&env, &contract_id, &fee_payer);
}

#[test]
fn factory_admin_cannot_spend_or_take_over() {
    // The factory admin controls which code FUTURE wallets run. If this
    // failed, whoever holds the deploy key could reach into every wallet
    // already deployed — the exact thing the factory/wallet split is for.
    let env = Env::default();
    let (contract_id, _guardian) = setup_wallet_with_guardian(&env);
    let factory_admin = Address::generate(&env);
    assert_role_cannot_control_wallet(&env, &contract_id, &factory_admin);
}

#[test]
fn guardian_cannot_spend_or_take_over_directly() {
    // The guardian is the only role the owner deliberately trusts, which is
    // exactly why its reach must be provably narrow. If this failed, naming a
    // recovery contact would mean handing them the wallet.
    let env = Env::default();
    let (contract_id, guardian) = setup_wallet_with_guardian(&env);
    assert_role_cannot_control_wallet(&env, &contract_id, &guardian);
}

#[test]
fn fee_payer_cannot_run_a_recovery() {
    // Recovery initiation demands the guardian's signature specifically. If
    // this failed, the operator could start a signer replacement against any
    // wallet and wait out the timelock.
    let env = Env::default();
    let (contract_id, _guardian) = setup_wallet_with_guardian(&env);
    let client = InvisibleWalletClient::new(&env, &contract_id);
    let fee_payer = Address::generate(&env);
    let rogue_key = mock_public_key(&env, 0xEE);

    mock_role_auth(
        &env,
        &fee_payer,
        &contract_id,
        "initiate_recovery",
        (rogue_key.clone(),).into_val(&env),
    );
    assert!(
        client.try_initiate_recovery(&rogue_key).is_err(),
        "a non-guardian authorised initiate_recovery()"
    );
}

#[test]
fn guardian_cannot_finish_its_own_recovery_early() {
    // The guardian's one power is bounded by the timelock; the timelock is
    // the owner's window to cancel. If this failed, the delay — and with it
    // the owner's whole defence against a rogue guardian — would be fiction.
    let env = Env::default();
    let (contract_id, guardian) = setup_wallet_with_guardian(&env);
    let client = InvisibleWalletClient::new(&env, &contract_id);
    let rogue_key = mock_public_key(&env, 0xEE);

    mock_role_auth(
        &env,
        &guardian,
        &contract_id,
        "initiate_recovery",
        (rogue_key.clone(),).into_val(&env),
    );
    client.initiate_recovery(&rogue_key); // the designed power: initiation

    // complete_recovery is permissionless by design, so give it the most
    // generous conditions an attacker could ever have — every signature in
    // the world — and let only the clock say no.
    env.mock_all_auths();
    assert_eq!(
        client.try_complete_recovery(),
        Err(Ok(WalletError::RecoveryTimelockActive)),
        "a recovery completed inside the timelock"
    );

    // One second before the deadline is still inside the deadline.
    let mut ledger = env.ledger().get();
    ledger.timestamp += RECOVERY_DELAY_SECONDS - 1;
    env.ledger().set(ledger);
    assert_eq!(
        client.try_complete_recovery(),
        Err(Ok(WalletError::RecoveryTimelockActive)),
        "a recovery completed one second early"
    );
}

#[test]
fn fee_payer_plus_guardian_together_are_still_not_the_user() {
    // Roles compose in real deployments: the service that pays fees may also
    // be the guardian a user picked. If this failed, that ordinary pairing
    // would quietly add up to custody.
    let env = Env::default();
    let (contract_id, guardian) = setup_wallet_with_guardian(&env);
    let client = InvisibleWalletClient::new(&env, &contract_id);
    let fee_payer = Address::generate(&env);

    let target = Address::generate(&env);
    let func = Symbol::new(&env, "transfer");
    let call_args: Vec<Val> = vec![&env];
    let exec_args: Vec<Val> = (target.clone(), func.clone(), call_args.clone()).into_val(&env);

    // Both signatures at once, each for this exact call.
    env.mock_auths(&[
        MockAuth {
            address: &fee_payer,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "execute",
                args: exec_args.clone(),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &guardian,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "execute",
                args: exec_args,
                sub_invokes: &[],
            },
        },
    ]);
    assert!(
        client.try_execute(&target, &func, &call_args).is_err(),
        "fee payer + guardian together authorised execute()"
    );

    // And the pair cannot shortcut the guardian's one power either: with both
    // signatures, add_signer still refuses.
    let rogue_key = mock_public_key(&env, 0xEE);
    let add_args: Vec<Val> = (rogue_key.clone(),).into_val(&env);
    env.mock_auths(&[
        MockAuth {
            address: &fee_payer,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "add_signer",
                args: add_args.clone(),
                sub_invokes: &[],
            },
        },
        MockAuth {
            address: &guardian,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "add_signer",
                args: add_args,
                sub_invokes: &[],
            },
        },
    ]);
    assert!(
        client.try_add_signer(&rogue_key).is_err(),
        "fee payer + guardian together authorised add_signer()"
    );
}

#[test]
fn the_guardians_one_power_stays_cancelable_by_the_owner() {
    // The containment story, end to end: the guardian starts a recovery (its
    // designed power), and the owner — who still holds the passkey — cancels
    // it inside the window. If this failed, a wrong or compromised guardian
    // could not be stopped, and "timelocked" would mean merely "delayed".
    let env = Env::default();
    let (contract_id, guardian) = setup_wallet_with_guardian(&env);
    let client = InvisibleWalletClient::new(&env, &contract_id);
    let rogue_key = mock_public_key(&env, 0xEE);

    mock_role_auth(
        &env,
        &guardian,
        &contract_id,
        "initiate_recovery",
        (rogue_key.clone(),).into_val(&env),
    );
    client.initiate_recovery(&rogue_key);

    // The owner cancels (passkey auth, stood in for by mock_all_auths — the
    // refusal tests above establish nothing weaker reaches this gate).
    env.mock_all_auths();
    client.cancel_recovery();

    // Nothing left to complete, however long an attacker waits.
    let mut ledger = env.ledger().get();
    ledger.timestamp += RECOVERY_DELAY_SECONDS + 10;
    env.ledger().set(ledger);
    assert_eq!(
        client.try_complete_recovery(),
        Err(Ok(WalletError::RecoveryNotPending)),
        "a cancelled recovery was completed anyway"
    );
}

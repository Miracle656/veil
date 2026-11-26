//! Per-token spend limits, end to end through `__check_auth`.
//!
//! The policy module (`policies::spend_limit`) is unit-tested on its own; this
//! file is where the promise is checked against a *real* authorization: a real
//! WebAuthn assertion, over a real set of auth contexts, going through the
//! same `__check_auth` the host calls.
//!
//! The defect these tests exist to prevent: a cap is denominated in one token,
//! so a cap of 100 XLM must not permit 100 units of any other token. The old
//! shape summed every amount in the authorization whatever asset it was in, so
//! the same number meant wildly different amounts of money depending on what
//! the key happened to spend.

use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, BytesN, Env, IntoVal, Symbol, Vec};

use crate::webauthn_fixture::{assertion, setup, token, CheckAuthTestHelper};
use crate::WalletError;

/// A `transfer` context against a token contract, the shape a wallet spends
/// through: the wallet is the `from`, the payee is the `to`, and the amount is
/// in the token's base units.
fn transfer_context(
    env: &Env,
    token: &Address,
    from: &Address,
    to: &Address,
    amount: i128,
) -> Context {
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(env, "transfer"),
        args: Vec::from_array(
            env,
            [
                from.clone().into_val(env),
                to.clone().into_val(env),
                amount.into_val(env),
            ],
        ),
    })
}

/// A call to something that is not a token transfer — the wallet contract
/// itself, here.
fn wallet_call_context(env: &Env, wallet: &Address, fn_name: &str) -> Context {
    Context::Contract(ContractContext {
        contract: wallet.clone(),
        fn_name: Symbol::new(env, fn_name),
        args: Vec::from_array(
            env,
            [
                wallet.clone().into_val(env),
                Address::generate(env).into_val(env),
                1i128.into_val(env),
            ],
        ),
    })
}

fn payload(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

// ── The headline defect ──────────────────────────────────────────────────────

/// A cap set in one token does not permit the same number in another.
///
/// This is the whole point of the change. One hundred XLM and one hundred USDC
/// are not the same amount of money, and a limit that cannot say which it
/// means is not a limit.
#[test]
fn a_cap_in_one_token_does_not_permit_the_same_number_in_another() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let xlm = token(&env);
    let usdc = token(&env);
    let payee = Address::generate(&env);
    let wallet = client.address.clone();

    env.mock_all_auths();
    client.set_key_spend_limit(&BytesN::from_array(&env, &pub_bytes), &xlm, &100);

    // The token the cap is denominated in spends up to the cap.
    let p = payload(&env, 1);
    client.__check_auth(
        &p,
        &assertion(&env, &sk, &pub_bytes, &[1u8; 32], 0),
        &Vec::from_array(&env, [transfer_context(&env, &xlm, &wallet, &payee, 100)]),
    );

    // The same number in a different token is refused: it is not in scope.
    let p = payload(&env, 2);
    assert_eq!(
        client.try___check_auth(
            &p,
            &assertion(&env, &sk, &pub_bytes, &[2u8; 32], 1),
            &Vec::from_array(&env, [transfer_context(&env, &usdc, &wallet, &payee, 100)],),
        ),
        Err(Ok(WalletError::SpendLimitTokenNotAllowed)),
        "a cap in XLM must not be spendable in USDC",
    );
}

/// A cap is a cap in its own token: spending over it is still refused.
#[test]
fn the_cap_is_still_enforced_in_the_token_it_is_denominated_in() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let xlm = token(&env);
    let payee = Address::generate(&env);
    let wallet = client.address.clone();

    env.mock_all_auths();
    client.set_key_spend_limit(&BytesN::from_array(&env, &pub_bytes), &xlm, &100);

    let p = payload(&env, 3);
    assert_eq!(
        client.try___check_auth(
            &p,
            &assertion(&env, &sk, &pub_bytes, &[3u8; 32], 0),
            &Vec::from_array(&env, [transfer_context(&env, &xlm, &wallet, &payee, 101)],),
        ),
        Err(Ok(WalletError::SpendLimitExceeded)),
    );
}

/// Two tokens, two budgets, two windows. Spending one does not touch the
/// other.
#[test]
fn each_token_gets_its_own_budget() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let xlm = token(&env);
    let usdc = token(&env);
    let payee = Address::generate(&env);
    let wallet = client.address.clone();
    let key = BytesN::from_array(&env, &pub_bytes);

    env.mock_all_auths();
    client.set_key_spend_limit(&key, &xlm, &100);
    client.set_key_spend_limit(&key, &usdc, &1_000);

    // Spend the whole XLM budget.
    let p = payload(&env, 4);
    client.__check_auth(
        &p,
        &assertion(&env, &sk, &pub_bytes, &[4u8; 32], 0),
        &Vec::from_array(&env, [transfer_context(&env, &xlm, &wallet, &payee, 100)]),
    );

    // The USDC budget is untouched by that, and is enforced on its own terms.
    let p = payload(&env, 5);
    client.__check_auth(
        &p,
        &assertion(&env, &sk, &pub_bytes, &[5u8; 32], 1),
        &Vec::from_array(
            &env,
            [transfer_context(&env, &usdc, &wallet, &payee, 1_000)],
        ),
    );

    let p = payload(&env, 6);
    assert_eq!(
        client.try___check_auth(
            &p,
            &assertion(&env, &sk, &pub_bytes, &[6u8; 32], 2),
            &Vec::from_array(&env, [transfer_context(&env, &usdc, &wallet, &payee, 1)],),
        ),
        Err(Ok(WalletError::SpendLimitExceeded)),
        "the USDC budget must be exhausted by USDC spending, not by XLM spending",
    );
}

// ── What a scoped key may not do ─────────────────────────────────────────────

/// A scoped key cannot reach the wallet contract itself.
///
/// A limit turns a signer key into a spending credential. If the key could
/// still call `execute`, or add a signer, or change its own limits, then the
/// limit would be a speed bump rather than a limit.
#[test]
fn a_scoped_key_cannot_call_the_wallet_contract() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let xlm = token(&env);
    let wallet = client.address.clone();

    env.mock_all_auths();
    client.set_key_spend_limit(&BytesN::from_array(&env, &pub_bytes), &xlm, &100);

    let p = payload(&env, 7);
    assert_eq!(
        client.try___check_auth(
            &p,
            &assertion(&env, &sk, &pub_bytes, &[7u8; 32], 0),
            &Vec::from_array(&env, [wallet_call_context(&env, &wallet, "execute")],),
        ),
        Err(Ok(WalletError::SpendLimitUnsupportedCall)),
    );
}

/// A scoped key cannot make a call the token interface does not describe,
/// because there is no amount to budget for it.
#[test]
fn a_scoped_key_cannot_make_a_call_with_no_budgetable_amount() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let xlm = token(&env);
    let payee = Address::generate(&env);
    let wallet = client.address.clone();

    env.mock_all_auths();
    client.set_key_spend_limit(&BytesN::from_array(&env, &pub_bytes), &xlm, &100);

    let swap = Context::Contract(ContractContext {
        contract: xlm.clone(),
        fn_name: Symbol::new(&env, "swap"),
        args: Vec::from_array(
            &env,
            [
                wallet.into_val(&env),
                payee.into_val(&env),
                1i128.into_val(&env),
            ],
        ),
    });

    let p = payload(&env, 8);
    assert_eq!(
        client.try___check_auth(
            &p,
            &assertion(&env, &sk, &pub_bytes, &[8u8; 32], 0),
            &Vec::from_array(&env, [swap]),
        ),
        Err(Ok(WalletError::SpendLimitUnsupportedCall)),
    );
}

// ── Keys that were never limited ─────────────────────────────────────────────

/// A key with no limits is unrestricted, exactly as before this change.
///
/// The feature is opt-in. A wallet whose owner never set a limit keeps the
/// behaviour it has today, including calling the wallet contract.
#[test]
fn a_key_with_no_limits_is_unrestricted() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let usdc = token(&env);
    let payee = Address::generate(&env);
    let wallet = client.address.clone();

    let p = payload(&env, 9);
    client.__check_auth(
        &p,
        &assertion(&env, &sk, &pub_bytes, &[9u8; 32], 0),
        &Vec::from_array(
            &env,
            [transfer_context(&env, &usdc, &wallet, &payee, 1_000_000)],
        ),
    );
    assert_eq!(client.get_nonce(), 1);
}

/// Removing the last limit un-scopes the key: it can spend again, anywhere.
#[test]
fn removing_the_last_limit_frees_the_key() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let xlm = token(&env);
    let usdc = token(&env);
    let payee = Address::generate(&env);
    let wallet = client.address.clone();
    let key = BytesN::from_array(&env, &pub_bytes);

    env.mock_all_auths();
    client.set_key_spend_limit(&key, &xlm, &100);

    // Scoped: USDC is refused.
    let p = payload(&env, 10);
    assert_eq!(
        client.try___check_auth(
            &p,
            &assertion(&env, &sk, &pub_bytes, &[10u8; 32], 0),
            &Vec::from_array(&env, [transfer_context(&env, &usdc, &wallet, &payee, 1)],),
        ),
        Err(Ok(WalletError::SpendLimitTokenNotAllowed)),
    );

    client.remove_key_spend_limit(&key, &xlm);

    // Unscoped: the same call now goes through.
    let p = payload(&env, 11);
    client.__check_auth(
        &p,
        &assertion(&env, &sk, &pub_bytes, &[11u8; 32], 0),
        &Vec::from_array(&env, [transfer_context(&env, &usdc, &wallet, &payee, 1)]),
    );
}

// ── Who may manage a limit ────────────────────────────────────────────────────

/// A key that has a limit cannot change its own limits.
///
/// The limit is only worth something if the limited key cannot lift it. The
/// key that manages a limit is therefore a key that has none — the owner
/// administers the wallet from an unrestricted signer, and a limited signer
/// spends within its budget.
#[test]
fn a_scoped_key_cannot_change_its_own_limits() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let xlm = token(&env);
    let key = BytesN::from_array(&env, &pub_bytes);

    env.mock_all_auths();
    client.set_key_spend_limit(&key, &xlm, &100);

    let p = payload(&env, 12);
    assert_eq!(
        client.try___check_auth(
            &p,
            &assertion(&env, &sk, &pub_bytes, &[12u8; 32], 0),
            &Vec::from_array(
                &env,
                [wallet_call_context(
                    &env,
                    &client.address.clone(),
                    "set_key_spend_limit"
                )],
            ),
        ),
        Err(Ok(WalletError::SpendLimitUnsupportedCall)),
    );
}

/// A limit is set by a key that has none, and applies to the other key.
///
/// This is the flow the feature is built for: a second passkey is limited,
/// and the passkey that owns the wallet keeps full control over it. The
/// administrative calls are authorized by the wallet address, which the
/// owner's unrestricted key answers — the limited key cannot answer them,
/// as the test above shows.
#[test]
fn an_unrestricted_key_manages_the_limits_of_another_key() {
    let env = Env::default();
    let (client, pub_bytes, _sk) = setup(&env);

    // A second passkey — the one that will be limited.
    let limited = BytesN::from_array(&env, &[7u8; 65]);
    let xlm = token(&env);

    env.mock_all_auths();
    client.add_signer(&limited);

    // The owner's own key — unrestricted — sets the limit on the other key.
    client.set_key_spend_limit(&limited, &xlm, &100);

    assert_eq!(client.get_key_spend_limit(&limited, &xlm).unwrap().cap, 100);
    assert!(client.get_key_spend_limit_tokens(&limited).contains(&xlm));

    // And the owner's key is not itself limited: it is unrestricted, so it
    // may still administer the wallet and spend anything.
    assert!(client
        .get_key_spend_limit_tokens(&BytesN::from_array(&env, &pub_bytes))
        .is_empty());
}

// ── The entry points ─────────────────────────────────────────────────────────

/// The scope is readable: the tokens a key is limited to, and the window of
/// each one.
#[test]
fn the_scope_and_the_windows_are_readable() {
    let env = Env::default();
    let (client, pub_bytes, _sk) = setup(&env);

    let xlm = token(&env);
    let usdc = token(&env);
    let key = BytesN::from_array(&env, &pub_bytes);

    env.mock_all_auths();
    client.set_key_spend_limit(&key, &xlm, &100);
    client.set_key_spend_limit(&key, &usdc, &250);

    let scope = client.get_key_spend_limit_tokens(&key);
    assert_eq!(scope.len(), 2);
    assert!(scope.contains(&xlm));
    assert!(scope.contains(&usdc));

    let window = client.get_key_spend_limit(&key, &xlm).unwrap();
    assert_eq!(window.cap, 100);
    assert_eq!(window.window_spent, 0);

    let window = client.get_key_spend_limit(&key, &usdc).unwrap();
    assert_eq!(window.cap, 250);

    client.remove_all_key_spend_limits(&key);
    assert!(client.get_key_spend_limit_tokens(&key).is_empty());
    assert!(client.get_key_spend_limit(&key, &xlm).is_none());
}

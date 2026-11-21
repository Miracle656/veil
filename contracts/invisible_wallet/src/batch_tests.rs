//! Multi-context `__check_auth` — one passkey assertion authorizing a whole batch.
//!
//! Batching's security claim is that a single WebAuthn assertion authorizes
//! every operation in the batch and costs exactly one nonce. That holds because
//! Soroban hands `__check_auth` one `signature_payload` committing to all of
//! `_auth_contexts` at once, so there is nothing per-operation to replay or
//! reorder. These tests pin that down, and pin the one place where a batch
//! genuinely *is* constrained: the allowance branch.
//!
//! The fixture lives in `webauthn_fixture.rs`, shared with the spend-limit
//! tests. A WebAuthn signature is over
//! `SHA256(authData || SHA256(clientDataJSON))` with the s-half normalised
//! low — sign the payload directly, or leave s high, and `secp256r1_verify`
//! traps instead of returning an error, which reads as a contract bug rather
//! than a bad fixture.
//!
//! Suite layout, by concern:
//! - **Authorisation**: `one_assertion_authorizes_every_context_in_the_batch`,
//! - **Limits**: `allowance_branch_rejects_a_non_transfer_context_in_the_batch`.
//! - **Recovery / replay**: `replaying_a_batch_assertion_is_rejected`.
//! - **Lifecycle**: `nonce_is_consumed_once_per_batch_regardless_of_size`.

use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, BytesN, Env, IntoVal, Symbol, Val, Vec};

use crate::webauthn_fixture::{assertion, setup, CheckAuthTestHelper};
use crate::WalletError;

/// A `Contract` context with no arguments — enough to stand for one operation
/// in a batch when the test is about how many contexts there are rather than
/// what they carry.
fn bare_context(env: &Env, fn_name: &str) -> Context {
    Context::Contract(ContractContext {
        contract: Address::generate(env),
        fn_name: Symbol::new(env, fn_name),
        args: Vec::new(env),
    })
}

// ── One assertion, many operations ───────────────────────────────────────────

/// The core claim: three operations, one passkey assertion, one nonce.
///
/// Guards: if this fails, a batch either costs more than one nonce (breaking
/// client-side nonce prediction) or authorizes fewer operations than signed.
#[test]
fn one_assertion_authorizes_every_context_in_the_batch() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let contexts = Vec::from_array(
        &env,
        [
            bare_context(&env, "transfer"),
            bare_context(&env, "approve"),
            bare_context(&env, "swap"),
        ],
    );

    let payload = [42u8; 32];
    let sig = assertion(&env, &sk, &pub_bytes, &payload, 0);

    client.__check_auth(&BytesN::from_array(&env, &payload), &sig, &contexts);

    assert_eq!(
        client.get_nonce(),
        1,
        "a three-operation batch must consume exactly one nonce, not three",
    );
}

/// The nonce tracks assertions, not operations, so batch size must not change
/// how fast it advances. If it ever did, a batch would burn nonces a client
/// could not predict, and an assertion it had already signed would be rejected.
///
/// Guards: if this fails, a client that pre-signs an assertion for nonce N
/// finds the contract expecting N+1 after an unrelated batch, and the signed
/// assertion is rejected — funds stay put but the wallet appears bricked.
#[test]
fn nonce_is_consumed_once_per_batch_regardless_of_size() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let two = Vec::from_array(
        &env,
        [bare_context(&env, "transfer"), bare_context(&env, "approve")],
    );
    let payload_1 = [1u8; 32];
    client.__check_auth(
        &BytesN::from_array(&env, &payload_1),
        &assertion(&env, &sk, &pub_bytes, &payload_1, 0),
        &two,
    );
    assert_eq!(client.get_nonce(), 1);

    let three = Vec::from_array(
        &env,
        [
            bare_context(&env, "swap"),
            bare_context(&env, "mint"),
            bare_context(&env, "burn"),
        ],
    );
    let payload_2 = [2u8; 32];
    client.__check_auth(
        &BytesN::from_array(&env, &payload_2),
        &assertion(&env, &sk, &pub_bytes, &payload_2, 1),
        &three,
    );
    assert_eq!(
        client.get_nonce(),
        2,
        "the second batch had one more operation and must still cost one nonce",
    );
}

/// Replaying the whole batch assertion is rejected, because the nonce it was
/// signed against is already spent. The batch is not special here, and that is
/// the point: one assertion covering N operations is replayable exactly as
/// often as one covering a single operation, which is never.
///
/// Guards: if this fails, a captured batch assertion can be resubmitted to
/// drain the wallet repeatedly — the single most expensive failure mode here.
#[test]
fn replaying_a_batch_assertion_is_rejected() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let contexts = Vec::from_array(
        &env,
        [bare_context(&env, "transfer"), bare_context(&env, "approve")],
    );
    let payload = [7u8; 32];
    let payload_bytes = BytesN::from_array(&env, &payload);

    let first = assertion(&env, &sk, &pub_bytes, &payload, 0);
    client.__check_auth(&payload_bytes, &first, &contexts);

    // Byte-identical resubmission: same payload, same contexts, same nonce.
    let replay = assertion(&env, &sk, &pub_bytes, &payload, 0);
    assert_eq!(
        client.try___check_auth(&payload_bytes, &replay, &contexts),
        Err(Ok(WalletError::NonceMismatch)),
        "a spent nonce must reject the replay of an entire batch",
    );
    assert_eq!(
        client.get_nonce(),
        1,
        "the rejected replay must not advance the nonce",
    );
}

// ── Where a batch *is* constrained ───────────────────────────────────────────

/// A delegated spender holds an allowance, not the passkey, so its batch is
/// restricted to `transfer` out of this wallet. This is the branch that
/// actually inspects every context, and it is what stops a spender slipping an
/// `approve` — which would mint itself a fresh allowance — in beside a
/// legitimate transfer.
///
/// The WebAuthn branch deliberately does not do this; see
/// `webauthn_branch_does_not_restrict_context_types` below.
///
/// Guards: if this fails, a delegated spender can smuggle an `approve` beside
/// a legitimate `transfer` and grant itself a fresh allowance — a privilege
/// escalation from "may move up to X" to "may move anything, forever".
#[test]
fn allowance_branch_rejects_a_non_transfer_context_in_the_batch() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, _pub_bytes, _sk) = setup(&env);

    let spender = Address::generate(&env);
    let token = Address::generate(&env);
    client.approve(&spender, &token, &1_000i128, &None);

    let wallet = client.address.clone();
    let transfer = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&env, "transfer"),
        args: Vec::from_array(
            &env,
            [
                wallet.clone().into_val(&env),
                spender.clone().into_val(&env),
                100i128.into_val(&env),
            ],
        ),
    });
    let sneaked_approve = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&env, "approve"),
        args: Vec::from_array(
            &env,
            [
                wallet.into_val(&env),
                spender.clone().into_val(&env),
                100i128.into_val(&env),
            ],
        ),
    });

    let payload = BytesN::from_array(&env, &[9u8; 32]);
    let as_spender: Val = spender.into_val(&env);

    // Control: the transfer alone is authorized, so the rejection below is
    // caused by the extra context and not by the allowance itself.
    client.__check_auth(
        &payload,
        &as_spender,
        &Vec::from_array(&env, [transfer.clone()]),
    );

    assert_eq!(
        client.try___check_auth(
            &payload,
            &as_spender,
            &Vec::from_array(&env, [transfer, sneaked_approve]),
        ),
        Err(Ok(WalletError::SignerNotAuthorized)),
        "an allowance may only authorize transfers, however they are batched",
    );
}

/// Characterises what the WebAuthn branch does *not* check, so that changing it
/// is a deliberate act rather than an accident.
///
/// Once the assertion verifies, the passkey holder is the wallet owner, and the
/// branch authorizes whatever contexts the transaction carries — including a
/// non-`Contract` context such as a contract deployment. Only the per-key spend
/// limit looks inside them, and it reads an `i128` from `args[2]` of `Contract`
/// contexts alone, so a non-contract context contributes nothing to the total.
///
/// Guards: if this fails, someone tightened the WebAuthn branch without
/// updating this characterisation — which is fine, but must be a deliberate
/// change, because the per-key spend limit does not see non-`Contract` args.
#[test]
fn webauthn_branch_does_not_restrict_context_types() {
    let env = Env::default();
    let (client, pub_bytes, sk) = setup(&env);

    let contexts = Vec::from_array(
        &env,
        [
            bare_context(&env, "transfer"),
            Context::CreateContractHostFn(soroban_sdk::auth::CreateContractHostFnContext {
                executable: soroban_sdk::auth::ContractExecutable::Wasm(BytesN::from_array(
                    &env,
                    &[0u8; 32],
                )),
                salt: BytesN::from_array(&env, &[1u8; 32]),
            }),
        ],
    );

    let payload = [11u8; 32];
    let sig = assertion(&env, &sk, &pub_bytes, &payload, 0);

    client.__check_auth(&BytesN::from_array(&env, &payload), &sig, &contexts);
    assert_eq!(client.get_nonce(), 1);
}

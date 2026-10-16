//! Multi-context `__check_auth` — one passkey assertion authorizing a whole batch.
//!
//! Batching's security claim is that a single WebAuthn assertion authorizes
//! every operation in the batch and costs exactly one nonce. That holds because
//! Soroban hands `__check_auth` one `signature_payload` committing to all of
//! `_auth_contexts` at once, so there is nothing per-operation to replay or
//! reorder. These tests pin that down, and pin the one place where a batch
//! genuinely *is* constrained: the allowance branch.
//!
//! The fixture here mirrors `auth_failure_tests.rs` rather than inventing its
//! own. A WebAuthn signature is over `SHA256(authData || SHA256(clientDataJSON))`
//! with the s-half normalised low — sign the payload directly, or leave s high,
//! and `secp256r1_verify` traps instead of returning an error, which reads as a
//! contract bug rather than a bad fixture.

use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature as P256Sig, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec};

use crate::{InvisibleWallet, InvisibleWalletClient, WalletError};

// ── Fixture ──────────────────────────────────────────────────────────────────

trait CheckAuthTestHelper {
    fn __check_auth(&self, payload: &BytesN<32>, signature: &Val, contexts: &Vec<Context>);
    fn try___check_auth(
        &self,
        payload: &BytesN<32>,
        signature: &Val,
        contexts: &Vec<Context>,
    ) -> Result<(), Result<WalletError, soroban_sdk::InvokeError>>;
}

impl<'a> CheckAuthTestHelper for InvisibleWalletClient<'a> {
    fn __check_auth(&self, payload: &BytesN<32>, signature: &Val, contexts: &Vec<Context>) {
        self.env
            .try_invoke_contract_check_auth::<WalletError>(
                &self.address,
                payload,
                *signature,
                contexts,
            )
            .unwrap();
    }

    fn try___check_auth(
        &self,
        payload: &BytesN<32>,
        signature: &Val,
        contexts: &Vec<Context>,
    ) -> Result<(), Result<WalletError, soroban_sdk::InvokeError>> {
        self.env.try_invoke_contract_check_auth::<WalletError>(
            &self.address,
            payload,
            *signature,
            contexts,
        )
    }
}

const RP_ID: &str = "test.veil";
const ORIGIN: &str = "https://test.veil";

fn test_keypair() -> (SigningKey, [u8; 65]) {
    let signing_key = SigningKey::from_bytes(&[42u8; 32].into()).unwrap();
    let encoded = signing_key.verifying_key().to_encoded_point(false);
    let pub_bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
    (signing_key, pub_bytes)
}

fn str_to_bytes(env: &Env, s: &str) -> Bytes {
    let mut b = Bytes::new(env);
    for &byte in s.as_bytes() {
        b.push_back(byte);
    }
    b
}

/// Base64url without padding — a 32-byte payload is always 43 ASCII bytes.
fn base64url_32(input: &[u8; 32]) -> [u8; 43] {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = [0u8; 43];
    let mut o = 0usize;
    let mut i = 0usize;
    while i + 3 <= 30 {
        let b0 = input[i] as u32;
        let b1 = input[i + 1] as u32;
        let b2 = input[i + 2] as u32;
        out[o] = T[((b0 >> 2) & 0x3f) as usize];
        out[o + 1] = T[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize];
        out[o + 2] = T[(((b1 << 2) | (b2 >> 6)) & 0x3f) as usize];
        out[o + 3] = T[(b2 & 0x3f) as usize];
        i += 3;
        o += 4;
    }
    let b0 = input[30] as u32;
    let b1 = input[31] as u32;
    out[40] = T[((b0 >> 2) & 0x3f) as usize];
    out[41] = T[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize];
    out[42] = T[((b1 << 2) & 0x3f) as usize];
    out
}

/// clientDataJSON bytes, into a fixed buffer so this stays `no_std`-clean.
/// The origin must match ORIGIN above, which the contract binds against.
fn cdj_bytes(payload: &[u8; 32]) -> ([u8; 256], usize) {
    let challenge = base64url_32(payload);
    let prefix = b"{\"type\":\"webauthn.get\",\"challenge\":\"";
    let suffix = b"\",\"origin\":\"https://test.veil\",\"crossOrigin\":false}";

    let mut buf = [0u8; 256];
    let mut pos = 0usize;
    for &b in prefix {
        buf[pos] = b;
        pos += 1;
    }
    for &b in &challenge {
        buf[pos] = b;
        pos += 1;
    }
    for &b in suffix {
        buf[pos] = b;
        pos += 1;
    }
    (buf, pos)
}

/// 37-byte authenticatorData: SHA256(rp_id), then flags, then signCount.
fn make_auth_data(env: &Env) -> Bytes {
    let hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(RP_ID.as_bytes());
        h.finalize().into()
    };
    let mut ad = [0u8; 37];
    ad[..32].copy_from_slice(&hash);
    ad[32] = 0x05; // User Present | User Verified
    Bytes::from_array(env, &ad)
}

/// The 5-element signature `Val` the WebAuthn branch expects:
/// `[pubkey(65), authData, clientDataJSON, sig(64), nonce]`.
///
/// Five, not four. A four-element vector is an `InvalidSignatureFormat`, and
/// the nonce is what makes one assertion usable exactly once.
fn assertion(
    env: &Env,
    sk: &SigningKey,
    pub_bytes: &[u8; 65],
    payload: &[u8; 32],
    nonce: u64,
) -> Val {
    let auth_data = make_auth_data(env);
    let (cdj_buf, cdj_len) = cdj_bytes(payload);

    let cdj_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(&cdj_buf[..cdj_len]);
        h.finalize().into()
    };

    let mut ad_buf = [0u8; 64];
    let ad_len = auth_data.len() as usize;
    for i in 0..ad_len {
        ad_buf[i] = auth_data.get_unchecked(i as u32);
    }

    let msg_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(&ad_buf[..ad_len]);
        h.update(cdj_hash);
        h.finalize().into()
    };

    let sig: P256Sig = sk.sign_prehash(&msg_hash).unwrap();
    let sig = sig.normalize_s().unwrap_or(sig);
    let sig_bytes: [u8; 64] = sig.to_bytes().into();

    let mut cdj = Bytes::new(env);
    for i in 0..cdj_len {
        cdj.push_back(cdj_buf[i]);
    }

    Vec::<Val>::from_array(
        env,
        [
            BytesN::from_array(env, pub_bytes).into_val(env),
            auth_data.into_val(env),
            cdj.into_val(env),
            BytesN::<64>::from_array(env, &sig_bytes).into_val(env),
            nonce.into_val(env),
        ],
    )
    .into_val(env)
}

fn setup(env: &Env) -> (InvisibleWalletClient, [u8; 65], SigningKey) {
    let (sk, pub_bytes) = test_keypair();
    let id = env.register_contract(None, InvisibleWallet);
    let client = InvisibleWalletClient::new(env, &id);
    client.init(
        &BytesN::from_array(env, &pub_bytes),
        &str_to_bytes(env, RP_ID),
        &str_to_bytes(env, ORIGIN),
    );
    (client, pub_bytes, sk)
}

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

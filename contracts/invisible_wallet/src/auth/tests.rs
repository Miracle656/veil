// Happy-path __check_auth tests — authenticatorData size coverage
//
// Real authenticators produce auth_data of varying lengths:
//   37 B  — minimal: rpIdHash (32) + flags (1) + signCount (4)
//  100 B  — with attested credential data stub
//  200 B  — with CBOR extensions stub
//
// verify_rp_id only reads auth_data[0..32], so the contract must accept any
// length ≥ 32. Each test builds a cryptographically valid P-256 / WebAuthn
// ES256 fixture and asserts __check_auth returns Ok(()) + increments the nonce.

extern crate alloc;

use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature as P256Sig, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::{Bytes, BytesN, Env, IntoVal, Vec, Val};
use soroban_sdk::auth::Context;

use crate::{InvisibleWallet, InvisibleWalletClient, WalletError};

trait CheckAuthTestHelper {
    fn __check_auth(&self, payload: &BytesN<32>, signature: &Val, contexts: &Vec<Context>);
    fn try___check_auth(&self, payload: &BytesN<32>, signature: &Val, contexts: &Vec<Context>) -> Result<(), Result<WalletError, soroban_sdk::InvokeError>>;
}

impl<'a> CheckAuthTestHelper for InvisibleWalletClient<'a> {
    fn __check_auth(&self, payload: &BytesN<32>, signature: &Val, contexts: &Vec<Context>) {
        self.env.try_invoke_contract_check_auth::<WalletError>(&self.address, payload, *signature, contexts).unwrap();
    }

    fn try___check_auth(&self, payload: &BytesN<32>, signature: &Val, contexts: &Vec<Context>) -> Result<(), Result<WalletError, soroban_sdk::InvokeError>> {
        self.env.try_invoke_contract_check_auth::<WalletError>(&self.address, payload, *signature, contexts)
    }
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

fn test_keypair() -> (SigningKey, [u8; 65]) {
    let signing_key = SigningKey::from_bytes(&[42u8; 32].into()).unwrap();
    let encoded = signing_key.verifying_key().to_encoded_point(false);
    let pub_bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
    (signing_key, pub_bytes)
}

fn bytes_from_slice(env: &Env, s: &[u8]) -> Bytes {
    let mut b = Bytes::new(env);
    for &byte in s {
        b.push_back(byte);
    }
    b
}

// challenge_b64 = base64url([7u8; 32]) — must match the signature_payload
// passed to __check_auth so verify_webauthn's challenge check passes.
const CHALLENGE_B64: &[u8; 43] = b"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

fn build_client_data_json_bytes() -> alloc::vec::Vec<u8> {
    let mut out = alloc::vec::Vec::<u8>::new();
    out.extend_from_slice(b"{\"type\":\"webauthn.get\",\"challenge\":\"");
    out.extend_from_slice(CHALLENGE_B64);
    out.extend_from_slice(b"\",\"origin\":\"https://test.example\",\"crossOrigin\":false}");
    out
}

fn build_client_data_json(env: &Env) -> Bytes {
    bytes_from_slice(env, &build_client_data_json_bytes())
}

/// Build a valid WebAuthn ES256 fixture with an auth_data of `size` bytes.
/// auth_data[0..32] = SHA-256("localhost") so verify_rp_id passes.
/// The ECDSA signature is recomputed for every distinct auth_data length.
fn make_fixture(
    signing_key: &SigningKey,
    auth_data_size: usize,
) -> (alloc::vec::Vec<u8>, [u8; 64]) {
    assert!(auth_data_size >= 37);

    let rp_id_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(b"localhost");
        h.finalize().into()
    };

    let mut auth_data = alloc::vec![0u8; auth_data_size];
    auth_data[..32].copy_from_slice(&rp_id_hash);
    auth_data[32] = 0x05; // flags: UP=1, UV=1

    let cdj_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(&build_client_data_json_bytes());
        h.finalize().into()
    };

    let msg_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(&auth_data);
        h.update(cdj_hash);
        h.finalize().into()
    };

    let sig: P256Sig = signing_key.sign_prehash(&msg_hash).unwrap();
    let sig = sig.normalize_s().unwrap_or(sig);
    (auth_data, sig.to_bytes().into())
}

// ── Shared test driver ────────────────────────────────────────────────────────

fn run_happy_path(auth_data_size: usize) {
    let env = Env::default();
    let (signing_key, pub_bytes) = test_keypair();

    let contract_id = env.register_contract(None, InvisibleWallet);
    let client = InvisibleWalletClient::new(&env, &contract_id);

    client.init(
        &BytesN::from_array(&env, &pub_bytes),
        &bytes_from_slice(&env, b"localhost"),
        &bytes_from_slice(&env, b"https://test.example"),
    );

    // signature_payload = [7u8; 32] whose base64url encoding is CHALLENGE_B64
    let payload = [7u8; 32];
    let (auth_data_raw, sig_bytes) = make_fixture(&signing_key, auth_data_size);

    let mut auth_data_bytes = Bytes::new(&env);
    for &b in &auth_data_raw {
        auth_data_bytes.push_back(b);
    }

    let signature = Vec::<Val>::from_array(
        &env,
        [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            auth_data_bytes.into_val(&env),
            build_client_data_json(&env).into_val(&env),
            BytesN::from_array(&env, &sig_bytes).into_val(&env),
            0u64.into_val(&env), // nonce
        ],
    )
    .into_val(&env);

    client.__check_auth(
        &BytesN::from_array(&env, &payload),
        &signature,
        &Vec::new(&env),
    );

    assert_eq!(client.get_nonce(), 1, "nonce must increment after successful auth");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[test]
fn check_auth_happy_path_37b() {
    run_happy_path(37);
}

#[test]
fn check_auth_happy_path_100b() {
    run_happy_path(100);
}

#[test]
fn check_auth_happy_path_200b() {
    run_happy_path(200);
}

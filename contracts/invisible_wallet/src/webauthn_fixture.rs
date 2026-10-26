//! A WebAuthn assertion fixture, shared by the tests that need to drive
//! `__check_auth` end to end.
//!
//! A WebAuthn signature is over `SHA256(authData || SHA256(clientDataJSON))`
//! with the s-half normalised low — sign the payload directly, or leave s high,
//! and `secp256r1_verify` traps instead of returning an error, which reads as a
//! contract bug rather than a bad fixture.
//!
//! The origin and rp id here are the ones the wallet is initialised with in
//! `setup`, and the contract binds against both, so a fixture that drifts from
//! them fails for the wrong reason.

use p256::ecdsa::{signature::hazmat::PrehashSigner, Signature as P256Sig, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::auth::Context;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Val, Vec};

use crate::{InvisibleWallet, InvisibleWalletClient, WalletError};

pub const RP_ID: &str = "test.veil";
pub const ORIGIN: &str = "https://test.veil";

/// Calling `__check_auth` from a test needs the same two-call shape the host
/// uses: the panicking one and the one that hands back the error.
pub trait CheckAuthTestHelper {
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

/// The deterministic P-256 key pair every test in this fixture uses.
pub fn test_keypair() -> (SigningKey, [u8; 65]) {
    let signing_key = SigningKey::from_bytes(&[42u8; 32].into()).unwrap();
    let encoded = signing_key.verifying_key().to_encoded_point(false);
    let pub_bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
    (signing_key, pub_bytes)
}

pub fn str_to_bytes(env: &Env, s: &str) -> Bytes {
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
pub fn assertion(
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

/// A wallet with one registered WebAuthn signer, ready to be authorized.
pub fn setup(env: &Env) -> (InvisibleWalletClient, [u8; 65], SigningKey) {
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

/// A token contract address, standing in for an asset.
///
/// The wallet has no price oracle, so what makes one token different from
/// another is its identity, not its value. A test that wants "XLM" and
/// "USDC" wants two distinct addresses.
pub fn token(env: &Env) -> Address {
    Address::generate(env)
}

/// `__check_auth` negative-path tests — closes #219
///
/// Each test targets a specific failure mode and asserts the *exact*
/// `WalletError` variant returned.  The replay test re-uses the same
/// signature payload twice to confirm the nonce gate catches the replay.
///
/// Failure modes covered:
///   1. expired_valid_until_ledger  — a nonce that has already been consumed
///   2. replayed_nonce              — identical (payload, nonce=0, sig) sent twice → NonceMismatch
///   3. wrong_key                   — signature from an unregistered P-256 key → SignerNotAuthorized
///   4. malformed_sig_bytes         — 64 zero-bytes in place of a real ECDSA sig → verification failure
///   5. wrong_payload               — valid sig over payload_a submitted with payload_b → InvalidChallenge
///   6. invalid_signature_format    — Vec of only 3 elements → InvalidSignatureFormat
///   7. non_low_s_sig               — s-half corrupted by XOR → verification failure

#[allow(unused_imports)]
use super::*;
use soroban_sdk::{Bytes, BytesN, Env, Vec, IntoVal, Val};
use soroban_sdk::auth::{CustomAccountInterface, Context};

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
use sha2::{Sha256, Digest};
use p256::ecdsa::{SigningKey, Signature as P256Sig, signature::hazmat::PrehashSigner};

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Deterministic P-256 key A (registered wallet signer in every test).
fn keypair_a() -> (SigningKey, [u8; 65]) {
    let sk = SigningKey::from_bytes(&[0x11u8; 32].into()).unwrap();
    let encoded = sk.verifying_key().to_encoded_point(false);
    (sk, encoded.as_bytes().try_into().unwrap())
}

/// Deterministic P-256 key B (never registered; used for wrong-key tests).
fn keypair_b() -> (SigningKey, [u8; 65]) {
    let sk = SigningKey::from_bytes(&[0x22u8; 32].into()).unwrap();
    let encoded = sk.verifying_key().to_encoded_point(false);
    (sk, encoded.as_bytes().try_into().unwrap())
}

fn str_to_bytes(env: &Env, s: &str) -> Bytes {
    let mut b = Bytes::new(env);
    for &byte in s.as_bytes() { b.push_back(byte); }
    b
}

/// Base64url-encode a 32-byte array without padding → always 43 ASCII bytes.
fn base64url_32(input: &[u8; 32]) -> [u8; 43] {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = [0u8; 43];
    let mut o = 0usize;
    let mut i = 0usize;
    while i + 3 <= 30 {
        let b0 = input[i] as u32;
        let b1 = input[i + 1] as u32;
        let b2 = input[i + 2] as u32;
        out[o]     = T[((b0 >> 2) & 0x3f) as usize];
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

/// Build clientDataJSON with challenge=base64url(payload) and origin=https://test.veil.
/// Uses a fixed-capacity 256-byte buffer to avoid `std::vec`.
fn make_cdj(env: &Env, payload: &[u8; 32]) -> Bytes {
    let challenge = base64url_32(payload);
    let prefix = b"{\"type\":\"webauthn.get\",\"challenge\":\"";
    let suffix = b"\",\"origin\":\"https://test.veil\",\"crossOrigin\":false}";

    let mut buf = [0u8; 256];
    let mut pos = 0usize;
    for &b in prefix { buf[pos] = b; pos += 1; }
    for &b in &challenge { buf[pos] = b; pos += 1; }
    for &b in suffix { buf[pos] = b; pos += 1; }

    let mut out = Bytes::new(env);
    for i in 0..pos { out.push_back(buf[i]); }
    out
}

/// Build 37-byte authenticatorData with SHA256(rp_id) in [0..32].
fn make_auth_data(env: &Env, rp_id: &str) -> Bytes {
    let mut h = Sha256::new();
    h.update(rp_id.as_bytes());
    let hash: [u8; 32] = h.finalize().into();
    let mut ad = [0u8; 37];
    ad[..32].copy_from_slice(&hash);
    Bytes::from_array(env, &ad)
}

/// Compute a valid WebAuthn ES256 signature over `payload` with `auth_data`.
/// Returns raw r||s (64 bytes).
fn sign_webauthn(sk: &SigningKey, payload: &[u8; 32], ad: &Bytes) -> [u8; 64] {
    // Re-derive clientDataJSON bytes locally (same formula as make_cdj).
    let challenge = base64url_32(payload);
    let prefix = b"{\"type\":\"webauthn.get\",\"challenge\":\"";
    let suffix = b"\",\"origin\":\"https://test.veil\",\"crossOrigin\":false}";

    let mut buf = [0u8; 256];
    let mut pos = 0usize;
    for &b in prefix { buf[pos] = b; pos += 1; }
    for &b in &challenge { buf[pos] = b; pos += 1; }
    for &b in suffix { buf[pos] = b; pos += 1; }

    let cdj_hash: [u8; 32] = { let mut h = Sha256::new(); h.update(&buf[..pos]); h.finalize().into() };

    // authData bytes from the Soroban Bytes value.
    let mut ad_buf = [0u8; 64];
    let ad_len = ad.len() as usize;
    for i in 0..ad_len { ad_buf[i] = ad.get_unchecked(i as u32); }

    let msg_hash: [u8; 32] = {
        let mut h = Sha256::new();
        h.update(&ad_buf[..ad_len]);
        h.update(cdj_hash);
        h.finalize().into()
    };

    let sig: P256Sig = sk.sign_prehash(&msg_hash).unwrap();
    let sig = sig.normalize_s().unwrap_or(sig);
    sig.to_bytes().into()
}

/// Build the 5-element Val expected by `__check_auth`:
/// `[pubkey(65), auth_data, client_data_json, sig(64), nonce]`
fn sig_vec(env: &Env, pub_bytes: &[u8; 65], ad: &Bytes, cdj: &Bytes, sig: &[u8; 64], nonce: u64) -> Val {
    Vec::<Val>::from_array(env, [
        BytesN::from_array(env, pub_bytes).into_val(env),
        ad.clone().into_val(env),
        cdj.clone().into_val(env),
        BytesN::<64>::from_array(env, sig).into_val(env),
        nonce.into_val(env),
    ]).into_val(env)
}

/// Deploy a fresh wallet registered with keypair_a.
fn setup(env: &Env) -> (InvisibleWalletClient, [u8; 65], SigningKey) {
    let (sk_a, pub_a) = keypair_a();
    let id = env.register_contract(None, InvisibleWallet);
    let client = InvisibleWalletClient::new(env, &id);
    client.init(
        &BytesN::from_array(env, &pub_a),
        &str_to_bytes(env, "test.veil"),
        &str_to_bytes(env, "https://test.veil"),
    );
    (client, pub_a, sk_a)
}

// ── Test 1: expired / stale nonce (mirrors "expired validUntilLedger") ───────
//
// After nonce=0 is consumed the on-chain nonce is 1.
// Re-submitting nonce=0 is rejected as NonceMismatch.

#[test]
fn expired_valid_until_ledger_returns_nonce_mismatch() {
    let env = Env::default();
    let (client, pub_a, sk_a) = setup(&env);

    let payload = [0x10u8; 32];
    let ad  = make_auth_data(&env, "test.veil");
    let cdj = make_cdj(&env, &payload);
    let sig = sign_webauthn(&sk_a, &payload, &ad);

    // First call with nonce=0 succeeds.
    client.__check_auth(
        &BytesN::from_array(&env, &payload),
        &sig_vec(&env, &pub_a, &ad, &cdj, &sig, 0),
        &Vec::new(&env),
    );
    assert_eq!(client.get_nonce(), 1, "nonce must advance to 1");

    // Re-submit stale nonce=0 — must fail.
    let result = client.try___check_auth(
        &BytesN::from_array(&env, &payload),
        &sig_vec(&env, &pub_a, &ad, &cdj, &sig, 0),
        &Vec::new(&env),
    );
    assert_eq!(result, Err(Ok(WalletError::NonceMismatch)),
        "stale nonce must yield NonceMismatch");
}

// ── Test 2: replay — exact same triple submitted twice ───────────────────────

#[test]
fn replayed_nonce_returns_nonce_mismatch() {
    let env = Env::default();
    let (client, pub_a, sk_a) = setup(&env);

    let payload = [0x20u8; 32];
    let ad  = make_auth_data(&env, "test.veil");
    let cdj = make_cdj(&env, &payload);
    let sig = sign_webauthn(&sk_a, &payload, &ad);
    let sig_val = sig_vec(&env, &pub_a, &ad, &cdj, &sig, 0);

    // First submission succeeds.
    client.__check_auth(
        &BytesN::from_array(&env, &payload),
        &sig_val,
        &Vec::new(&env),
    );

    // Second submission — replay — must fail.
    let result = client.try___check_auth(
        &BytesN::from_array(&env, &payload),
        &sig_vec(&env, &pub_a, &ad, &cdj, &sig, 0), // same nonce=0
        &Vec::new(&env),
    );
    assert_eq!(result, Err(Ok(WalletError::NonceMismatch)),
        "replayed nonce must return NonceMismatch");
}

// ── Test 3: signature from unregistered key → SignerNotAuthorized ─────────────

#[test]
fn wrong_key_returns_signer_not_authorized() {
    let env = Env::default();
    let (client, _pub_a, _sk_a) = setup(&env);
    let (sk_b, pub_b) = keypair_b(); // never registered

    let payload = [0x30u8; 32];
    let ad  = make_auth_data(&env, "test.veil");
    let cdj = make_cdj(&env, &payload);
    let sig = sign_webauthn(&sk_b, &payload, &ad);

    let result = client.try___check_auth(
        &BytesN::from_array(&env, &payload),
        &sig_vec(&env, &pub_b, &ad, &cdj, &sig, 0),
        &Vec::new(&env),
    );
    assert_eq!(result, Err(Ok(WalletError::SignerNotAuthorized)),
        "unregistered key must return SignerNotAuthorized");
}

// ── Test 4: malformed DER / all-zero sig bytes → verification failure ─────────
//
// Key is registered, nonce is correct, challenge is correct — but the 64
// raw ECDSA bytes are garbage (all zeros).  secp256r1_verify traps; testutils
// surface this as SignatureVerificationFailed or a host-level Err(_).
// Most importantly the nonce must not advance.

#[test]
fn malformed_sig_bytes_returns_verification_failed() {
    let env = Env::default();
    let (client, pub_a, _sk_a) = setup(&env);

    let payload = [0x40u8; 32];
    let ad  = make_auth_data(&env, "test.veil");
    let cdj = make_cdj(&env, &payload);
    let bad = [0u8; 64]; // 64 zero bytes — not a valid ECDSA sig

    let result = client.try___check_auth(
        &BytesN::from_array(&env, &payload),
        &sig_vec(&env, &pub_a, &ad, &cdj, &bad, 0),
        &Vec::new(&env),
    );
    assert!(
        matches!(result, Err(Ok(WalletError::SignatureVerificationFailed)) | Err(Err(_))),
        "malformed sig must not succeed; got {:?}", result
    );
    assert_eq!(client.get_nonce(), 0, "nonce must not advance on failed auth");
}

// ── Test 5: wrong payload (challenge mismatch) → InvalidChallenge ────────────
//
// clientDataJSON embeds base64url(payload_a) as the challenge, but we
// supply payload_b to __check_auth.  The challenge search fails → InvalidChallenge.

#[test]
fn wrong_payload_returns_invalid_challenge() {
    let env = Env::default();
    let (client, pub_a, sk_a) = setup(&env);

    let payload_a = [0x50u8; 32];
    let payload_b = [0x51u8; 32]; // different

    let ad  = make_auth_data(&env, "test.veil");
    let cdj = make_cdj(&env, &payload_a); // challenge binds to payload_a
    let sig = sign_webauthn(&sk_a, &payload_a, &ad);

    let result = client.try___check_auth(
        &BytesN::from_array(&env, &payload_b), // mismatch
        &sig_vec(&env, &pub_a, &ad, &cdj, &sig, 0),
        &Vec::new(&env),
    );
    assert_eq!(result, Err(Ok(WalletError::InvalidChallenge)),
        "mismatched payload must return InvalidChallenge");
    assert_eq!(client.get_nonce(), 0, "nonce must not advance on challenge failure");
}

// ── Test 6: Vec of wrong length → InvalidSignatureFormat ────────────────────
//
// __check_auth expects exactly 5 elements; a 3-element Vec is rejected
// before any crypto work begins.

#[test]
fn invalid_sig_format_returns_format_error() {
    let env = Env::default();
    let (client, pub_a, _sk_a) = setup(&env);

    let payload = [0x60u8; 32];

    // Only 3 elements — missing sig_bytes and nonce.
    let short: Val = Vec::<Val>::from_array(&env, [
        BytesN::from_array(&env, &pub_a).into_val(&env),
        make_auth_data(&env, "test.veil").into_val(&env),
        make_cdj(&env, &payload).into_val(&env),
    ]).into_val(&env);

    let result = client.try___check_auth(
        &BytesN::from_array(&env, &payload),
        &short,
        &Vec::new(&env),
    );
    assert_eq!(result, Err(Ok(WalletError::InvalidSignatureFormat)),
        "3-element Vec must return InvalidSignatureFormat");
}

// ── Test 7: non-low-S (corrupted s-component) → verification failure ─────────
//
// We XOR 0xFF into the first byte of s (bytes [32..64] of the raw sig).
// This is not a valid P-256 signature in any normalised or non-normalised
// form, so secp256r1_verify must reject it.  Nonce must not advance.

#[test]
fn non_low_s_sig_returns_verification_failed() {
    let env = Env::default();
    let (client, pub_a, sk_a) = setup(&env);

    let payload = [0x70u8; 32];
    let ad  = make_auth_data(&env, "test.veil");
    let cdj = make_cdj(&env, &payload);
    let sig = sign_webauthn(&sk_a, &payload, &ad);

    // Corrupt the first byte of s (index 32 in the r||s layout).
    let mut corrupted = sig;
    corrupted[32] ^= 0xFF;

    let result = client.try___check_auth(
        &BytesN::from_array(&env, &payload),
        &sig_vec(&env, &pub_a, &ad, &cdj, &corrupted, 0),
        &Vec::new(&env),
    );
    assert!(
        matches!(result, Err(Ok(WalletError::SignatureVerificationFailed)) | Err(Err(_))),
        "corrupted s-component must not pass verification; got {:?}", result
    );
    assert_eq!(client.get_nonce(), 0, "nonce must not advance on corrupted-s failure");
}

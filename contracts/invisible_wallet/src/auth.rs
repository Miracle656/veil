use soroban_sdk::{contracttype, Bytes, BytesN, Env};
use crate::WalletError;

#[contracttype]
pub struct WebAuthnSignature {
    pub public_key: BytesN<65>,
    pub auth_data: Bytes,
    pub client_data_json: Bytes,
    pub signature: BytesN<64>,
    pub nonce: u64,
}

const BASE64URL: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// Base64url-encode exactly 32 bytes without padding.
/// 32 bytes → always 43 output chars: 10 full groups of 3 + 1 group of 2.
fn base64url_encode_32(input: &[u8; 32]) -> [u8; 43] {
    let mut out = [0u8; 43];
    let mut o = 0usize;
    let mut i = 0usize;
    while i + 3 <= 30 {
        let b0 = input[i] as u32;
        let b1 = input[i + 1] as u32;
        let b2 = input[i + 2] as u32;
        out[o]     = BASE64URL[((b0 >> 2) & 0x3f) as usize];
        out[o + 1] = BASE64URL[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize];
        out[o + 2] = BASE64URL[(((b1 << 2) | (b2 >> 6)) & 0x3f) as usize];
        out[o + 3] = BASE64URL[(b2 & 0x3f) as usize];
        i += 3;
        o += 4;
    }
    // Final 2 bytes (input[30], input[31]) → 3 output chars, no padding
    let b0 = input[30] as u32;
    let b1 = input[31] as u32;
    out[40] = BASE64URL[((b0 >> 2) & 0x3f) as usize];
    out[41] = BASE64URL[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize];
    out[42] = BASE64URL[((b1 << 2) & 0x3f) as usize];
    out
}

/// Verify that the base64url(signature_payload) string appears inside clientDataJSON.
/// The WebAuthn spec embeds the challenge as a base64url string in the JSON, so this
/// confirms the assertion was specifically for this Soroban auth payload.
fn challenge_is_present(client_data_json: &Bytes, signature_payload: &[u8; 32]) -> bool {
    let needle = base64url_encode_32(signature_payload);
    let n_len = needle.len(); // 43
    let h_len = client_data_json.len() as usize;
    if h_len < n_len {
        return false;
    }
    'outer: for start in 0..=(h_len - n_len) {
        for j in 0..n_len {
            if client_data_json.get_unchecked((start + j) as u32) != needle[j] {
                continue 'outer;
            }
        }
        return true;
    }
    false
}

// ── Domain binding checks ─────────────────────────────────────────────────────

/// Assert that `auth_data[0..32]` equals `SHA-256(rp_id)`.
///
/// The WebAuthn spec defines the first 32 bytes of authenticatorData as the
/// rpIdHash — the SHA-256 of the relying party identifier (e.g. "veil.app").
/// This check ensures the assertion was produced for this wallet's domain and
/// cannot be replayed from a different origin.
///
/// Called from `__check_auth` after signature verification.
pub fn verify_rp_id(env: &Env, rp_id: &Bytes, auth_data: &Bytes) -> Result<(), WalletError> {
    // auth_data must be at least 37 bytes (rpIdHash + flags + signCount).
    // We only need the first 32 here.
    if auth_data.len() < 32 {
        return Err(WalletError::RpIdMismatch);
    }

    // Compute SHA-256(rp_id) via the Soroban host function (cheap, ~few hundred CPU).
    let expected = env.crypto().sha256(rp_id).to_array();

    // Compare byte-by-byte against auth_data[0..32]
    for i in 0..32u32 {
        if auth_data.get_unchecked(i) != expected[i as usize] {
            return Err(WalletError::RpIdMismatch);
        }
    }

    Ok(())
}

/// Assert that the `origin` field embedded in `clientDataJSON` equals `expected_origin`.
///
/// WebAuthn embeds the page origin inside clientDataJSON as:
///   `"origin":"https://veil.app"`
///
/// We parse this with a simple byte-slice search — no JSON parser needed and
/// no `serde` dependency (which would pull in `std`).
///
/// Called from `__check_auth` after signature verification.
pub fn verify_origin(
    client_data_json: &Bytes,
    expected_origin: &Bytes,
) -> Result<(), WalletError> {
    // The literal bytes we search for inside clientDataJSON.
    // Using the full key + colon + opening quote so we match the field precisely.
    let needle = b"\"origin\":\"";
    let n_len = needle.len(); // 10
    let h_len = client_data_json.len() as usize;

    // Locate the needle — find the index where the origin value starts (just after `"origin":"`)
    let value_start: Option<usize> = 'search: {
        for start in 0..h_len {
            if start + n_len > h_len {
                break;
            }
            let mut matched = true;
            for j in 0..n_len {
                if client_data_json.get_unchecked((start + j) as u32) != needle[j] {
                    matched = false;
                    break;
                }
            }
            if matched {
                break 'search Some(start + n_len);
            }
        }
        None
    };

    let value_start = value_start.ok_or(WalletError::OriginMismatch)?;

    // Find the closing `"` that terminates the origin value
    let value_end: Option<usize> = {
        let mut found = None;
        for i in value_start..h_len {
            if client_data_json.get_unchecked(i as u32) == b'"' {
                found = Some(i);
                break;
            }
        }
        found
    };

    let value_end = value_end.ok_or(WalletError::OriginMismatch)?;

    // Length must match exactly before doing the byte comparison
    let extracted_len = value_end - value_start;
    if extracted_len != expected_origin.len() as usize {
        return Err(WalletError::OriginMismatch);
    }

    // Compare the extracted origin bytes against the stored expected origin
    for i in 0..extracted_len {
        if client_data_json.get_unchecked((value_start + i) as u32)
            != expected_origin.get_unchecked(i as u32)
        {
            return Err(WalletError::OriginMismatch);
        }
    }

    Ok(())
}

// ── Signature verification ────────────────────────────────────────────────────

/// Verify a full WebAuthn ES256 assertion against a Soroban signature_payload.
///
/// The authenticator signs SHA256(authData || SHA256(clientDataJSON)).
/// The clientDataJSON must contain base64url(signature_payload) as its challenge field,
/// binding this assertion to the exact Soroban authorization entry being authorized.
///
/// Domain binding (rpIdHash and origin) is verified separately in `__check_auth`
/// after this function returns, to avoid leaking timing information on failure.
pub fn verify_webauthn(
    env: &Env,
    signature_payload: &BytesN<32>,
    public_key: BytesN<65>,
    auth_data: Bytes,
    client_data_json: Bytes,
    signature: BytesN<64>,
) -> Result<(), WalletError> {
    // 1. Verify the challenge in clientDataJSON is base64url(signature_payload)
    if !challenge_is_present(&client_data_json, &signature_payload.to_array()) {
        return Err(WalletError::InvalidChallenge);
    }

    // 2. SHA256(clientDataJSON) via host function
    let client_data_hash = env.crypto().sha256(&client_data_json);

    // 3. SHA256(authData || SHA256(clientDataJSON)) — exactly what the
    //    WebAuthn authenticator signed under ES256.
    let mut signed_data = Bytes::new(env);
    signed_data.append(&auth_data);
    signed_data.extend_from_array(&client_data_hash.to_array());
    let message_hash = env.crypto().sha256(&signed_data);

    // 4. Verify P-256 ECDSA signature using the secp256r1 host function.
    //    This costs a few thousand CPU instructions vs ~100M for the wasm
    //    p256 crate. The host function panics on verification failure;
    //    that surfaces as a HostError in diagnostics, distinguishable
    //    from our explicit WalletError variants by the trap kind.
    env.crypto().secp256r1_verify(&public_key, &message_hash, &signature);

    Ok(())
}

#[cfg(test)]
mod tests;
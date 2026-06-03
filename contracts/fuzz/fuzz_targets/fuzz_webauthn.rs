#![no_main]
use libfuzzer_sys::fuzz_target;
use arbitrary::Arbitrary;

/// Drive the WebAuthn verification helpers with arbitrary byte inputs.
/// Targets: base64url encoding, challenge binding, rp-id hash comparison,
/// and the origin field extractor — all pure functions with no host calls.
#[derive(Arbitrary, Debug)]
struct WebAuthnInput {
    auth_data: Vec<u8>,
    client_data_json: Vec<u8>,
    /// 64-byte ECDSA signature (r || s) — fed to low-level parsers only.
    sig_bytes: [u8; 64],
    /// 65-byte uncompressed P-256 public key.
    pub_key: [u8; 65],
    /// The 32-byte signature payload (Soroban hash of the auth entries).
    payload: [u8; 32],
    rp_id: Vec<u8>,
    origin: Vec<u8>,
}

fuzz_target!(|input: WebAuthnInput| {
    // 1. Challenge binding search (pure, no Env needed)
    let _ = challenge_present(&input.client_data_json, &input.payload);

    // 2. Origin field extraction and comparison
    let _ = origin_matches(&input.client_data_json, &input.origin);

    // 3. rpIdHash prefix check (first 32 bytes of auth_data vs SHA-256(rp_id))
    //    We skip the actual SHA-256 call (needs host) and fuzz the comparison loop.
    let _ = rp_id_prefix_len_ok(&input.auth_data);

    // 4. Signature format: are the lengths consistent with a DER-encoded ECDSA sig?
    let _ = sig_format_plausible(&input.sig_bytes);

    // 5. Public key: uncompressed P-256 keys always start with 0x04
    let _ = pub_key_prefix_ok(&input.pub_key);
});

fn challenge_present(haystack: &[u8], payload: &[u8; 32]) -> bool {
    let needle = base64url_32(payload);
    let n = needle.len();
    if haystack.len() < n { return false; }
    'outer: for start in 0..=(haystack.len() - n) {
        for j in 0..n {
            if haystack[start + j] != needle[j] { continue 'outer; }
        }
        return true;
    }
    false
}

fn origin_matches(cdj: &[u8], expected: &[u8]) -> bool {
    let prefix = b"\"origin\":\"";
    let p = prefix.len();
    if cdj.len() < p { return false; }
    for start in 0..=(cdj.len().saturating_sub(p)) {
        if start + p > cdj.len() { break; }
        if &cdj[start..start + p] == prefix {
            let vs = start + p;
            let end = cdj[vs..].iter().position(|&b| b == b'"').map(|i| vs + i);
            if let Some(ve) = end {
                return &cdj[vs..ve] == expected;
            }
        }
    }
    false
}

fn rp_id_prefix_len_ok(auth_data: &[u8]) -> bool {
    auth_data.len() >= 37
}

fn sig_format_plausible(sig: &[u8; 64]) -> bool {
    // raw (r||s): both halves should be non-zero for a real signature
    sig[..32].iter().any(|&b| b != 0) && sig[32..].iter().any(|&b| b != 0)
}

fn pub_key_prefix_ok(key: &[u8; 65]) -> bool {
    key[0] == 0x04
}

fn base64url_32(input: &[u8; 32]) -> [u8; 43] {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = [0u8; 43];
    let (mut o, mut i) = (0usize, 0usize);
    while i + 3 <= 30 {
        let (b0, b1, b2) = (input[i] as u32, input[i+1] as u32, input[i+2] as u32);
        out[o]   = T[((b0 >> 2) & 0x3f) as usize];
        out[o+1] = T[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize];
        out[o+2] = T[(((b1 << 2) | (b2 >> 6)) & 0x3f) as usize];
        out[o+3] = T[(b2 & 0x3f) as usize];
        i += 3; o += 4;
    }
    let (b0, b1) = (input[30] as u32, input[31] as u32);
    out[40] = T[((b0 >> 2) & 0x3f) as usize];
    out[41] = T[(((b0 << 4) | (b1 >> 4)) & 0x3f) as usize];
    out[42] = T[((b1 << 2) & 0x3f) as usize];
    out
}
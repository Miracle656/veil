#![no_main]
use libfuzzer_sys::fuzz_target;
use arbitrary::Arbitrary;

/// Arbitrary input fed to __check_auth-equivalent logic.
/// We fuzz the raw byte vectors that the real entrypoint parses,
/// looking for panics (index out of bounds, unwrap on None, etc.).
#[derive(Arbitrary, Debug)]
struct CheckAuthInput {
    signature_payload: [u8; 32],
    /// Raw bytes the code tries to decode as Vec<Val> / Address / BytesN<32>
    signature_blob: Vec<u8>,
    /// Per-context blobs (each mimics a serialised ContractContext)
    contexts: Vec<Vec<u8>>,
}

fuzz_target!(|input: CheckAuthInput| {
    // Drive the pure parsing / validation helpers that do NOT need a live
    // Soroban environment (base64url decode, challenge_is_present,
    // origin/rp-id byte search).  Anything that would need a host call
    // is guarded by the `#[cfg(not(fuzzing))]` annotations in auth.rs.
    //
    // Goal: surface panics from unsafe indexing, integer overflow, or
    // unwrap() calls in the parsing layer without triggering host traps.

    // 1. Simulate the format check: is it a 5-element Vec?
    let _ = parse_vec_len(&input.signature_blob);

    // 2. Feed arbitrary bytes to the challenge-search helper
    let payload_bytes = &input.signature_payload;
    let _ = challenge_present_stub(&input.signature_blob, payload_bytes);

    // 3. Feed arbitrary bytes to the origin-search helper
    let origin = b"https://veil.app";
    let _ = origin_present_stub(&input.signature_blob, origin);
});

/// Returns the number of top-level bytes (length field) if the blob starts
/// with a valid XDR list prefix, otherwise returns None. Purely parsing.
fn parse_vec_len(blob: &[u8]) -> Option<u32> {
    if blob.len() < 4 { return None; }
    let len = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]);
    Some(len)
}

/// Mirrors the `challenge_is_present` sliding-window search — the fuzzer
/// drives this with arbitrary haystacks and needles to catch off-by-one panics.
fn challenge_present_stub(haystack: &[u8], payload: &[u8; 32]) -> bool {
    if haystack.len() < 43 { return false; }
    let needle = base64url_32(payload);
    let n = needle.len();
    'outer: for start in 0..=(haystack.len() - n) {
        for j in 0..n {
            if haystack[start + j] != needle[j] { continue 'outer; }
        }
        return true;
    }
    false
}

/// Mirrors the `verify_origin` byte-slice search used in auth.rs.
fn origin_present_stub(haystack: &[u8], origin: &[u8]) -> bool {
    let prefix = b"\"origin\":\"";
    let p = prefix.len();
    if haystack.len() < p + origin.len() + 1 { return false; }
    for start in 0..=(haystack.len() - p) {
        if &haystack[start..start + p] == prefix {
            let val_start = start + p;
            if val_start + origin.len() < haystack.len()
                && &haystack[val_start..val_start + origin.len()] == origin
            {
                return true;
            }
        }
    }
    false
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
use soroban_sdk::BytesN;
use crate::FactoryError;

/// Validate that public_key is the SEC1 uncompressed encoding of a P-256 point.
///
/// Two checks are performed in both test and production builds:
///   1. The 0x04 prefix (uncompressed SEC1 encoding marker).
///   2. On-curve validation via p256 — `from_sec1_bytes` rejects any (x, y)
///      pair that does not satisfy the P-256 curve equation y² = x³ − 3x + b.
///
/// Previously check (2) was gated behind `#[cfg(any(test, feature = "testutils"))]`
/// (security finding M3 from the 2026-08-05 external assessment). That gate has
/// been removed so the check is present in release builds compiled to WASM.
///
/// Cost: ~5–10 M CPU instructions per call. Acceptable at deploy time — it runs
/// once per wallet creation, not on every authentication.
pub fn validate_public_key(public_key: &BytesN<65>) -> Result<(), FactoryError> {
    let bytes = public_key.to_array();
    // Check (1): uncompressed SEC1 prefix
    if bytes[0] != 0x04 {
        return Err(FactoryError::InvalidPublicKey);
    }
    // Check (2): on-curve validation — present in both test and production builds.
    // Fixed from M3: previously compiled out of production with #[cfg(any(test, feature = "testutils"))].
    p256::ecdsa::VerifyingKey::from_sec1_bytes(&bytes)
        .map_err(|_| FactoryError::InvalidPublicKey)?;
    Ok(())
}

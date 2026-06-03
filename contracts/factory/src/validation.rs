use soroban_sdk::BytesN;
use crate::FactoryError;

/// Sanity-check that public_key is the SEC1 uncompressed encoding of a P-256 point.
///
/// We only check the 0x04 prefix here; the actual curve-point validity is
/// verified by the secp256r1_verify host function during __check_auth at
/// signing time. Doing on-curve validation in wasm via the p256 crate at
/// deploy time would cost ~5–10M CPU instructions for a check the host
/// already performs implicitly.
pub fn validate_public_key(public_key: &BytesN<65>) -> Result<(), FactoryError> {
    let bytes = public_key.to_array();
    if bytes[0] != 0x04 {
        return Err(FactoryError::InvalidPublicKey);
    }
    #[cfg(any(test, feature = "testutils"))]
    {
        p256::ecdsa::VerifyingKey::from_sec1_bytes(&bytes)
            .map_err(|_| FactoryError::InvalidPublicKey)?;
    }
    Ok(())
}

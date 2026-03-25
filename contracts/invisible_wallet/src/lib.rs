#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracterror,
    Env, Address, Bytes, BytesN, Vec, Symbol, Val, String,
    auth::Context, FromVal, TryIntoVal,
};

mod auth;
mod storage;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum WalletError {
    AlreadyInitialized       = 1,
    InvalidSignatureFormat   = 2,
    SignerNotAuthorized      = 3,
    InvalidPublicKey         = 4,
    InvalidSignature         = 5,
    SignatureVerificationFailed = 6,
    InvalidChallenge         = 7,
    RpIdMismatch             = 8,
    OriginMismatch           = 9,
}

#[contract]
pub struct InvisibleWallet;

#[contractimpl]
impl InvisibleWallet {
    pub fn init(env: Env, initial_signer: BytesN<65>, rp_id: String, origin: String) -> Result<(), WalletError> {
        if storage::has_signer(&env, &initial_signer) {
            return Err(WalletError::AlreadyInitialized);
        }
        storage::add_signer(&env, &initial_signer);
        storage::set_rp_id(&env, &rp_id);
        storage::set_origin(&env, &origin);
        Ok(())
    }

    pub fn add_signer(env: Env, new_signer: BytesN<65>) {
        env.current_contract_address().require_auth();
        storage::add_signer(&env, &new_signer);
    }

    pub fn remove_signer(env: Env, signer: BytesN<65>) {
        env.current_contract_address().require_auth();
        storage::remove_signer(&env, &signer);
    }

    pub fn set_guardian(env: Env, guardian: BytesN<65>) {
        env.current_contract_address().require_auth();
        storage::set_guardian(&env, &guardian);
    }

    /// Called by the Soroban runtime to authorize a transaction.
    ///
    /// The `signature` Val must encode a Vec<Val> with 4 elements:
    ///   [0] BytesN<65>  — uncompressed P-256 public key (0x04 || x || y)
    ///   [1] Bytes       — WebAuthn authenticatorData
    ///   [2] Bytes       — WebAuthn clientDataJSON (must contain base64url(signature_payload) as challenge)
    ///   [3] BytesN<64>  — raw P-256 ECDSA signature (r || s)
    #[allow(non_snake_case)]
    pub fn __check_auth(
        env: Env,
        signature_payload: BytesN<32>,
        signature: Val,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), WalletError> {
        let parts: Vec<Val> = Vec::from_val(&env, &signature);
        if parts.len() != 4 {
            return Err(WalletError::InvalidSignatureFormat);
        }

        let public_key: BytesN<65> = parts
            .get(0).ok_or(WalletError::InvalidSignatureFormat)?
            .try_into_val(&env).map_err(|_| WalletError::InvalidSignatureFormat)?;

        let auth_data: Bytes = parts
            .get(1).ok_or(WalletError::InvalidSignatureFormat)?
            .try_into_val(&env).map_err(|_| WalletError::InvalidSignatureFormat)?;

        let client_data_json: Bytes = parts
            .get(2).ok_or(WalletError::InvalidSignatureFormat)?
            .try_into_val(&env).map_err(|_| WalletError::InvalidSignatureFormat)?;

        let sig_bytes: BytesN<64> = parts
            .get(3).ok_or(WalletError::InvalidSignatureFormat)?
            .try_into_val(&env).map_err(|_| WalletError::InvalidSignatureFormat)?;

        if !storage::has_signer(&env, &public_key) {
            return Err(WalletError::SignerNotAuthorized);
        }

        let rp_id = storage::get_rp_id(&env).unwrap();
        let origin = storage::get_origin(&env).unwrap();

        auth::verify_webauthn(&env, &signature_payload, public_key, auth_data, client_data_json, sig_bytes, rp_id, origin)
    }

    pub fn execute(env: Env, target: Address, func: Symbol, args: Vec<Val>) {
        env.current_contract_address().require_auth();
        env.invoke_contract::<Val>(&target, &func, args);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Bytes, BytesN, String};
    use sha2::{Sha256, Digest};
    use p256::ecdsa::{SigningKey, Signature as P256Sig, signature::hazmat::PrehashSigner};

    fn test_keypair() -> (SigningKey, [u8; 65]) {
        let signing_key = SigningKey::from_bytes(&[42u8; 32].into()).unwrap();
        let encoded = signing_key.verifying_key().to_encoded_point(false);
        let pub_bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
        (signing_key, pub_bytes)
    }

    /// Build a minimal valid WebAuthn test fixture for a given payload and signing key.
    /// Returns (auth_data_bytes, client_data_json_bytes, message_hash, sig_bytes).
    fn make_webauthn_fixture(
        signing_key: &SigningKey,
        _payload: &[u8; 32],
        rp_id: &str,
    ) -> ([u8; 37], [u8; 43], [u8; 32], [u8; 64]) {
        let mut auth_data = [0u8; 37];
        let mut h = Sha256::new();
        h.update(rp_id.as_bytes());
        let rp_hash: [u8; 32] = h.finalize().into();
        auth_data[..32].copy_from_slice(&rp_hash);

        // clientDataJSON challenge must be base64url(payload)
        // For payload = [7u8; 32]: base64url = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"
        let challenge_b64 = *b"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

        // SHA256(clientDataJSON) — we inline the JSON for the test
        let client_data_prefix  = b"{\"type\":\"webauthn.get\",\"challenge\":\"";
        let client_data_suffix  = b"\",\"origin\":\"https://test.example\",\"crossOrigin\":false}";
        let mut client_data_hash_input = [0u8; 256];
        let mut pos = 0;
        client_data_hash_input[pos..pos + client_data_prefix.len()].copy_from_slice(client_data_prefix);
        pos += client_data_prefix.len();
        client_data_hash_input[pos..pos + 43].copy_from_slice(&challenge_b64);
        pos += 43;
        client_data_hash_input[pos..pos + client_data_suffix.len()].copy_from_slice(client_data_suffix);
        pos += client_data_suffix.len();
        let client_data_json_bytes = &client_data_hash_input[..pos];

        let client_data_hash: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(client_data_json_bytes);
            h.finalize().into()
        };

        // message_hash = SHA256(authData || SHA256(clientDataJSON))
        let message_hash: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(auth_data);
            h.update(client_data_hash);
            h.finalize().into()
        };

        let sig: P256Sig = signing_key.sign_prehash(&message_hash).unwrap();
        let sig_bytes: [u8; 64] = sig.to_bytes().into();

        // Truncate client_data_json_bytes to a fixed-size array for returning
        let mut cdj = [0u8; 43];
        // We return the challenge_b64 as a proxy; tests build the full Bytes directly
        cdj.copy_from_slice(&challenge_b64);

        (auth_data, cdj, message_hash, sig_bytes)
    }

    /// Build the full clientDataJSON Bytes for Soroban from its parts.
    fn build_client_data_json(env: &Env, challenge_b64: &[u8; 43]) -> Bytes {
        let prefix = b"{\"type\":\"webauthn.get\",\"challenge\":\"";
        let suffix = b"\",\"origin\":\"https://test.example\",\"crossOrigin\":false}";
        let mut cdj = Bytes::new(env);
        for &b in prefix  { cdj.push_back(b); }
        for &b in challenge_b64 { cdj.push_back(b); }
        for &b in suffix  { cdj.push_back(b); }
        cdj
    }

    #[test]
    fn test_init_registers_signer() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let (_, pub_bytes) = test_keypair();
        client.init(&BytesN::from_array(&env, &pub_bytes), &String::from_str(&env, "localhost"), &String::from_str(&env, "https://test.example"));
    }

    #[test]
    fn test_init_twice_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let (_, pub_bytes) = test_keypair();
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        client.init(&pub_key, &String::from_str(&env, "localhost"), &String::from_str(&env, "https://test.example"));
        assert_eq!(client.try_init(&pub_key, &String::from_str(&env, "localhost"), &String::from_str(&env, "https://test.example")), Err(Ok(WalletError::AlreadyInitialized)));
    }

    #[test]
    fn test_verify_webauthn_valid() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];
        let rp_id = "test.example";

        let (auth_data_raw, challenge_b64, _, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, rp_id);

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
            String::from_str(&env, rp_id),
            String::from_str(&env, "https://test.example"),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_verify_webauthn_wrong_key_fails() {
        let env = Env::default();
        let (signing_key, _) = test_keypair();
        let (_, pub_bytes_wrong) = {
            let k = SigningKey::from_bytes(&[99u8; 32].into()).unwrap();
            let enc = k.verifying_key().to_encoded_point(false);
            let bytes: [u8; 65] = enc.as_bytes().try_into().unwrap();
            (k, bytes)
        };
        let payload = [7u8; 32];
        let rp_id = "test.example";

        let (auth_data_raw, challenge_b64, _, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, rp_id);

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes_wrong), // wrong key
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
            String::from_str(&env, rp_id),
            String::from_str(&env, "https://test.example"),
        );
        assert_eq!(result, Err(WalletError::SignatureVerificationFailed));
    }

    #[test]
    fn test_verify_webauthn_wrong_challenge_fails() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];
        let rp_id = "test.example";

        let (auth_data_raw, challenge_b64, _, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, rp_id);

        let wrong_payload = [8u8; 32];

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &wrong_payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
            String::from_str(&env, rp_id),
            String::from_str(&env, "https://test.example"),
        );
        assert_eq!(result, Err(WalletError::InvalidChallenge));
    }

    #[test]
    fn test_verify_webauthn_tampered_authdata_fails() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];
        let rp_id = "test.example";

        let (_, challenge_b64, _, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, rp_id);

        let tampered_auth_data = [0xffu8; 37];

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &tampered_auth_data),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
            String::from_str(&env, rp_id),
            String::from_str(&env, "https://test.example"),
        );
        assert_eq!(result, Err(WalletError::SignatureVerificationFailed));
    }

    #[test]
    fn test_verify_webauthn_rpid_mismatch_fails() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];
        let rp_id = "test.example";

        // Signature gets signed for rp_id="test.example"
        let (auth_data_raw, challenge_b64, _, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, rp_id);

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
            String::from_str(&env, "different-rp.example"), // Mismatch
            String::from_str(&env, "https://test.example"),
        );
        assert_eq!(result, Err(WalletError::RpIdMismatch));
    }

    #[test]
    fn test_verify_webauthn_origin_mismatch_fails() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];
        let rp_id = "test.example";

        let (auth_data_raw, challenge_b64, _, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, rp_id);

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
            String::from_str(&env, rp_id),
            String::from_str(&env, "https://different.origin"), // Mismatch
        );
        assert_eq!(result, Err(WalletError::OriginMismatch));
    }
}

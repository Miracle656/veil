#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracterror,
    Env, Address, Bytes, BytesN, Vec, Symbol, Val,
    auth::Context, FromVal, TryFromVal, TryIntoVal, symbol_short, Map};

mod auth;
mod storage;
use storage::{DataKey, AllowanceKey, PendingRecovery};

/// Recovery timelock duration: 3 days in seconds.
const RECOVERY_DELAY_SECONDS: u64 = 259_200;


#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum WalletError {
    AlreadyInitialized          = 1,
    InvalidSignatureFormat      = 2,
    SignerNotAuthorized         = 3,
    InvalidPublicKey            = 4,
    InvalidSignature            = 5,
    SignatureVerificationFailed = 6,
    InvalidChallenge            = 7,
    /// The rpIdHash in authenticatorData does not match SHA-256(stored rp_id).
    /// This means the assertion was produced for a different domain.
    RpIdMismatch                = 8,
    /// The origin field in clientDataJSON does not match the stored origin.
    /// This means the assertion was produced on a different website.
    OriginMismatch              = 9,
    /// Cannot remove the last remaining signer — wallet would become inaccessible.
    CannotRemoveLastSigner      = 10,
    /// The signer index does not exist in the signers map.
    SignerNotFound              = 11,
    /// Guardian recovery was requested but no guardian is set on this wallet.
    NoGuardianSet               = 12,
    /// A recovery is already pending — cannot start another one.
    RecoveryAlreadyPending      = 13,
    /// No recovery is pending — nothing to complete or cancel.
    RecoveryNotPending          = 14,
    /// The recovery timelock has not yet expired.
    RecoveryTimelockActive      = 15,
    /// The submitted nonce does not match the on-chain nonce (replay or out-of-order).
    NonceMismatch               = 16,
    /// The allowance is insufficient for this transfer.
    InsufficientAllowance       = 17,
    /// The allowance has expired.
    AllowanceExpired            = 18,
}

#[contract]
pub struct InvisibleWallet;

#[contractimpl]
impl InvisibleWallet {
    /// Initialise the wallet with its first signer and domain-binding parameters.
    ///
    /// `rp_id`   - the WebAuthn relying party ID (e.g. `"localhost"` for dev,
    ///             `"veil.app"` for production). Must match the domain that
    ///             serves the frontend. Keep it configurable - do not hardcode.
    ///
    /// `origin`  - the exact WebAuthn origin (e.g. `"https://veil.app"`).
    ///             Must match the `origin` field the browser embeds in every
    ///             clientDataJSON for this deployment.
    pub fn init(
        env: Env,
        initial_signer: BytesN<65>,
        rp_id: Bytes,
        origin: Bytes,
    ) -> Result<(), WalletError> {
        if storage::signer_count(&env) > 0 {
            return Err(WalletError::AlreadyInitialized);
        }
        storage::init_signers(&env, &initial_signer);
        storage::set_rp_id(&env, &rp_id);
        storage::set_origin(&env, &origin);
        // Step 0 — Initialise nonce to 0 (explicitly, though storage helper defaults to 0).
        env.storage().instance().set(&DataKey::Nonce, &0u64);
        Ok(())
    }

    /// Add a new signer key to the wallet. Requires authorization from the
    /// contract itself (i.e. an existing signer must authorize via `__check_auth`).
    /// Returns the index assigned to the new signer.
    pub fn add_signer(env: Env, new_public_key: BytesN<65>) -> u32 {
        env.current_contract_address().require_auth();
        storage::add_signer(&env, &new_public_key)
    }

    /// Remove a signer by index. Requires authorization from the contract.
    /// Rejects removal if it would leave the wallet with zero signers.
    pub fn remove_signer(env: Env, index: u32) -> Result<(), WalletError> {
        env.current_contract_address().require_auth();

        if storage::signer_count(&env) <= 1 {
            return Err(WalletError::CannotRemoveLastSigner);
        }

        if !storage::remove_signer(&env, index) {
            return Err(WalletError::SignerNotFound);
        }

        Ok(())
    }

    /// Called by the Soroban runtime to authorize a transaction.
    ///
    /// The `signature` Val must encode a Vec<Val> with 4 elements:
    ///   [0] BytesN<65>  - uncompressed P-256 public key (0x04 || x || y)
    ///   [1] Bytes       - WebAuthn authenticatorData
    ///   [2] Bytes       - WebAuthn clientDataJSON (must contain base64url(signature_payload) as challenge)
    ///   [3] BytesN<64>  - raw P-256 ECDSA signature (r || s)
    ///
    /// Verification order:
    ///   1. Parse and validate signature format
    ///   2. Check signer is registered (iterates all signers, short-circuits on first match)
    ///   3. Verify ECDSA signature + challenge binding  (`verify_webauthn`)
    ///   4. Verify rpIdHash binding                    (`verify_rp_id`)    -> RpIdMismatch
    ///   5. Verify origin binding                      (`verify_origin`)   -> OriginMismatch
    ///
    /// Steps 4 and 5 run after step 3 so that a bad domain does not produce
    /// a faster failure path than a bad signature (timing side-channel).
    pub fn __check_auth(
        env: Env,
        signature_payload: BytesN<32>,
        signature: Val,
        _auth_contexts: Vec<Context>,
    ) -> Result<(), WalletError> {
        // Check if the signature is actually a Spender Address claiming an allowance
        if let Ok(spender) = Address::try_from_val(&env, &signature) {
            spender.require_auth();

            for context in _auth_contexts.iter() {
                let Context::Contract(c) = context else {
                    return Err(WalletError::SignerNotAuthorized);
                };

                // We only allow token transfers via allowance
                if c.fn_name != Symbol::new(&env, "transfer") {
                    return Err(WalletError::SignerNotAuthorized);
                }

                if c.args.len() != 3 {
                    return Err(WalletError::SignerNotAuthorized);
                }

                let from = Address::try_from_val(&env, &c.args.get(0).unwrap())
                    .map_err(|_| WalletError::SignerNotAuthorized)?;
                if from != env.current_contract_address() {
                    return Err(WalletError::SignerNotAuthorized);
                }

                let amount = i128::try_from_val(&env, &c.args.get(2).unwrap())
                    .map_err(|_| WalletError::SignerNotAuthorized)?;

                let token = c.contract;

                let key = storage::DataKey::Allowance(AllowanceKey {
                    spender: spender.clone(),
                    token: token.clone(),
                });

                let mut allowance: storage::Allowance = env
                    .storage()
                    .persistent()
                    .get(&key)
                    .ok_or(WalletError::InsufficientAllowance)?;

                if let Some(expiry) = allowance.expiry {
                    if env.ledger().timestamp() > expiry {
                        return Err(WalletError::AllowanceExpired);
                    }
                }

                if amount > allowance.amount {
                    return Err(WalletError::InsufficientAllowance);
                }

                allowance.amount -= amount;
                env.storage().persistent().set(&key, &allowance);
            }

            return Ok(());
        }

        // Standard WebAuthn flow
        let parts: Vec<Val> = Vec::try_from_val(&env, &signature)
            .map_err(|_| WalletError::InvalidSignatureFormat)?;
        if parts.len() != 5 {
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

        let nonce: u64 = parts
            .get(4).ok_or(WalletError::InvalidSignatureFormat)?
            .try_into_val(&env).map_err(|_| WalletError::InvalidSignatureFormat)?;

        // Step 1 — Check registered signer
        if !storage::has_signer(&env, &public_key) {
            return Err(WalletError::SignerNotAuthorized);
        }

        // Step 2 — Nonce validation (MUST match exactly)
        let stored_nonce = storage::get_nonce(&env);
        if nonce != stored_nonce {
            return Err(WalletError::NonceMismatch);
        }

        // Step 3 — ECDSA + challenge verification.
        auth::verify_webauthn(
            &env,
            &signature_payload,
            public_key,
            auth_data.clone(),
            client_data_json.clone(),
            sig_bytes,
        )?;

        // Step 4 — RP ID binding.
        let rp_id = storage::get_rp_id(&env).ok_or(WalletError::RpIdMismatch)?;
        auth::verify_rp_id(&rp_id, &auth_data)?;

        // Step 5 — Origin binding.
        let origin = storage::get_origin(&env).ok_or(WalletError::OriginMismatch)?;
        auth::verify_origin(&client_data_json, &origin)?;

        // Step 6 — Increment nonce ONLY after all checks pass.
        storage::increment_nonce(&env);

        Ok(())
    }

    /// Return the current monotonic nonce for this wallet.
    pub fn get_nonce(env: Env) -> u64 {
        storage::get_nonce(&env)
    }

    pub fn has_signer(env: Env, key: BytesN<65>) -> bool {
        storage::has_signer(&env, &key)
    }

    pub fn get_signers(env: Env) -> Map<u32, BytesN<65>> {
        storage::get_signers(&env)
    }

    pub fn execute(env: Env, target: Address, func: Symbol, args: Vec<Val>) {
        env.current_contract_address().require_auth();
        env.invoke_contract::<Val>(&target, &func, args);
    }

    /// Set spending limit for a specific token and spender.
    ///
    /// Requires passkey authorization (i.e. from the contract itself).
    pub fn approve(
        env: Env,
        spender: Address,
        token: Address,
        amount: i128,
        expiry: Option<u64>,
    ) {
        env.current_contract_address().require_auth();
        
        if amount <= 0 {
            panic!("Amount must be greater than 0");
        }

        let key = storage::DataKey::Allowance(AllowanceKey { spender, token });
        let allowance = storage::Allowance { amount, expiry };
        
        env.storage().persistent().set(&key, &allowance);
    }

    /// Get the current allowance for a spender and token.
    pub fn get_allowance(env: Env, spender: Address, token: Address) -> Option<storage::Allowance> {
        let key = storage::DataKey::Allowance(AllowanceKey { spender, token });
        env.storage().persistent().get(&key)
    }

    /// Set or update the guardian address for this wallet.
    ///
    /// Only callable by the current wallet signer (authenticated via __check_auth).
    /// The guardian is authorized to initiate key recovery if the signer key is lost.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment handle.
    /// * `guardian` - The `Address` of the new guardian.
    pub fn set_guardian(env: Env, guardian: Address) {
        // Require that the contract itself (i.e. the wallet signer) authorizes this call.
        env.current_contract_address().require_auth();

        env.storage().persistent().set(&DataKey::Guardian, &guardian);

        env.events().publish(
            (symbol_short!("guardian"), symbol_short!("set")),
            guardian,
        );
    }

    /// Initiate a guardian recovery to replace the wallet signer key.
    ///
    /// Only callable by the designated guardian. Records the new public key
    /// and starts a timelock countdown. After the timelock expires,
    /// `complete_recovery` can be called to finalize the key replacement.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment handle.
    /// * `new_public_key` - The 65-byte uncompressed public key of the new signer.
    ///
    /// # Errors
    /// * `WalletError::NoGuardianSet` - if no guardian has been configured.
    /// * `WalletError::RecoveryAlreadyPending` - if a recovery is already in progress.
    pub fn initiate_recovery(env: Env, new_public_key: BytesN<65>) -> Result<(), WalletError> {
        // Verify a guardian is set
        let guardian: Address = env.storage()
            .persistent()
            .get(&DataKey::Guardian)
            .ok_or(WalletError::NoGuardianSet)?;

        // Require guardian authorization
        guardian.require_auth();

        // Prevent overwriting an existing pending recovery
        if env.storage().persistent().has(&DataKey::RecoveryPending) {
            return Err(WalletError::RecoveryAlreadyPending);
        }

        // Calculate unlock time: current ledger timestamp + 3 day delay
        let recovery_unlock_time = env.ledger().timestamp() + RECOVERY_DELAY_SECONDS;

        let pending = PendingRecovery {
            new_public_key: new_public_key.clone(),
            recovery_unlock_time,
        };

        env.storage().persistent().set(&DataKey::RecoveryPending, &pending);

        env.events().publish(
            (symbol_short!("recovery"), symbol_short!("init")),
            (new_public_key, recovery_unlock_time),
        );

        Ok(())
    }

    /// Complete a pending guardian recovery after the timelock has expired.
    ///
    /// This function is permissionless - anyone can call it once the timelock
    /// has expired. It replaces the wallet signer with the new public key
    /// that was specified during `initiate_recovery`.
    ///
    /// # Errors
    /// * `WalletError::RecoveryNotPending` - if no recovery has been initiated.
    /// * `WalletError::RecoveryTimelockActive` - if the timelock has not yet expired.
    pub fn complete_recovery(env: Env) -> Result<(), WalletError> {
        // Retrieve pending recovery
        let pending: PendingRecovery = env.storage()
            .persistent()
            .get(&DataKey::RecoveryPending)
            .ok_or(WalletError::RecoveryNotPending)?;

        // Verify timelock has expired
        if env.ledger().timestamp() < pending.recovery_unlock_time {
            return Err(WalletError::RecoveryTimelockActive);
        }

        // Replace signers: reset the map to only the recovered key at index 0.
        storage::init_signers(&env, &pending.new_public_key);

        // Clear the pending recovery
        env.storage().persistent().remove(&DataKey::RecoveryPending);

        env.events().publish(
            (symbol_short!("recovery"), symbol_short!("done")),
            pending.new_public_key,
        );

        Ok(())
    }

    /// Cancel a pending guardian recovery.
    ///
    /// Only callable by the current wallet signer (the contract itself must
    /// authorize). This allows a wallet owner who still has their key to
    /// abort an unwanted or malicious recovery attempt.
    ///
    /// # Errors
    /// * `WalletError::RecoveryNotPending` - if no recovery has been initiated.
    pub fn cancel_recovery(env: Env) -> Result<(), WalletError> {
        // Require current signer authorization
        env.current_contract_address().require_auth();

        // Verify a recovery is actually pending
        if !env.storage().persistent().has(&DataKey::RecoveryPending) {
            return Err(WalletError::RecoveryNotPending);
        }

        // Remove the pending recovery
        env.storage().persistent().remove(&DataKey::RecoveryPending);

        env.events().publish(
            (symbol_short!("recovery"), symbol_short!("cancel")),
            (),
        );

        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Bytes, BytesN, symbol_short, Map};
    use sha2::{Sha256, Digest};
    use p256::ecdsa::{SigningKey, Signature as P256Sig, signature::hazmat::PrehashSigner};

    fn test_keypair() -> (SigningKey, [u8; 65]) {
        let signing_key = SigningKey::from_bytes(&[42u8; 32].into()).unwrap();
        let encoded = signing_key.verifying_key().to_encoded_point(false);
        let pub_bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
        (signing_key, pub_bytes)
    }

    fn second_keypair() -> (SigningKey, [u8; 65]) {
        let signing_key = SigningKey::from_bytes(&[99u8; 32].into()).unwrap();
        let encoded = signing_key.verifying_key().to_encoded_point(false);
        let pub_bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
        (signing_key, pub_bytes)
    }

    /// Build a minimal valid WebAuthn test fixture for a given payload and signing key.
    fn make_webauthn_fixture(
        signing_key: &SigningKey,
        payload: &[u8; 32],
        rp_id_raw: &[u8],
    ) -> ([u8; 37], [u8; 43], [u8; 64]) {
        let rp_id_hash: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(rp_id_raw);
            h.finalize().into()
        };
        let mut auth_data = [0u8; 37];
        auth_data[..32].copy_from_slice(&rp_id_hash);

        let challenge_b64 = *b"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";

        let client_data_json_bytes = build_client_data_json_raw(&challenge_b64);

        let client_data_hash: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(&client_data_json_bytes);
            h.finalize().into()
        };

        let message_hash: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(auth_data);
            h.update(client_data_hash);
            h.finalize().into()
        };

        let sig: P256Sig = signing_key.sign_prehash(&message_hash).unwrap();
        let sig_bytes: [u8; 64] = sig.to_bytes().into();

        (auth_data, challenge_b64, sig_bytes)
    }

    fn build_client_data_json_raw(challenge_b64: &[u8; 43]) -> Vec<u8> {
        let prefix = b"{\"type\":\"webauthn.get\",\"challenge\":\"";
        let suffix = b"\",\"origin\":\"https://test.example\",\"crossOrigin\":false}";
        let mut out = Vec::new();
        out.extend_from_slice(prefix);
        out.extend_from_slice(challenge_b64);
        out.extend_from_slice(suffix);
        out
    }

    fn build_client_data_json(env: &Env, challenge_b64: &[u8; 43]) -> Bytes {
        let raw = build_client_data_json_raw(challenge_b64);
        let mut cdj = Bytes::new(env);
        for &b in &raw { cdj.push_back(b); }
        cdj
    }

    fn bytes_from_str(env: &Env, s: &str) -> Bytes {
        let mut b = Bytes::new(env);
        for &byte in s.as_bytes() { b.push_back(byte); }
        b
    }

    // ── Init tests ────────────────────────────────────────────────────────────

    #[test]
    fn test_init_registers_signer() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let (_, pub_bytes) = test_keypair();
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);
    }

    #[test]
    fn test_init_twice_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let (_, pub_bytes) = test_keypair();
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");
        client.init(&pub_key, &rp_id, &origin);
        assert_eq!(
            client.try_init(&pub_key, &rp_id, &origin),
            Err(Ok(WalletError::AlreadyInitialized))
        );
    }

    // ── Multi-signer tests ────────────────────────────────────────────────────

    #[test]
    fn test_add_signer_returns_index() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub_bytes) = test_keypair();
        let (_, pub_bytes_2) = second_keypair();
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        // Initial signer is at index 0, so next should be index 1
        let index = client.add_signer(&BytesN::from_array(&env, &pub_bytes_2));
        assert_eq!(index, 1);

        // Both signers should be recognized
        assert!(client.has_signer(&BytesN::from_array(&env, &pub_bytes)));
        assert!(client.has_signer(&BytesN::from_array(&env, &pub_bytes_2)));
    }

    #[test]
    fn test_remove_signer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub_bytes) = test_keypair();
        let (_, pub_bytes_2) = second_keypair();
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);
        client.add_signer(&BytesN::from_array(&env, &pub_bytes_2));

        // Remove the first signer (index 0)
        client.remove_signer(&0);

        // First signer should be gone, second should remain
        assert!(!client.has_signer(&BytesN::from_array(&env, &pub_bytes)));
        assert!(client.has_signer(&BytesN::from_array(&env, &pub_bytes_2)));
    }

    #[test]
    fn test_reject_remove_last_signer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub_bytes) = test_keypair();
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        // Attempting to remove the only signer should fail
        assert_eq!(
            client.try_remove_signer(&0),
            Err(Ok(WalletError::CannotRemoveLastSigner))
        );
    }

    #[test]
    fn test_remove_nonexistent_signer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub_bytes) = test_keypair();
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        // Add a second signer so we have 2 (can attempt removal)
        let (_, pub_bytes_2) = second_keypair();
        client.add_signer(&BytesN::from_array(&env, &pub_bytes_2));

        // Index 99 doesn't exist
        assert_eq!(
            client.try_remove_signer(&99),
            Err(Ok(WalletError::SignerNotFound))
        );
    }

    // ── WebAuthn verification tests ───────────────────────────────────────────

    #[test]
    fn test_verify_webauthn_valid() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_verify_webauthn_wrong_key_fails() {
        let env = Env::default();
        let (signing_key, _) = test_keypair();
        let (_, pub_bytes_wrong) = second_keypair();
        let payload = [7u8; 32];

        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes_wrong),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
        );
        assert_eq!(result, Err(WalletError::SignatureVerificationFailed));
    }

    #[test]
    fn test_verify_webauthn_wrong_challenge_fails() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        // Pass a different payload — challenge won't match
        let wrong_payload = [8u8; 32];

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &wrong_payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
        );
        assert_eq!(result, Err(WalletError::InvalidChallenge));
    }

    #[test]
    fn test_verify_webauthn_tampered_authdata_fails() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        let (_, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        let tampered_auth_data = [0xffu8; 37];

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &tampered_auth_data),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
        );
        assert_eq!(result, Err(WalletError::SignatureVerificationFailed));
    }

    // ── Domain binding tests ──────────────────────────────────────────────────

    #[test]
    fn test_rp_id_mismatch() {
        let env = Env::default();

        let rp_id_hash: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(b"localhost");
            h.finalize().into()
        };
        let mut auth_data = [0u8; 37];
        auth_data[..32].copy_from_slice(&rp_id_hash);

        // But stored rp_id is "veil.app" — different domain
        let stored_rp_id = bytes_from_str(&env, "veil.app");

        let auth_data_bytes = {
            let mut b = Bytes::new(&env);
            for &byte in &auth_data { b.push_back(byte); }
            b
        };

        let result = auth::verify_rp_id(&stored_rp_id, &auth_data_bytes);
        assert_eq!(result, Err(WalletError::RpIdMismatch));
    }

    #[test]
    fn test_origin_mismatch() {
        let env = Env::default();

        let challenge_b64 = *b"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
        let client_data_json = build_client_data_json(&env, &challenge_b64);

        let stored_origin = bytes_from_str(&env, "https://veil.app");

        let result = auth::verify_origin(&client_data_json, &stored_origin);
        assert_eq!(result, Err(WalletError::OriginMismatch));
    }

    #[test]
    fn test_rp_id_match() {
        let env = Env::default();

        let rp_id_hash: [u8; 32] = {
            let mut h = Sha256::new();
            h.update(b"localhost");
            h.finalize().into()
        };
        let mut auth_data = [0u8; 37];
        auth_data[..32].copy_from_slice(&rp_id_hash);

        let stored_rp_id = bytes_from_str(&env, "localhost");
        let auth_data_bytes = {
            let mut b = Bytes::new(&env);
            for &byte in &auth_data { b.push_back(byte); }
            b
        };

        let result = auth::verify_rp_id(&stored_rp_id, &auth_data_bytes);
        assert!(result.is_ok());
    }

    #[test]
    fn test_origin_match() {
        let env = Env::default();

        let challenge_b64 = *b"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
        let client_data_json = build_client_data_json(&env, &challenge_b64);

        // clientDataJSON has origin "https://test.example" — store the same
        let stored_origin = bytes_from_str(&env, "https://test.example");

        let result = auth::verify_origin(&client_data_json, &stored_origin);
        assert!(result.is_ok());
    }

    // ── Multi-key auth test ───────────────────────────────────────────────────

    #[test]
    fn test_multi_key_auth_second_signer_works() {
        let env = Env::default();
        let (_, pub_bytes_1) = test_keypair();
        let (signing_key_2, pub_bytes_2) = second_keypair();

        // Init with first signer, add second
        env.mock_all_auths();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes_1), &rp_id, &origin);
        client.add_signer(&BytesN::from_array(&env, &pub_bytes_2));

        // Verify second signer can produce a valid WebAuthn signature
        let payload = [7u8; 32];
        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key_2, &payload, b"localhost");

        let result = auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes_2),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
        );
        assert!(result.is_ok());

        // And second signer is recognized
        assert!(client.has_signer(&BytesN::from_array(&env, &pub_bytes_2)));
    }

    // ── Nonce tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_nonce_accepted_on_first_use() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        // Init wallet
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        // Prep WebAuthn signature WITH nonce 0
        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        // First auth with nonce 0 should succeed
        let signature = Vec::from_array(&env, [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            Bytes::from_array(&env, &auth_data_raw).into_val(&env),
            build_client_data_json(&env, &challenge_b64).into_val(&env),
            BytesN::from_array(&env, &sig_bytes).into_val(&env),
            0u64.into_val(&env),
        ]).into_val(&env);

        client.__check_auth(&BytesN::from_array(&env, &payload), &signature, &Vec::new(&env));

        // Nonce should now be 1
        assert_eq!(client.get_nonce(), 1);
    }

    #[test]
    fn test_nonce_replay_rejected() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        // Init wallet
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        // Prep WebAuthn signature WITH nonce 0
        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        let signature = Vec::from_array(&env, [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            Bytes::from_array(&env, &auth_data_raw).into_val(&env),
            build_client_data_json(&env, &challenge_b64).into_val(&env),
            BytesN::from_array(&env, &sig_bytes).into_val(&env),
            0u64.into_val(&env),
        ]).into_val(&env);

        // First auth succeeds
        client.__check_auth(&BytesN::from_array(&env, &payload), &signature, &Vec::new(&env));

        // Second auth with SAME signature + SAME nonce 0 should FAIL (replay)
        let result = client.try___check_auth(&BytesN::from_array(&env, &payload), &signature, &Vec::new(&env));
        assert_eq!(result, Err(Ok(WalletError::NonceMismatch)));
    }

    #[test]
    fn test_nonce_increments_correctly() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        // Init wallet
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        // 1. Success with nonce 0
        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");
        let signature_0 = Vec::from_array(&env, [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            Bytes::from_array(&env, &auth_data_raw).into_val(&env),
            build_client_data_json(&env, &challenge_b64).into_val(&env),
            BytesN::from_array(&env, &sig_bytes).into_val(&env),
            0u64.into_val(&env),
        ]).into_val(&env);
        client.__check_auth(&BytesN::from_array(&env, &payload), &signature_0, &Vec::new(&env));
        assert_eq!(client.get_nonce(), 1);

        // 2. Success with nonce 1 (new operation)
        let payload_2 = [8u8; 32];
        let (auth_data_raw_2, challenge_b64_2, sig_bytes_2) =
            make_webauthn_fixture(&signing_key, &payload_2, b"localhost");
        let signature_1 = Vec::from_array(&env, [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            Bytes::from_array(&env, &auth_data_raw_2).into_val(&env),
            build_client_data_json(&env, &challenge_b64_2).into_val(&env),
            BytesN::from_array(&env, &sig_bytes_2).into_val(&env),
            1u64.into_val(&env),
        ]).into_val(&env);
        client.__check_auth(&BytesN::from_array(&env, &payload_2), &signature_1, &Vec::new(&env));
        assert_eq!(client.get_nonce(), 2);
    }

    // ── Allowance tests ──────────────────────────────────────────────────────

    #[test]
    fn test_allowance_approve_and_spend() {
        let env = Env::default();
        let (_, pub_bytes) = test_keypair();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        
        let rp_id = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        let spender = Address::generate(&env);
        let token = Address::generate(&env);

        // 1. Approve 500
        env.mock_all_auths();
        client.approve(&spender, &token, &500, &None);

        let allowance = client.get_allowance(&spender, &token).unwrap();
        assert_eq!(allowance.amount, 500);
        assert_eq!(allowance.expiry, None);

        // 2. Spend 200
        let context = Context::Contract(soroban_sdk::auth::ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(&env, "transfer"),
            args: Vec::from_array(&env, [
                contract_id.to_val(),
                Address::generate(&env).to_val(),
                200i128.into_val(&env),
            ]),
        });
        
        let contexts = Vec::from_array(&env, [context]);
        let signature = spender.to_val();

        // Calling __check_auth as if the spender initiated the transfer
        client.__check_auth(&BytesN::from_array(&env, &[0; 32]), &signature, &contexts);

        // Check remaining allowance
        let remaining = client.get_allowance(&spender, &token).unwrap();
        assert_eq!(remaining.amount, 300);
    }

    #[test]
    fn test_allowance_spend_over_limit() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        
        let (_, pub_bytes) = test_keypair();
        client.init(&BytesN::from_array(&env, &pub_bytes), &bytes_from_str(&env, "localhost"), &bytes_from_str(&env, "https://test.example"));

        let spender = Address::generate(&env);
        let token = Address::generate(&env);

        env.mock_all_auths();
        client.approve(&spender, &token, &100, &None);

        let context = Context::Contract(soroban_sdk::auth::ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(&env, "transfer"),
            args: Vec::from_array(&env, [
                contract_id.to_val(),
                Address::generate(&env).to_val(),
                150i128.into_val(&env),
            ]),
        });

        let signature = spender.to_val();
        let res = client.try___check_auth(&BytesN::from_array(&env, &[0; 32]), &signature, &Vec::from_array(&env, [context]));
        assert_eq!(res, Err(Ok(WalletError::InsufficientAllowance)));
    }

    #[test]
    fn test_allowance_expired() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        
        let (_, pub_bytes) = test_keypair();
        client.init(&BytesN::from_array(&env, &pub_bytes), &bytes_from_str(&env, "localhost"), &bytes_from_str(&env, "https://test.example"));

        let spender = Address::generate(&env);
        let token = Address::generate(&env);

        env.mock_all_auths();
        env.ledger().set_timestamp(1000);
        
        // Approve with expiry in the past
        client.approve(&spender, &token, &500, &Some(500));

        let context = Context::Contract(soroban_sdk::auth::ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(&env, "transfer"),
            args: Vec::from_array(&env, [
                contract_id.to_val(),
                Address::generate(&env).to_val(),
                100i128.into_val(&env),
            ]),
        });

        let signature = spender.to_val();
        let res = client.try___check_auth(&BytesN::from_array(&env, &[0; 32]), &signature, &Vec::from_array(&env, [context]));
        assert_eq!(res, Err(Ok(WalletError::AllowanceExpired)));
    }

    #[test]
    fn test_allowance_exact_boundary() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        
        let (_, pub_bytes) = test_keypair();
        client.init(&BytesN::from_array(&env, &pub_bytes), &bytes_from_str(&env, "localhost"), &bytes_from_str(&env, "https://test.example"));

        let spender = Address::generate(&env);
        let token = Address::generate(&env);

        env.mock_all_auths();
        client.approve(&spender, &token, &100, &None);

        let context = Context::Contract(soroban_sdk::auth::ContractContext {
            contract: token.clone(),
            fn_name: Symbol::new(&env, "transfer"),
            args: Vec::from_array(&env, [
                contract_id.to_val(),
                Address::generate(&env).to_val(),
                100i128.into_val(&env),
            ]),
        });

        let signature = spender.to_val();
        client.__check_auth(&BytesN::from_array(&env, &[0; 32]), &signature, &Vec::from_array(&env, [context]));

        let remaining = client.get_allowance(&spender, &token).unwrap();
        assert_eq!(remaining.amount, 0);
    }

    #[test]
    fn test_allowance_overwrite() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        
        let (_, pub_bytes) = test_keypair();
        client.init(&BytesN::from_array(&env, &pub_bytes), &bytes_from_str(&env, "localhost"), &bytes_from_str(&env, "https://test.example"));

        let spender = Address::generate(&env);
        let token = Address::generate(&env);

        env.mock_all_auths();
        client.approve(&spender, &token, &100, &None);
        client.approve(&spender, &token, &300, &None);

        let remaining = client.get_allowance(&spender, &token).unwrap();
        assert_eq!(remaining.amount, 300);
    }
}

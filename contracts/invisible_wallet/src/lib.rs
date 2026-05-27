#![no_std]
#[cfg(test)]
extern crate alloc;
use soroban_sdk::{
    contract, contractimpl, contracterror,
    Env, Address, Bytes, BytesN, Vec, Symbol, Val,
    auth::Context, FromVal, TryFromVal, TryIntoVal, symbol_short, Map};

mod auth;
mod storage;
pub mod session_key;
#[cfg(test)]
mod auth_failure_tests;
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
    /// The session key's expiry timestamp has passed.
    SessionKeyExpired           = 19,
    /// A session key call violates its ACL (wrong target, selector, or cumulative budget exceeded).
    SessionKeyAclViolation      = 20,
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
        credential_id: Bytes,
        initial_signer: BytesN<65>,
        rp_id: Bytes,
        origin: Bytes,
    ) -> Result<(), WalletError> {
        if storage::get_signers(&env).len() > 0 {
            return Err(WalletError::AlreadyInitialized);
        }
        storage::init_signers(&env, credential_id, initial_signer);
        storage::set_rp_id(&env, &rp_id);
        storage::set_origin(&env, &origin);
        // Step 0 — Initialise nonce to 0 (explicitly, though storage helper defaults to 0).
        env.storage().instance().set(&DataKey::Nonce, &0u64);
        Ok(())
    }

    /// Add a new signer key to the wallet. Requires authorization from the
    /// contract itself (i.e. an existing signer must authorize via `__check_auth`).
    /// Returns the index assigned to the new signer.
    pub fn add_signer(env: Env, credential_id: Bytes, new_public_key: BytesN<65>) {
        env.current_contract_address().require_auth();
        storage::add_signer(&env, credential_id, new_public_key);
    }

    /// Remove a signer by index. Requires authorization from the contract.
    /// Rejects removal if it would leave the wallet with zero signers.
    pub fn remove_signer(env: Env, credential_id: Bytes) -> Result<(), WalletError> {
        env.current_contract_address().require_auth();

        if storage::get_signers(&env).len() <= 1 {
            return Err(WalletError::CannotRemoveLastSigner);
        }

        if !storage::remove_signer(&env, &credential_id) {
        return Err(WalletError::SignerNotFound);
        }
        
        Ok(())
    }

    /// Called by the Soroban runtime to authorize a transaction.
    ///
    /// The `signature` Val must encode a Vec<Val> with 5 elements:
    ///   [0] Bytes       - credential_id
    ///   [1] Bytes       - WebAuthn authenticatorData
    ///   [2] Bytes       - WebAuthn clientDataJSON
    ///   [3] BytesN<64>  - raw P-256 signature (r || s)
    ///   [4] u64         - nonce

    ///
    /// **Branch 1 — Allowance (spender Address)**
    ///   `signature` is an `Address`. The spender presents itself and the
    ///   on-chain allowance record is debited. No cryptographic work needed
    ///   because `spender.require_auth()` already verified the spender's sig.
    ///
    /// **Branch 2 — Session key `Vec<Val>[key_id, ed25519_sig, nonce]`**
    ///   `signature` is a `Vec<Val>` with exactly 3 elements:
    ///     [0] `BytesN<32>` — key_id (storage lookup handle, NOT a secret)
    ///     [1] `BytesN<64>` — ed25519 signature of `signature_payload`
    ///     [2] `u64`        — current contract nonce (replay binding)
    ///
    ///   Authorization requires:
    ///   1. An ed25519 signature over `signature_payload` that verifies against
    ///      the public key registered in the ACL for `key_id`.  The key_id is
    ///      public; possession of it is NOT sufficient — the holder must produce
    ///      a fresh signature on the host-provided payload for every call.
    ///   2. The submitted nonce matches the on-chain nonce (contract-level replay
    ///      protection, in addition to the host-level auth nonce).
    ///   3. All ACL constraints pass: expiry, target contract, selector, and
    ///      cumulative spend within `amount_cap`.
    ///   4. On success the contract nonce is incremented.
    ///
    /// **Branch 3 — WebAuthn `Vec<Val>[pubkey, auth_data, client_data_json, sig, nonce]`**
    ///   Standard passkey / WebAuthn flow.
  pub fn __check_auth(
    env: Env,
    payload: BytesN<32>,
    signature: Val,
    contexts: Vec<Context>,
) -> Result<(), WalletError> {

    // Try decode each auth type in order of cheapest → most expensive

    if let Ok(spender) = Address::try_from_val(&env, &signature) {
        return auth_allowance(&env, spender, contexts);
    }

    if let Ok(parts) = Vec::<Val>::try_from_val(&env, &signature) {
        match parts.len() {
            3 => return auth_session_key(&env, payload, parts, contexts),
            5 => return auth_webauthn(&env, payload, parts),
            _ => return Err(WalletError::InvalidSignatureFormat),
        }
    }

    Err(WalletError::InvalidSignatureFormat)
}
    // ─────────────────────────────────────────────
    // BRANCH 1: Allowance-based auth (Address)
    // ─────────────────────────────────────────────
   fn auth_allowance(
    env: &Env,
    spender: Address,
    contexts: Vec<Context>,
) -> Result<(), WalletError> {

    spender.require_auth();

    for context in contexts.iter() {
        let Context::Contract(c) = context else {
            return Err(WalletError::SignerNotAuthorized);
        };

        if c.fn_name != Symbol::new(env, "transfer") {
            return Err(WalletError::SignerNotAuthorized);
        }

        if c.args.len() != 3 {
            return Err(WalletError::SignerNotAuthorized);
        }

        let amount = i128::try_from_val(env, &c.args.get(2).unwrap())
            .map_err(|_| WalletError::SignerNotAuthorized)?;

        let key = DataKey::Allowance(AllowanceKey {
            spender: spender.clone(),
            token: c.contract.clone(),
        });

        let mut allowance = env.storage()
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

    Ok(())
}
    // ─────────────────────────────────────────────
    // BRANCH 2: Session Key Auth
    // ─────────────────────────────────────────────
   fn auth_session_key(
    env: &Env,
    payload: BytesN<32>,
    parts: Vec<Val>,
    contexts: Vec<Context>,
) -> Result<(), WalletError> {

    let key_id: BytesN<32> = parts.get(0).unwrap().try_into_val(env)
        .map_err(|_| WalletError::InvalidSignatureFormat)?;

    let sig: BytesN<64> = parts.get(1).unwrap().try_into_val(env)
        .map_err(|_| WalletError::InvalidSignatureFormat)?;

    let nonce: u64 = parts.get(2).unwrap().try_into_val(env)
        .map_err(|_| WalletError::InvalidSignatureFormat)?;

    let acl = session_key::get_acl(env, &key_id)
        .ok_or(WalletError::SignerNotAuthorized)?;

    env.crypto().ed25519_verify(
        &acl.pubkey,
        &Bytes::from(payload.clone()),
        &sig,
    );

    if nonce != storage::get_nonce(env) {
        return Err(WalletError::NonceMismatch);
    }

    for context in contexts.iter() {
        let Context::Contract(c) = context else {
            return Err(WalletError::SignerNotAuthorized);
        };

        let amount = c.args.get(2)
            .and_then(|v| i128::try_from_val(env, v).ok())
            .unwrap_or(0);

        session_key::enforce(env, &key_id, &c.contract, &c.fn_name, amount)?;
    }

    storage::increment_nonce(env);
    Ok(())
}
    // ─────────────────────────────────────────────
    // BRANCH 3: WebAuthn / Passkey Auth
    // ─────────────────────────────────────────────
   fn auth_webauthn(
    env: &Env,
    payload: BytesN<32>,
    parts: Vec<Val>,
) -> Result<(), WalletError> {

    let public_key: BytesN<65> = parts.get(0).unwrap().try_into_val(env)?;
    let auth_data: Bytes = parts.get(1).unwrap().try_into_val(env)?;
    let client_data: Bytes = parts.get(2).unwrap().try_into_val(env)?;
    let sig: BytesN<64> = parts.get(3).unwrap().try_into_val(env)?;
    let nonce: u64 = parts.get(4).unwrap().try_into_val(env)?;

    if !storage::has_signer(env, &public_key) {
        return Err(WalletError::SignerNotAuthorized);
    }

    if nonce != storage::get_nonce(env) {
        return Err(WalletError::NonceMismatch);
    }

    auth::verify_webauthn(
        env,
        &payload,
        public_key,
        auth_data.clone(),
        client_data.clone(),
        sig,
    )?;

    let rp_id = storage::get_rp_id(env).ok_or(WalletError::RpIdMismatch)?;
    auth::verify_rp_id(env, &rp_id, &auth_data)?;

    let origin = storage::get_origin(env).ok_or(WalletError::OriginMismatch)?;
    auth::verify_origin(&client_data, &origin)?;

    storage::increment_nonce(env);
    Ok(())
}

    /// Return the current monotonic nonce for this wallet.
    pub fn get_nonce(env: Env) -> u64 {
        storage::get_nonce(&env)
    }

    pub fn has_signer(env: Env, key: BytesN<65>) -> bool {
     let signers = get_signers(env);
        for (_, v) in signers.iter() {
            if v == key {
                return true;
            }
        }
        false
    }

    pub fn get_signers(env: Env) -> Map<Bytes, BytesN<65>> {
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
    pub fn set_guardian(env: &Env, guardian: &Address) {
        // Require that the contract itself (i.e. the wallet signer) authorizes this call.
        env.current_contract_address().require_auth();

         storage::set_guardian(env, guardian);

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
    pub fn initiate_recovery(env: Env, credential_id: Bytes, new_public_key: BytesN<65>) -> Result<(), WalletError> {
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
            credential_id,
            new_public_key,
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
        storage::init_signers(&env, pending.credential_id, pending.new_public_key);

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

    /// Register a scoped session key with an ACL.
    ///
    /// The caller must supply the ed25519 public key (`pubkey`) of the session
    /// key holder in addition to the `key_id` storage handle.  Every future
    /// `__check_auth` call using this key must carry an ed25519 signature of
    /// `signature_payload` produced by the corresponding private key.
    ///
    /// Requires wallet owner authorization (existing signer via `__check_auth`).
    pub fn register_session_key(
        env: Env,
        pubkey: BytesN<32>,
        key_id: BytesN<32>,
        target_contract: Address,
        selector: Symbol,
        amount_cap: i128,
        expiry: u64,
    ) {
        env.current_contract_address().require_auth();
        session_key::register(&env, key_id, session_key::SessionKeyAcl {
            pubkey,
            target_contract,
            selector,
            amount_cap,
            spent: 0,
            expiry,
        });
    }

    /// Immediately revoke a session key.
    /// Requires the wallet owner to authorize.
    pub fn revoke_session_key(env: Env, key_id: BytesN<32>) {
        env.current_contract_address().require_auth();
        session_key::revoke(&env, &key_id);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Env, Bytes, BytesN, symbol_short, Map, IntoVal, Val};
    use soroban_sdk::auth::{CustomAccountInterface, Context};
    use soroban_sdk::testutils::{Address as _, Ledger as _};

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

    // ── core acceptance tests ──
    #[test]
    fn test_init_registers_first_signer() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub_bytes) = test_keypair();
        let pub_key = BytesN::from_array(&env, &pub_bytes);

        let credential_id = Bytes::from_array(&env, &[56, 57, 58]);
        let rp_id = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&credential_id, &pub_key, &rp_id, &origin);

        // ASSERT: wallet has 1 signer after init
        assert_eq!(client.get_signers().len(), 1);
        assert!(client.has_signer(pub_key));
    }

    #[test]
    fn test_add_second_signer() {
        let env = Env::default();
            env.mock_all_auths();

        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub1) = test_keypair();
        let (_, pub2) = second_keypair();

        let pub_key1 = BytesN::from_array(&env, &pub1);
        let pub_key2 = BytesN::from_array(&env, &pub2);

        client.init(
            &Bytes::from_array(&env, &[61,62,60]),
            &pub_key1,
            &bytes_from_str(&env, "localhost"),
            &bytes_from_str(&env, "https://localhost:5173"),
        );

        let credential_id_2 = Bytes::from_array(&env, &[64,65,66]);

        client.add_signer(&credential_id_2, &pub_key2);

        // ASSERT: second signer added at index 1
        
        assert_eq!(client.get_signers().len(), 2);
        assert!(client.has_signer(pub_key2));
    }

    #[test]
    fn test_any_signer_can_auth() {
        let env = Env::default();
         env.mock_all_auths();

        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub1) = test_keypair();
        let (_, pub2) = second_keypair();

        let pub_key1 = BytesN::from_array(&env, &pub1);
        let pub_key2 = BytesN::from_array(&env, &pub2);

        client.init(
            &Bytes::from_array(&env, &[67,68,69]),
            &pub_key1,
            &bytes_from_str(&env, "localhost"),
            &bytes_from_str(&env, "https://localhost:5173"),
        );

        // add second signer
        client.add_signer(
            &Bytes::from_array(&env, &[70,71,72]),
            &pub_key2,
        );

         let payload = BytesN::from_array(&env, &[7u8; 32]);

        let signature = build_test_signature_for_key(&pub1); // or your helper

        // signer 1 should pass
        let res1 = client.try___check_auth(&payload, &signature, &Vec::new(&env));
        assert!(res1.is_ok());

        let signature2 = build_test_signature_for_key(&pub2);

        // signer 2 should ALSO pass
        let res2 = client.try___check_auth(&payload, &signature2, &Vec::new(&env));
        assert!(res2.is_ok());
    }

    #[test]
    fn test_cannot_remove_last_signer() {
        let env = Env::default();
            env.mock_all_auths();

        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub1) = test_keypair();
        let pub_key1 = BytesN::from_array(&env, &pub1);

        client.init(
            &Bytes::from_array(&env, &[74,75,76]),
            &pub_key1,
            &bytes_from_str(&env, "localhost"),
            &bytes_from_str(&env, "https://localhost:5173"),
        );

        // ATTEMPT: remove only signer
        let result = client.try_remove_signer(&Bytes::from_array(&env, &[77,78,79]));

        // ASSERT: must fail
        assert!(result.is_err());

        // ASSERT: signer still exists
        assert_eq!(client.get_signers().len(), 1);
    }

    #[test]
    fn test_remove_and_readd_same_credential() {
        let env = Env::default();
            env.mock_all_auths();

        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub1) = test_keypair();
        let pub_key1 = BytesN::from_array(&env, &pub1);

        let credential = Bytes::from_array(&env, &[1,2,3]);

        client.init(
            &credential,
            &pub_key1,
            &bytes_from_str(&env, "localhost"),
            &bytes_from_str(&env, "https://localhost:5173"),
        );

        // add second signer (needed for removal safety rule)
        let (_, pub2) = second_keypair();
        let pub_key2 = BytesN::from_array(&env, &pub2);

        let credential2 = Bytes::from_array(&env, &[4,5,6]);

        client.add_signer(&credential2, &pub_key2);

        // remove first signer
        client.remove_signer(&credential);

        // re-add same credential
        let (_, pub3) = second_keypair();
        let pub_key3 = BytesN::from_array(&env, &pub3);

        let result = client.add_signer(&credential, &pub_key3);

        // must succeed OR behave deterministically (depending on spec)
        assert!(result >= 0);

        assert!(client.has_signer(pub_key3));
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

        let challenge_b64 = crate::auth::base64url_encode_32(payload);

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
        let sig = sig.normalize_s().unwrap_or(sig);
        let sig_bytes: [u8; 64] = sig.to_bytes().into();

        (auth_data, challenge_b64, sig_bytes)
    }

    fn build_client_data_json_raw(challenge_b64: &[u8; 43]) -> alloc::vec::Vec<u8> {
        let prefix = b"{\"type\":\"webauthn.get\",\"challenge\":\"";
        let suffix = b"\",\"origin\":\"https://test.example\",\"crossOrigin\":false}";
        let mut out = alloc::vec::Vec::new();
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
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        let credential_id = Bytes::from_array(&env, &[1, 2, 3]);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");
        client.init(&credential_id, &pub_key, &rp_id, &origin);
    }

    #[test]
    fn test_init_twice_fails() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let (_, pub_bytes) = test_keypair();
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        let credential_id = Bytes::from_array(&env, &[4, 5, 6]);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");
        client.init(&credential_id, &pub_key, &rp_id, &origin);
        assert_eq!(
            client.try_init(&credential_id, &pub_key, &rp_id, &origin),
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
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        let credential_id = Bytes::from_array(&env, &[7, 8, 9]);
        let (_, pub_bytes_2) = second_keypair();
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&credential_id, &pub_key, &rp_id, &origin);

        // Initial signer is at index 0, so next should be index 1
        let credential_id_2 = Bytes::from_array(&env, &[20, 21, 22]);
        let pubkey_2 = BytesN::from_array(&env, &pub_bytes_2);

        let index = client.add_signer(&credential_id_2, &pubkey_2);
        assert_eq!(index, 1);

        let pubkey_1 = pub_key.clone();
        // Both signers should be recognized
        assert!(client.has_signer(pubkey_1));
        assert!(client.has_signer(pubkey_2));
    }

    #[test]
    fn test_remove_signer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub_bytes) = test_keypair();
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        let credential_id = Bytes::from_array(&env, &[10, 11, 12]);
        let (_, pub_bytes_2) = second_keypair();
        let pubkey_2 = BytesN::from_array(&env, &pub_bytes_2);
        let credential_id_2 = Bytes::from_array(&env, &[30, 31, 32]);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&credential_id, &pub_key, &rp_id, &origin);
        client.add_signer(&credential_id_2, &pubkey_2);

        // Remove the first signer (index 0)
        client.remove_signer(&credential_id);

        // First signer should be gone, second should remain
        assert!(!client.has_signer(pub_key));
        assert!(client.has_signer(pubkey_2));
    }

    #[test]
    fn test_reject_remove_last_signer() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);

        let (_, pub_bytes) = test_keypair();
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        let credential_id = Bytes::from_array(&env, &[13, 14, 15]);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&credential_id, &pub_key, &rp_id, &origin);

        assert_eq!(
            client.try_remove_signer(&credential_id),
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
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        let credential_id = Bytes::from_array(&env, &[16, 17, 18]);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://localhost:5173");

        client.init(&credential_id, &pub_key, &rp_id, &origin);

        let (_, pub_bytes_2) = second_keypair();
        let credential_id_2 = Bytes::from_array(&env, &[34, 35, 36]);
        client.add_signer(&credential_id_2, &BytesN::from_array(&env, &pub_bytes_2));

        // Index 99 doesn't exist
        let nonexistent_credential = Bytes::from_array(&env, &[99, 99, 99]);

        assert_eq!(
            client.try_remove_signer(&nonexistent_credential),
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
    #[should_panic]
    fn test_verify_webauthn_wrong_key_fails() {
        let env = Env::default();
        let (signing_key, _) = test_keypair();
        let (_, pub_bytes_wrong) = second_keypair();
        let payload = [7u8; 32];

        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes_wrong),
            Bytes::from_array(&env, &auth_data_raw),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
        ).unwrap();
    }

    #[test]
    fn test_verify_webauthn_wrong_challenge_fails() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

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
    #[should_panic]
    fn test_verify_webauthn_tampered_authdata_fails() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        let (_, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        let tampered_auth_data = [0xffu8; 37];

        auth::verify_webauthn(
            &env,
            &BytesN::from_array(&env, &payload),
            BytesN::from_array(&env, &pub_bytes),
            Bytes::from_array(&env, &tampered_auth_data),
            build_client_data_json(&env, &challenge_b64),
            BytesN::from_array(&env, &sig_bytes),
        ).unwrap();
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

        let stored_rp_id = bytes_from_str(&env, "veil.app");

        let auth_data_bytes = {
            let mut b = Bytes::new(&env);
            for &byte in &auth_data { b.push_back(byte); }
            b
        };

        let result = auth::verify_rp_id(&env, &stored_rp_id, &auth_data_bytes);
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

        let result = auth::verify_rp_id(&env, &stored_rp_id, &auth_data_bytes);
        assert!(result.is_ok());
    }

    #[test]
    fn test_origin_match() {
        let env = Env::default();

        let challenge_b64 = *b"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
        let client_data_json = build_client_data_json(&env, &challenge_b64);

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

        env.mock_all_auths();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes_1), &rp_id, &origin);
        client.add_signer(&BytesN::from_array(&env, &pub_bytes_2));

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

        assert!(client.has_signer(&BytesN::from_array(&env, &pub_bytes_2)));
    }

    // ── Nonce tests ──────────────────────────────────────────────────────────

    #[test]
    fn test_nonce_accepted_on_first_use() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        // First auth with nonce 0 should succeed
        let signature = Vec::<Val>::from_array(&env, [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            Bytes::from_array(&env, &auth_data_raw).into_val(&env),
            build_client_data_json(&env, &challenge_b64).into_val(&env),
            BytesN::from_array(&env, &sig_bytes).into_val(&env),
            0u64.into_val(&env),
        ]).into_val(&env);

        client.__check_auth(&BytesN::from_array(&env, &payload), &signature, &soroban_sdk::Vec::new(&env));

        assert_eq!(client.get_nonce(), 1);
    }

    #[test]
    fn test_nonce_replay_rejected() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");

        let signature = Vec::<Val>::from_array(&env, [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            Bytes::from_array(&env, &auth_data_raw).into_val(&env),
            build_client_data_json(&env, &challenge_b64).into_val(&env),
            BytesN::from_array(&env, &sig_bytes).into_val(&env),
            0u64.into_val(&env),
        ]).into_val(&env);

        client.__check_auth(&BytesN::from_array(&env, &payload), &signature, &soroban_sdk::Vec::new(&env));

        let result = client.try___check_auth(&BytesN::from_array(&env, &payload), &signature, &soroban_sdk::Vec::new(&env));
        assert_eq!(result, Err(Ok(WalletError::NonceMismatch)));
    }

    #[test]
    fn test_nonce_increments_correctly() {
        let env = Env::default();
        let (signing_key, pub_bytes) = test_keypair();
        let payload = [7u8; 32];

        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        let rp_id  = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        let (auth_data_raw, challenge_b64, sig_bytes) =
            make_webauthn_fixture(&signing_key, &payload, b"localhost");
        let signature_0 = Vec::<Val>::from_array(&env, [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            Bytes::from_array(&env, &auth_data_raw).into_val(&env),
            build_client_data_json(&env, &challenge_b64).into_val(&env),
            BytesN::from_array(&env, &sig_bytes).into_val(&env),
            0u64.into_val(&env),
        ]).into_val(&env);
        client.__check_auth(&BytesN::from_array(&env, &payload), &signature_0, &soroban_sdk::Vec::new(&env));
        assert_eq!(client.get_nonce(), 1);

        let payload_2 = [8u8; 32];
        let (auth_data_raw_2, challenge_b64_2, sig_bytes_2) =
            make_webauthn_fixture(&signing_key, &payload_2, b"localhost");
        let signature_1 = Vec::<Val>::from_array(&env, [
            BytesN::from_array(&env, &pub_bytes).into_val(&env),
            Bytes::from_array(&env, &auth_data_raw_2).into_val(&env),
            build_client_data_json(&env, &challenge_b64_2).into_val(&env),
            BytesN::from_array(&env, &sig_bytes_2).into_val(&env),
            1u64.into_val(&env),
        ]).into_val(&env);
        client.__check_auth(&BytesN::from_array(&env, &payload_2), &signature_1, &soroban_sdk::Vec::new(&env));
        assert_eq!(client.get_nonce(), 2);
    }

    // ── Allowance tests ──────────────────────────────────────────────────────

    #[test]
    fn test_allowance_approve_and_spend() {
        let env = Env::default();
        let (_, pub_bytes) = test_keypair();
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        
        let rp_id = bytes_from_str(&env, "localhost");
        let origin = bytes_from_str(&env, "https://test.example");
        client.init(&BytesN::from_array(&env, &pub_bytes), &rp_id, &origin);

        let spender = Address::generate(&env);
        let token = Address::generate(&env);

        env.mock_all_auths();
        client.approve(&spender, &token, &500, &None);

        let allowance = client.get_allowance(&spender, &token).unwrap();
        assert_eq!(allowance.amount, 500);
        assert_eq!(allowance.expiry, None);

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

        client.__check_auth(&BytesN::from_array(&env, &[0; 32]), &signature, &contexts);

        let remaining = client.get_allowance(&spender, &token).unwrap();
        assert_eq!(remaining.amount, 300);
    }

    #[test]
    fn test_allowance_spend_over_limit() {
        let env = Env::default();
        let contract_id = env.register_contract(None, InvisibleWallet);
        let client = InvisibleWalletClient::new(&env, &contract_id);
        
        let (_, pub_bytes) = test_keypair();
        let pub_key = BytesN::from_array(&env, &pub_bytes);
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
        let pub_key = BytesN::from_array(&env, &pub_bytes);
        client.init(&BytesN::from_array(&env, &pub_bytes), &bytes_from_str(&env, "localhost"), &bytes_from_str(&env, "https://test.example"));

        let spender = Address::generate(&env);
        let token = Address::generate(&env);

        env.mock_all_auths();
        env.ledger().set_timestamp(1000);
        
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
        let pub_key = BytesN::from_array(&env, &pub_bytes);
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
        let pub_key = BytesN::from_array(&env, &pub_bytes);
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
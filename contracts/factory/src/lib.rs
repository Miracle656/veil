#![no_std]
use soroban_sdk::{contract, contractimpl, contracterror, symbol_short, Env, Address, BytesN, Vec, IntoVal};

mod storage;
mod validation;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum FactoryError {
    AlreadyInitialized = 1,
    NotInitialized     = 2,
    AlreadyDeployed    = 3,
    InvalidPublicKey   = 4,
}

#[contract]
pub struct Factory;

#[contractimpl]
impl Factory {
    /// One-time initialization. Stores the wallet Wasm hash.
    pub fn init(env: Env, wasm_hash: BytesN<32>) -> Result<(), FactoryError> {
        if storage::has_wasm_hash(&env) {
            return Err(FactoryError::AlreadyInitialized);
        }
        storage::set_wasm_hash(&env, &wasm_hash);
        Ok(())
    }

    /// Deploy a new invisible_wallet for the given P-256 public key.
    /// Returns the Address of the newly deployed wallet.
    pub fn deploy(env: Env, public_key: BytesN<65>, rp_id: soroban_sdk::Bytes, origin: soroban_sdk::Bytes) -> Result<Address, FactoryError> {
        // Step 1: must be initialized
        let wasm_hash = storage::get_wasm_hash(&env)
            .ok_or(FactoryError::NotInitialized)?;

        // Step 2: validate public key
        validation::validate_public_key(&public_key)?;

        // Step 3: compute salt = SHA-256(public_key_bytes)
        let key_bytes = public_key.to_array();
        let salt_bytes = sha2_hash(&key_bytes);
        let salt = BytesN::from_array(&env, &salt_bytes);

        // Step 4: check for duplicate
        if storage::is_deployed(&env, &salt) {
            return Err(FactoryError::AlreadyDeployed);
        }

        // Step 5: deploy the contract and call init atomically
        let wallet_address = env
            .deployer()
            .with_address(env.current_contract_address(), salt.clone())
            .deploy(wasm_hash);

        let init_args: Vec<soroban_sdk::Val> = (public_key.clone(), rp_id, origin).into_val(&env);
        env.invoke_contract::<soroban_sdk::Val>(&wallet_address, &symbol_short!("init"), init_args);

        // Step 6: mark as deployed
        storage::mark_deployed(&env, &salt);

        // Step 7: return address
        Ok(wallet_address)
    }
}

/// Compute SHA-256 of a 65-byte input, returning a 32-byte array.
fn sha2_hash(input: &[u8; 65]) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(input);
    hasher.finalize().into()
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{Bytes, Env, BytesN};

    const MOCK_WALLET_WASM: &[u8] = include_bytes!("../test-fixtures/mock_wallet.wasm");

    fn make_env() -> Env {
        Env::default()
    }

    fn dummy_wasm_hash(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[1u8; 32])
    }

    fn valid_pub_key(env: &Env) -> BytesN<65> {
        use p256::ecdsa::SigningKey;
        let signing_key = SigningKey::from_bytes(&[42u8; 32].into()).unwrap();
        let encoded = signing_key.verifying_key().to_encoded_point(false);
        let bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
        BytesN::from_array(env, &bytes)
    }

    fn second_valid_pub_key(env: &Env) -> BytesN<65> {
        use p256::ecdsa::SigningKey;
        let signing_key = SigningKey::from_bytes(&[99u8; 32].into()).unwrap();
        let encoded = signing_key.verifying_key().to_encoded_point(false);
        let bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
        BytesN::from_array(env, &bytes)
    }

    /// Dummy rp_id bytes for test deployments (represents "localhost").
    fn make_rp_id(env: &Env) -> Bytes {
        Bytes::from_slice(env, b"localhost")
    }

    /// Dummy origin bytes for test deployments (represents a test origin).
    fn make_origin(env: &Env) -> Bytes {
        Bytes::from_slice(env, b"http://localhost:3000")
    }

    /// Upload mock wallet WASM and return its hash for use with factory.init().
    fn install_mock_wallet(env: &Env) -> BytesN<32> {
        env.deployer().upload_contract_wasm(MOCK_WALLET_WASM)
    }

    // ── Init tests ────────────────────────────────────────────────────────

    #[test]
    fn test_init_stores_wasm_hash() {
        let env = make_env();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);
        let hash = dummy_wasm_hash(&env);
        client.init(&hash);
        env.as_contract(&contract_id, || {
            assert_eq!(storage::get_wasm_hash(&env).unwrap(), hash);
        });
    }

    #[test]
    fn test_double_init_fails() {
        let env = make_env();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);
        let hash = dummy_wasm_hash(&env);
        client.init(&hash);
        assert_eq!(
            client.try_init(&hash),
            Err(Ok(FactoryError::AlreadyInitialized))
        );
    }

    // ── 1. Happy Path ─────────────────────────────────────────────────────

    #[test]
    fn test_deploy_happy_path() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);

        let wasm_hash = install_mock_wallet(&env);
        client.init(&wasm_hash);

        let pub_key = valid_pub_key(&env);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);
        let wallet_address = client.deploy(&pub_key, &rp_id, &origin);

        // deploy_wallet: must return a valid Address distinct from the factory
        assert_ne!(wallet_address, contract_id);

        // Salt must be marked as deployed in storage
        let key_bytes = pub_key.to_array();
        let salt_bytes = sha2_hash(&key_bytes);
        let salt = BytesN::from_array(&env, &salt_bytes);
        env.as_contract(&contract_id, || {
            assert!(storage::is_deployed(&env, &salt));
        });
    }

    // ── 2. Duplicate Prevention ───────────────────────────────────────────

    #[test]
    fn test_duplicate_deploy_fails() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);

        let wasm_hash = install_mock_wallet(&env);
        client.init(&wasm_hash);

        let pub_key = valid_pub_key(&env);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);

        // First deploy succeeds
        let _ = client.deploy(&pub_key, &rp_id, &origin);

        // Second deploy with the same key must return AlreadyDeployed
        assert_eq!(
            client.try_deploy(&pub_key, &rp_id, &origin),
            Err(Ok(FactoryError::AlreadyDeployed))
        );
    }

    /// Duplicate deploy is prevented regardless of rp_id / origin values —
    /// the guard key is the SHA-256 of the public key, not the domain.
    #[test]
    fn test_duplicate_deploy_prevented() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);

        let wasm_hash = install_mock_wallet(&env);
        client.init(&wasm_hash);

        let pub_key = valid_pub_key(&env);
        let rp_id_a = make_rp_id(&env);
        let origin_a = make_origin(&env);
        let rp_id_b = Bytes::from_slice(&env, b"example.com");
        let origin_b = Bytes::from_slice(&env, b"https://example.com");

        let _ = client.deploy(&pub_key, &rp_id_a, &origin_a);

        // Different domain values do not bypass the duplicate guard
        assert_eq!(
            client.try_deploy(&pub_key, &rp_id_b, &origin_b),
            Err(Ok(FactoryError::AlreadyDeployed))
        );
    }

    // ── 3. Bad Input ──────────────────────────────────────────────────────

    #[test]
    fn test_deploy_before_init_fails() {
        let env = make_env();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);
        let pub_key = valid_pub_key(&env);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);
        assert_eq!(
            client.try_deploy(&pub_key, &rp_id, &origin),
            Err(Ok(FactoryError::NotInitialized))
        );
    }

    #[test]
    fn test_invalid_public_key_bad_prefix() {
        let env = make_env();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);
        client.init(&dummy_wasm_hash(&env));
        // Compressed prefix 0x03 instead of uncompressed 0x04
        let mut bad_key = [0u8; 65];
        bad_key[0] = 0x03;
        let pub_key = BytesN::from_array(&env, &bad_key);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);
        assert_eq!(
            client.try_deploy(&pub_key, &rp_id, &origin),
            Err(Ok(FactoryError::InvalidPublicKey))
        );
    }

    #[test]
    fn test_invalid_public_key_all_zeros() {
        let env = make_env();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);
        client.init(&dummy_wasm_hash(&env));
        // All zeros — prefix is 0x00, not a valid point
        let pub_key = BytesN::from_array(&env, &[0u8; 65]);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);
        assert_eq!(
            client.try_deploy(&pub_key, &rp_id, &origin),
            Err(Ok(FactoryError::InvalidPublicKey))
        );
    }

    #[test]
    fn test_invalid_public_key_correct_prefix_but_not_on_curve() {
        let env = make_env();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);
        client.init(&dummy_wasm_hash(&env));
        // Starts with 0x04 but x,y are all 1s — not a valid P-256 point
        let mut bad_key = [1u8; 65];
        bad_key[0] = 0x04;
        let pub_key = BytesN::from_array(&env, &bad_key);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);
        assert_eq!(
            client.try_deploy(&pub_key, &rp_id, &origin),
            Err(Ok(FactoryError::InvalidPublicKey))
        );
    }

    // ── 4. Address Determinism ────────────────────────────────────────────

    #[test]
    fn test_address_determinism() {
        // Same public key must always produce the same salt and therefore
        // the same wallet address. Proof: deploying twice with the same key
        // triggers AlreadyDeployed, which only fires when SHA-256(key) → salt
        // matches an existing record. This proves the mapping is deterministic.
        let pub_key_bytes = {
            use p256::ecdsa::SigningKey;
            let signing_key = SigningKey::from_bytes(&[42u8; 32].into()).unwrap();
            let encoded = signing_key.verifying_key().to_encoded_point(false);
            let bytes: [u8; 65] = encoded.as_bytes().try_into().unwrap();
            bytes
        };

        // Salt computation is deterministic (pure function, no env needed)
        let salt1 = sha2_hash(&pub_key_bytes);
        let salt2 = sha2_hash(&pub_key_bytes);
        assert_eq!(salt1, salt2);

        // Deploy in the same environment — second call proves address determinism
        let env = make_env();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);
        let wasm_hash = install_mock_wallet(&env);
        client.init(&wasm_hash);

        let pub_key = BytesN::from_array(&env, &pub_key_bytes);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);
        let _wallet = client.deploy(&pub_key, &rp_id, &origin);

        // Same key → same salt → same address → AlreadyDeployed
        assert_eq!(
            client.try_deploy(&pub_key, &rp_id, &origin),
            Err(Ok(FactoryError::AlreadyDeployed))
        );
    }

    #[test]
    fn test_different_keys_produce_different_addresses() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);

        let wasm_hash = install_mock_wallet(&env);
        client.init(&wasm_hash);

        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);

        let addr1 = client.deploy(&valid_pub_key(&env), &rp_id, &origin);
        let addr2 = client.deploy(&second_valid_pub_key(&env), &rp_id, &origin);
        assert_ne!(addr1, addr2);
    }

    // ── 5. Wallet Initialization ──────────────────────────────────────────

    #[test]
    fn test_wallet_initialization_registers_signer() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);

        let wasm_hash = install_mock_wallet(&env);
        client.init(&wasm_hash);

        let pub_key = valid_pub_key(&env);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);
        let wallet_address = client.deploy(&pub_key, &rp_id, &origin);

        // The deployed wallet should have the public key registered as a signer.
        let has_signer: bool = env.invoke_contract(
            &wallet_address,
            &symbol_short!("is_signer"),
            (pub_key,).into_val(&env),
        );
        assert!(has_signer);
    }

    // ── 6. Full Integration ───────────────────────────────────────────────

    #[test]
    fn test_deploy_full_integration() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, Factory);
        let client = FactoryClient::new(&env, &contract_id);

        let wasm_hash = install_mock_wallet(&env);
        client.init(&wasm_hash);

        let pub_key = valid_pub_key(&env);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);
        let wallet_address = client.deploy(&pub_key, &rp_id, &origin);

        // Address is distinct from factory
        assert_ne!(wallet_address, contract_id);

        // Signer registered in the deployed wallet
        let has_signer: bool = env.invoke_contract(
            &wallet_address,
            &symbol_short!("is_signer"),
            (pub_key.clone(),).into_val(&env),
        );
        assert!(has_signer);

        // Salt marked as deployed → duplicate blocked
        assert_eq!(
            client.try_deploy(&pub_key, &rp_id, &origin),
            Err(Ok(FactoryError::AlreadyDeployed))
        );
    }
}

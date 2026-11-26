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
    /// Contract constructor. Runs atomically as part of the deploy transaction,
    /// so the admin is fixed the instant the factory exists — it cannot be
    /// front-run. Only this admin may later call `init`.
    pub fn __constructor(env: Env, admin: Address) {
        storage::set_admin(&env, &admin);
    }

    /// One-time initialization. Stores the wallet Wasm hash.
    ///
    /// Gated on the admin set at construction. Without this, `init` was
    /// unauthenticated and — because the mainnet runbook deploys and initializes
    /// in two separate transactions — anyone monitoring mainnet could win the
    /// race, install their own wasm hash, and have every wallet subsequently
    /// deployed through the factory run attacker-controlled code.
    pub fn init(env: Env, wasm_hash: BytesN<32>) -> Result<(), FactoryError> {
        let admin = storage::get_admin(&env).ok_or(FactoryError::NotInitialized)?;
        admin.require_auth();
        if storage::has_wasm_hash(&env) {
            return Err(FactoryError::AlreadyInitialized);
        }
        storage::set_wasm_hash(&env, &wasm_hash);
        Ok(())
    }

    /// Point FUTURE deployments at a new wallet implementation.
    ///
    /// Admin-gated with the same gate as `init` (the admin fixed at
    /// construction). What it deliberately does NOT do: touch any wallet that
    /// already exists. `deploy` reads the hash at call time to instantiate new
    /// contracts, and a deployed wallet's code is pinned by its own contract
    /// instance — the factory holds no pointer back to it. Counterfactual
    /// addresses are untouched for the same reason: a wallet's address derives
    /// from the factory address and the salt (SHA-256 of the public key),
    /// never from the wasm hash, so an address computed before this call is
    /// the address `deploy` still produces after it.
    ///
    /// Unlike `init`, this refuses to run before a first hash exists: `init`
    /// stays the one place first installation happens, so its race-protection
    /// story is unchanged.
    pub fn set_wasm_hash(env: Env, new_hash: BytesN<32>) -> Result<(), FactoryError> {
        let admin = storage::get_admin(&env).ok_or(FactoryError::NotInitialized)?;
        admin.require_auth();
        if !storage::has_wasm_hash(&env) {
            return Err(FactoryError::NotInitialized);
        }
        storage::set_wasm_hash(&env, &new_hash);
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

        // Step 3: compute salt = SHA-256(public_key_bytes) via host function.
        // Deterministic — same as the prior `sha2` crate output for the same
        // input, so wallet addresses for a given public key are unchanged.
        let pk_bytes = soroban_sdk::Bytes::from_array(&env, &public_key.to_array());
        let salt = env.crypto().sha256(&pk_bytes).into();

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
/// Test-only helper used to verify deploy()'s salt against the expected hash.
/// Production code uses `env.crypto().sha256()` (deterministic, same output).
#[cfg(test)]
fn sha2_hash(input: &[u8; 65]) -> [u8; 32] {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(input);
    hasher.finalize().into()
}

#[cfg(test)]
mod test {
    extern crate std;
    use soroban_sdk::testutils::{Ledger as _, storage::Persistent as _};
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Bytes, Env, BytesN};

    const MOCK_WALLET_WASM: &[u8] = include_bytes!("../test-fixtures/mock_wallet.wasm");

    fn make_env() -> Env {
        Env::default()
    }

    /// Register a Factory with a fresh admin and mock its auth so `init` (which
    /// now requires the admin's signature) works in tests. Returns the factory's
    /// contract address.
    fn register_factory(env: &Env) -> Address {
        env.mock_all_auths();
        let admin = Address::generate(env);
        env.register(Factory, (admin,))
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
        let client = FactoryClient::new(&env, &contract_id);
        let hash = dummy_wasm_hash(&env);
        client.init(&hash);
        assert_eq!(
            client.try_init(&hash),
            Err(Ok(FactoryError::AlreadyInitialized))
        );
    }

    // ── set_wasm_hash (issue #1171) ───────────────────────────────────────

    #[test]
    fn test_set_wasm_hash_updates_the_stored_hash_under_admin_auth() {
        let env = make_env();
        let contract_id = register_factory(&env); // mocks all auths
        let client = FactoryClient::new(&env, &contract_id);
        client.init(&dummy_wasm_hash(&env));

        let new_hash = BytesN::from_array(&env, &[2u8; 32]);
        client.set_wasm_hash(&new_hash);

        // The call required exactly the admin's authorization.
        let (who, _invocation) = env.auths().last().unwrap().clone();
        env.as_contract(&contract_id, || {
            assert_eq!(Some(who), storage::get_admin(&env));
            assert_eq!(storage::get_wasm_hash(&env).unwrap(), new_hash);
        });
    }

    #[test]
    fn test_set_wasm_hash_rejects_non_admin() {
        let env = make_env();
        let admin = Address::generate(&env);
        let contract_id = env.register(Factory, (admin.clone(),));
        let client = FactoryClient::new(&env, &contract_id);
        env.mock_all_auths();
        client.init(&dummy_wasm_hash(&env));

        // From here on, nobody's signature is mocked: the admin gate must fail
        // the call outright, whoever submits it.
        env.set_auths(&[]);
        let new_hash = BytesN::from_array(&env, &[2u8; 32]);
        assert!(client.try_set_wasm_hash(&new_hash).is_err());
        env.mock_all_auths();
        env.as_contract(&contract_id, || {
            assert_eq!(storage::get_wasm_hash(&env).unwrap(), dummy_wasm_hash(&env));
        });
    }

    #[test]
    fn test_set_wasm_hash_before_init_fails() {
        // `init` remains the only entry point that may install the FIRST hash.
        let env = make_env();
        let contract_id = register_factory(&env);
        let client = FactoryClient::new(&env, &contract_id);
        assert_eq!(
            client.try_set_wasm_hash(&dummy_wasm_hash(&env)),
            Err(Ok(FactoryError::NotInitialized))
        );
    }

    #[test]
    fn test_set_wasm_hash_changes_future_deploys_and_only_those() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = register_factory(&env);
        let client = FactoryClient::new(&env, &contract_id);
        let mock_hash = install_mock_wallet(&env);
        client.init(&mock_hash);

        let key_a = valid_pub_key(&env);
        let key_b = second_valid_pub_key(&env);
        let rp_id = make_rp_id(&env);
        let origin = make_origin(&env);

        // The counterfactual address for key B, computed BEFORE any hash
        // change: addresses derive from factory + salt, not from the hash.
        let salt_b = BytesN::from_array(&env, &sha2_hash(&key_b.to_array()));
        let predicted_b = env.as_contract(&contract_id, || {
            env.deployer()
                .with_address(env.current_contract_address(), salt_b.clone())
                .deployed_address()
        });

        let wallet_a = client.deploy(&key_a, &rp_id, &origin);

        // Point future deployments at a hash with no code behind it.
        let missing_hash = BytesN::from_array(&env, &[9u8; 32]);
        client.set_wasm_hash(&missing_hash);

        // The already-deployed wallet is provably unaffected: it still runs
        // its own code. If the factory change could reach back into deployed
        // wallets, every user's wallet would brick on an upgrade.
        let still_signer: bool = env.invoke_contract(
            &wallet_a,
            &symbol_short!("is_signer"),
            (key_a.clone(),).into_val(&env),
        );
        assert!(still_signer);

        // A NEW deployment reads the new hash — which resolves to nothing, so
        // it fails. This is the proof deploy() takes the updated hash.
        assert!(client.try_deploy(&key_b, &rp_id, &origin).is_err());

        // Restore a real implementation: deployments work again, and key B
        // lands exactly on the address predicted before any hash change.
        client.set_wasm_hash(&mock_hash);
        let wallet_b = client.deploy(&key_b, &rp_id, &origin);
        assert_eq!(wallet_b, predicted_b);
        assert_ne!(wallet_b, wallet_a);
    }

    // ── 1. Happy Path ─────────────────────────────────────────────────────

    #[test]
    fn test_deploy_happy_path() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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
        let contract_id = register_factory(&env);
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

    // ── 7. Deployed-set scaling (persistent per-salt markers) ─────────────

    /// Seed `n` distinct deployed markers straight through the storage layer.
    /// Deploying this many real wallets is far too slow for a unit test, and
    /// `mark_deployed` is exactly what `deploy` calls after a successful deploy.
    fn seed_deployed(env: &Env, contract_id: &Address, n: u32) {
        env.cost_estimate().budget().reset_unlimited();
        env.as_contract(contract_id, || {
            for i in 0..n {
                let mut raw = [0u8; 32];
                raw[..4].copy_from_slice(&i.to_be_bytes());
                raw[31] = 0xAA; // never collides with a SHA-256 of a real key in practice
                storage::mark_deployed(env, &BytesN::from_array(env, &raw));
            }
        });
    }

    /// Ledger bytes read + written by one deploy() call.
    fn deploy_io_bytes(env: &Env, client: &FactoryClient, key: &BytesN<65>) -> (u32, u32, u64) {
        env.cost_estimate().budget().reset_unlimited();
        let _ = client.deploy(key, &make_rp_id(env), &make_origin(env));
        let r = env.cost_estimate().resources();
        let cpu = env.cost_estimate().budget().cpu_instruction_cost();
        (r.read_bytes, r.write_bytes, cpu)
    }

    #[test]
    fn test_deploy_cost_does_not_grow_with_existing_wallets() {
        // Baseline: a deploy into an empty factory.
        let env_a = make_env();
        env_a.mock_all_auths();
        let id_a = register_factory(&env_a);
        let client_a = FactoryClient::new(&env_a, &id_a);
        client_a.init(&install_mock_wallet(&env_a));
        let (read_a, write_a, cpu_a) = deploy_io_bytes(&env_a, &client_a, &valid_pub_key(&env_a));

        // Same deploy into a factory that already tracks 500 wallets. With the
        // old instance-storage set this is well past the point where the
        // instance entry dominates every call.
        let env_b = make_env();
        env_b.mock_all_auths();
        let id_b = register_factory(&env_b);
        let client_b = FactoryClient::new(&env_b, &id_b);
        client_b.init(&install_mock_wallet(&env_b));
        seed_deployed(&env_b, &id_b, 500);
        let (read_b, write_b, cpu_b) = deploy_io_bytes(&env_b, &client_b, &valid_pub_key(&env_b));

        std::println!(
            "deploy cost, 0 existing: read={read_a}B write={write_a}B cpu={cpu_a}; \
             500 existing: read={read_b}B write={write_b}B cpu={cpu_b}"
        );

        // Allow a small constant slack, but the metered ledger I/O must not scale with the number of existing wallets.
        assert!(read_b <= read_a + 512, "read bytes grew: {read_a} -> {read_b}");
        assert!(write_b <= write_a + 512, "write bytes grew: {write_a} -> {write_b}");
        // CPU is printed but deliberately not asserted: the soroban test host's
        // own bookkeeping over the (test-only) ledger snapshot makes it grow with
        // the number of entries even when the on-chain footprint is constant.
    }

    #[test]
    fn test_deploy_still_works_past_old_instance_limit() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = register_factory(&env);
        let client = FactoryClient::new(&env, &contract_id);
        client.init(&install_mock_wallet(&env));

        // 500 markers is ~37 KB in the old instance entry — enough to show the
        // growth the persistent markers remove.
        seed_deployed(&env, &contract_id, 500);
        env.cost_estimate().budget().reset_unlimited();

        let pub_key = valid_pub_key(&env);
        let wallet = client.deploy(&pub_key, &make_rp_id(&env), &make_origin(&env));
        assert_ne!(wallet, contract_id);
        assert_eq!(
            client.try_deploy(&pub_key, &make_rp_id(&env), &make_origin(&env)),
            Err(Ok(FactoryError::AlreadyDeployed))
        );
    }

    #[test]
    fn test_is_deployed_answers_for_early_wallet_after_many_deploys() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = register_factory(&env);
        let client = FactoryClient::new(&env, &contract_id);
        client.init(&install_mock_wallet(&env));

        let pub_key = valid_pub_key(&env);
        let _ = client.deploy(&pub_key, &make_rp_id(&env), &make_origin(&env));
        let first_salt = BytesN::from_array(&env, &sha2_hash(&pub_key.to_array()));

        seed_deployed(&env, &contract_id, 500);

        env.as_contract(&contract_id, || {
            assert!(storage::is_deployed(&env, &first_salt));
            assert!(!storage::is_deployed(&env, &BytesN::from_array(&env, &[7u8; 32])));
        });
    }

    #[test]
    fn test_deployed_marker_is_persistent_and_has_long_ttl() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = register_factory(&env);
        let client = FactoryClient::new(&env, &contract_id);
        client.init(&install_mock_wallet(&env));
        let pub_key = valid_pub_key(&env);
        let _ = client.deploy(&pub_key, &make_rp_id(&env), &make_origin(&env));
        let salt = BytesN::from_array(&env, &sha2_hash(&pub_key.to_array()));

        env.as_contract(&contract_id, || {
            let key = storage::DataKey::Deployed(salt.clone());
            // Lives in persistent storage, not in the instance entry.
            assert!(env.storage().persistent().has(&key));
            assert!(!env.storage().instance().has(&key));
            assert_eq!(
                env.storage().persistent().get_ttl(&key),
                storage::DEPLOYED_TTL_EXTEND_TO
            );
        });

        // The instance entry (admin, wasm hash) has its own TTL that this change
        // does not touch; keep it alive so the test isolates the marker's TTL.
        env.ledger().with_mut(|l| {
            l.max_entry_ttl = storage::DEPLOYED_TTL_EXTEND_TO * 3;
        });
        env.as_contract(&contract_id, || {
            let ttl = storage::DEPLOYED_TTL_EXTEND_TO * 2;
            env.storage().instance().extend_ttl(ttl, ttl);
        });
        // Advance past the bump threshold; a lookup re-extends the marker.
        env.ledger().with_mut(|l| {
            l.sequence_number += storage::DEPLOYED_TTL_EXTEND_TO - 100;
        });
        env.as_contract(&contract_id, || {
            assert!(storage::is_deployed(&env, &salt));
            let key = storage::DataKey::Deployed(salt.clone());
            assert_eq!(
                env.storage().persistent().get_ttl(&key),
                storage::DEPLOYED_TTL_EXTEND_TO
            );
        });
    }

    /// ADR 0005 pins the multi-wallet salt scheme before anyone ships one:
    /// index 0 is DEFINED as today's bare SHA-256(public_key) — not
    /// SHA-256(public_key ‖ be32(0)) — so every existing wallet, including
    /// every wallet holding money on mainnet, is retroactively index 0 of its
    /// key without moving. If this test fails, a salt change has broken the
    /// one compatibility invariant multi-wallet is allowed to rely on.
    #[test]
    fn multi_wallet_index_zero_salt_is_todays_salt() {
        let env = make_env();
        env.mock_all_auths();
        let contract_id = register_factory(&env);
        let client = FactoryClient::new(&env, &contract_id);
        client.init(&install_mock_wallet(&env));

        let key = valid_pub_key(&env);

        // ADR 0005: salt(pk, 0) = SHA-256(pk), byte-identical to what
        // deploy() computes today, predicted before the deploy happens.
        let index_zero_salt = BytesN::from_array(&env, &sha2_hash(&key.to_array()));
        let predicted = env.as_contract(&contract_id, || {
            env.deployer()
                .with_address(env.current_contract_address(), index_zero_salt.clone())
                .deployed_address()
        });

        let deployed = client.deploy(&key, &make_rp_id(&env), &make_origin(&env));
        assert_eq!(deployed, predicted, "index 0 must be today's address");

        // And index 0 is NOT the concatenated form: SHA-256(pk ‖ be32(0))
        // is a different salt. A naive implementation that concatenates for
        // every index — zero included — would silently move every existing
        // wallet to a new address.
        fn sha2_hash_69(input: &[u8; 69]) -> [u8; 32] {
            use sha2::{Digest, Sha256};
            let mut hasher = Sha256::new();
            hasher.update(input);
            hasher.finalize().into()
        }
        let mut concatenated = [0u8; 69];
        concatenated[..65].copy_from_slice(&key.to_array());
        // The last four bytes stay 0x00000000 — be32(0).
        assert_ne!(sha2_hash_69(&concatenated), sha2_hash(&key.to_array()));

        // Index 1 under the scheme is a distinct salt and a distinct address.
        let mut with_index_one = concatenated;
        with_index_one[68] = 1; // be32(1)
        let index_one_address = env.as_contract(&contract_id, || {
            env.deployer()
                .with_address(
                    env.current_contract_address(),
                    BytesN::from_array(&env, &sha2_hash_69(&with_index_one)),
                )
                .deployed_address()
        });
        assert_ne!(index_one_address, deployed);
    }
}

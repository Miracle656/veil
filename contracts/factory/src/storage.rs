use soroban_sdk::{contracttype, Address, Env, BytesN};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    WasmHash,
    Deployed(BytesN<32>),
    Admin,
}

pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

pub fn set_wasm_hash(env: &Env, hash: &BytesN<32>) {
    env.storage().instance().set(&DataKey::WasmHash, hash);
}

pub fn get_wasm_hash(env: &Env) -> Option<BytesN<32>> {
    env.storage().instance().get(&DataKey::WasmHash)
}

pub fn has_wasm_hash(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::WasmHash)
}

/// TTL policy for the per-salt "deployed" markers (persistent storage).
///
/// Ledgers close roughly every 5 seconds, so 17_280 ledgers is about one day.
/// A marker is bumped to ~30 days whenever fewer than ~29 days remain, both when
/// it is written and every time it is read, so a wallet that is still being
/// looked up never lapses. If a marker does expire (a wallet nobody touched for
/// a month) the factory still cannot double-deploy: the deployer refuses to
/// create a contract at an address that already exists, so the marker only
/// provides the friendly `AlreadyDeployed` error, never the safety guarantee.
pub const DEPLOYED_TTL_THRESHOLD: u32 = 29 * 17_280;
pub const DEPLOYED_TTL_EXTEND_TO: u32 = 30 * 17_280;

/// Each marker is its own persistent ledger entry, so a deploy touches only the
/// entry for its own salt. Nothing is added to the instance entry, which is
/// loaded on every call to the contract and has a hard size cap.
pub fn mark_deployed(env: &Env, salt: &BytesN<32>) {
    let key = DataKey::Deployed(salt.clone());
    env.storage().persistent().set(&key, &());
    env.storage()
        .persistent()
        .extend_ttl(&key, DEPLOYED_TTL_THRESHOLD, DEPLOYED_TTL_EXTEND_TO);
}

pub fn is_deployed(env: &Env, salt: &BytesN<32>) -> bool {
    let key = DataKey::Deployed(salt.clone());
    let present = env.storage().persistent().has(&key);
    if present {
        env.storage()
            .persistent()
            .extend_ttl(&key, DEPLOYED_TTL_THRESHOLD, DEPLOYED_TTL_EXTEND_TO);
    }
    present
}

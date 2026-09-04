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

pub fn mark_deployed(env: &Env, salt: &BytesN<32>) {
    env.storage().instance().set(&DataKey::Deployed(salt.clone()), &());
}

pub fn is_deployed(env: &Env, salt: &BytesN<32>) -> bool {
    env.storage().instance().has(&DataKey::Deployed(salt.clone()))
}

use soroban_sdk::{contracttype, Env, BytesN, String};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Signer(BytesN<65>), 
    Guardian,           
    RpId,
    Origin,
}

pub fn add_signer(env: &Env, key: &BytesN<65>) {
    env.storage().persistent().set(&DataKey::Signer(key.clone()), &());
}

pub fn remove_signer(env: &Env, key: &BytesN<65>) {
    env.storage().persistent().remove(&DataKey::Signer(key.clone()));
}

pub fn has_signer(env: &Env, key: &BytesN<65>) -> bool {
    env.storage().persistent().has(&DataKey::Signer(key.clone()))
}

pub fn set_guardian(env: &Env, guardian_key: &BytesN<65>) {
    env.storage().instance().set(&DataKey::Guardian, guardian_key);
}

pub fn get_guardian(env: &Env) -> Option<BytesN<65>> {
    env.storage().instance().get(&DataKey::Guardian)
}

pub fn set_rp_id(env: &Env, rp_id: &String) {
    env.storage().instance().set(&DataKey::RpId, rp_id);
}

pub fn get_rp_id(env: &Env) -> Option<String> {
    env.storage().instance().get(&DataKey::RpId)
}

pub fn set_origin(env: &Env, origin: &String) {
    env.storage().instance().set(&DataKey::Origin, origin);
}

pub fn get_origin(env: &Env) -> Option<String> {
    env.storage().instance().get(&DataKey::Origin)
}

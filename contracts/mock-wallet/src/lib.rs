#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Env, Bytes, BytesN};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Signer(BytesN<65>),
}

#[contract]
pub struct MockWallet;

#[contractimpl]
impl MockWallet {
    /// Mirrors invisible_wallet::init: accepts public_key, rp_id, and origin
    /// so the factory contract can deploy and initialise the mock in tests.
    pub fn init(env: Env, public_key: BytesN<65>, _rp_id: Bytes, _origin: Bytes) {
        env.storage().persistent().set(&DataKey::Signer(public_key), &());
    }

    pub fn is_signer(env: Env, key: BytesN<65>) -> bool {
        env.storage().persistent().has(&DataKey::Signer(key))
    }
}

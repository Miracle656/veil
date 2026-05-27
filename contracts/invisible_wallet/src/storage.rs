use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Map};


/// Stores details of a pending guardian recovery request.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRecovery {
    pub credential_id: Bytes,
    pub new_public_key: BytesN<65>,
    pub recovery_unlock_time: u64,
}
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Legacy single-signer key — no longer used after multi-signer migration.
    Signer(BytesN<65>),
    /// Map<u32, BytesN<65>> of signer index → public key.
    Signers,
    Guardian,
    /// SHA-256 preimage of the expected rpIdHash (e.g. "localhost" or "veil.app").
    /// Stored at init time; compared against auth_data[0..32] in __check_auth.
    RpId,
    /// The expected WebAuthn origin (e.g. "https://veil.app").
    /// Stored at init time; extracted from clientDataJSON and compared in __check_auth.
    Origin,
    /// Stores a PendingRecovery struct while a guardian recovery is in progress.
    RecoveryPending,
    /// Strictly monotonic u64 nonce to prevent signature replay attacks.
    Nonce,
    /// Granular spending limit for a spender and token.
    Allowance(AllowanceKey),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowanceKey {
    pub spender: Address,
    pub token: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Allowance {
    pub amount: i128,
    pub expiry: Option<u64>,
}

// ── Signers (Map-based) ──────────────────────────────────────────────────────

/// Initialise the signer map with the first credential_id → public_key pair.
pub fn init_signers(env: &Env, credential_id: Bytes, key: BytesN<65>) {
    let mut signers: Map<Bytes, BytesN<65>> = Map::new(env);
    signers.set(credential_id, key);
    env.storage().instance().set(&DataKey::Signers, &signers);
}

///  Add a new signer (credential_id → public_key).
pub fn add_signer(env: &Env, credential_id: Bytes, key: BytesN<65>) {
    let mut signers = get_signers(env);
    require_existing_signer(env);
    signers.set(credential_id, key);
    env.storage().instance().set(&DataKey::Signers, &signers);
}

/// Remove a signer by index. Returns true if the signer existed and was removed.
pub fn remove_signer(env: &Env, credential_id: &Bytes) -> Result<bool, WalletError> {
    let mut signers = get_signers(env);
    require_existing_signer(env);
      if signers.len() == 1 {
        return Err(WalletError::CannotRemoveLastSigner);
    }    
      if signers.contains_key(credential_id) {
        signers.remove(credential_id);
        env.storage().instance().set(&DataKey::Signers, &signers);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Get the full signers map.
pub fn get_signers(env: &Env) -> Map<Bytes, BytesN<65>> {
    env.storage()
        .instance()
        .get(&DataKey::Signers)
        .unwrap_or_else(|| Map::new(env))
}

pub fn get_signer(env: &Env, credential_id: &Bytes) -> Option<BytesN<65>> {
    get_signers(env).get(credential_id)
}

// â”€â”€ Guardian â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub fn set_guardian(env: &Env, guardian_key: &Address) {
    env.storage().persistent().set(&DataKey::Guardian, guardian_key);
}

pub fn get_guardian(env: &Env) -> Option<Address> {
    env.storage().persistent().get(&DataKey::Guardian)
}

// â”€â”€ RP ID â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Persist the relying party ID (e.g. "localhost" for dev, "veil.app" for prod).
pub fn set_rp_id(env: &Env, rp_id: &Bytes) {
    env.storage().instance().set(&DataKey::RpId, rp_id);
}

/// Retrieve the stored relying party ID.
pub fn get_rp_id(env: &Env) -> Option<Bytes> {
    env.storage().instance().get(&DataKey::RpId)
}

// â”€â”€ Origin â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/// Persist the expected WebAuthn origin (e.g. "https://veil.app").
pub fn set_origin(env: &Env, origin: &Bytes) {
    env.storage().instance().set(&DataKey::Origin, origin);
}

/// Retrieve the stored origin.
pub fn get_origin(env: &Env) -> Option<Bytes> {
    env.storage().instance().get(&DataKey::Origin)
}

// ── Nonce ───────────────────────────────────────────────────────────────────

pub fn get_nonce(env: &Env) -> u64 {
    env.storage().instance().get(&DataKey::Nonce).unwrap_or(0u64)
}

pub fn increment_nonce(env: &Env) {
    let current = get_nonce(env);
    env.storage().instance().set(&DataKey::Nonce, &(current + 1));
}

#[cfg(test)]
mod tests;

use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Map};


/// Stores details of a pending guardian recovery request.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingRecovery {
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
    /// The designated recovery key address (Address).
    RecoveryKey,
    /// Stores a PendingRecovery struct while a recovery-key request is in progress.
    RecoveryKeyPending,
    /// Monotonically increasing counter used to allocate the next signer index.
    /// Never decremented on removal, so indices are never reused.
    NextSignerIndex,
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

/// Initialise the signer map with a single key at index 0.
pub fn init_signers(env: &Env, key: &BytesN<65>) {
    let mut signers: Map<u32, BytesN<65>> = Map::new(env);
    signers.set(0, key.clone());
    env.storage().instance().set(&DataKey::Signers, &signers);
    env.storage().instance().set(&DataKey::NextSignerIndex, &1u32);
}

/// Add a new signer and return its index.
///
/// Index allocation uses a dedicated monotonic counter (`NextSignerIndex`)
/// rather than `signers.len()`. We chose the counter over renumbering on
/// removal because renumbering would silently change the meaning of every
/// index a client has cached (e.g. a UI that shows "signer #2" and later
/// asks to remove it). With a monotonic counter, an index, once handed out,
/// always refers to the same key until that key is removed — and once
/// removed, the index is never reused, so a stale cached index can never
/// address a different signer. The trade-off is that indices become sparse
/// and `signer_count` no longer equals `max_index + 1`; see `signer_count`.
///
/// Rejects (returns `None`) if the key is already a registered signer, to
/// match the duplicate guard in `rotate_signer`.
pub fn add_signer(env: &Env, key: &BytesN<65>) -> Option<u32> {
    if has_signer(env, key) {
        return None;
    }
    let mut signers = get_signers(env);
    let next_index: u32 = env
        .storage()
        .instance()
        .get(&DataKey::NextSignerIndex)
        .unwrap_or(0u32);
    signers.set(next_index, key.clone());
    env.storage().instance().set(&DataKey::Signers, &signers);
    env.storage()
        .instance()
        .set(&DataKey::NextSignerIndex, &(next_index + 1));
    Some(next_index)
}

/// Remove a signer by index. Returns true if the signer existed and was removed.
pub fn remove_signer(env: &Env, index: u32) -> bool {
    let mut signers = get_signers(env);
    if signers.contains_key(index) {
        signers.remove(index);
        env.storage().instance().set(&DataKey::Signers, &signers);
        true
    } else {
        false
    }
}

/// Replace the public key of an existing signer in place, keeping the same
/// index so the signer set size and slot layout are preserved. Returns true if
/// `old_key` was found and replaced, false otherwise. Used by `rotate_signer`
/// to swap a lost device's key without re-deploying the wallet.
pub fn replace_signer(env: &Env, old_key: &BytesN<65>, new_key: &BytesN<65>) -> bool {
    let mut signers = get_signers(env);
    for (index, stored_key) in signers.iter() {
        if stored_key == *old_key {
            signers.set(index, new_key.clone());
            env.storage().instance().set(&DataKey::Signers, &signers);
            return true;
        }
    }
    false
}

/// Check if any signer key matches the given public key.
pub fn has_signer(env: &Env, key: &BytesN<65>) -> bool {
    let signers = get_signers(env);
    for (_index, stored_key) in signers.iter() {
        if stored_key == *key {
            return true;
        }
    }
    false
}

/// Get the number of registered signers.
///
/// This is the count of live entries in the map, NOT `max_index + 1`.
/// Indices are sparse after any removal (see `add_signer`), so callers
/// must not assume the count equals the highest index plus one. The
/// last-signer guard in `remove_signer` relies on this being the true
/// number of live signers, which `Map::len()` provides regardless of
/// sparseness.
pub fn signer_count(env: &Env) -> u32 {
    get_signers(env).len()
}

/// Get the full signers map.
pub fn get_signers(env: &Env) -> Map<u32, BytesN<65>> {
    env.storage()
        .instance()
        .get(&DataKey::Signers)
        .unwrap_or_else(|| Map::new(env))
}

// â”€â”€ Guardian â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

pub fn set_guardian(env: &Env, guardian_key: &BytesN<65>) {
    env.storage().instance().set(&DataKey::Guardian, guardian_key);
}

pub fn get_guardian(env: &Env) -> Option<BytesN<65>> {
    env.storage().instance().get(&DataKey::Guardian)
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

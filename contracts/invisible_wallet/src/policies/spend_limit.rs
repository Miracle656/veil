//! Per-key, per-token 24-hour rolling spend limits.
//!
//! # What a limit is denominated in
//!
//! A limit is denominated in **one token**: the base units of one specific
//! token contract. A cap of `100_000_000` on the native asset contract means
//! one XLM per 24 hours, and it means nothing at all on any other contract.
//! The contract has no price oracle and no notion of what a token is worth, so
//! it cannot convert between them and does not try: the only way a single
//! number can mean one thing is for it to be tied to one asset.
//!
//! # Why the limit is keyed per (key, token)
//!
//! The earlier shape was one cap per key, enforced against the sum of every
//! amount in the authorization, whatever asset it was in. That made the same
//! cap mean wildly different amounts of money depending on what the key
//! happened to spend: 100 units of XLM is a fraction of a cent, 100 units of a
//! stablecoin is a hundred cents. A user who set a limit in XLM silently got
//! a much larger limit the moment the wallet held a stablecoin.
//!
//! The fix is to make the cap's *unit* explicit. Each (key, token) pair
//! carries its own cap, its own running total, and its own window.
//!
//! # What an unset token means
//!
//! **An unset token is denied, for any key that has at least one limit.**
//!
//! The alternative — an unset token meaning "no limit" — would leave the
//! original defect in place wearing a different hat. A cap of 100 XLM that
//! silently permits unlimited USDC is not a limit on USDC; it is a limit on
//! XLM plus an unlimited cheque on everything else, and the user has no way
//! to tell which of the two they configured. Denying is also the only reading
//! under which "100 XLM" means 100 XLM.
//!
//! Two consequences, both deliberate:
//!
//!   * A key with **no limits at all** is unrestricted. The feature is
//!     opt-in: a key nobody has limited keeps exactly the behaviour it has
//!     today, so no existing wallet changes behaviour because of this code.
//!   * A key with **at least one limit** is *scoped*: it may move only the
//!     tokens it has a budget for, and every other call it makes — including
//!     calls to the wallet contract itself — is refused. A scoped key is a
//!     spending credential, not an administrator: it cannot add signers,
//!     rotate keys, change limits, or reach `execute`.
//!
//! # Who manages a limit
//!
//! A limited key cannot manage limits — not its own, not another key's. A
//! limit that the limited key could lift would not be a limit, and a limit
//! that could be swapped for a bigger one by the key it binds would be a
//! speed bump.
//!
//! So limits are set and removed by a signer that has none, which is the key
//! that owns the wallet. The shape of the feature follows from that: a second
//! passkey is the thing that gets limited, and the passkey that owns the
//! wallet keeps full control over it.
//!
//! The one way out for a wallet whose only signer is limited is the recovery
//! key, which is authorized separately from the signers and is not affected by
//! any of this.
//!
//! # The window
//!
//! Each (key, token) pair rolls its own 24-hour window, independently of every
//! other pair. Spending XLM neither exhausts nor extends the USDC budget.

use crate::WalletError;
use soroban_sdk::{contracttype, Address, BytesN, Env, Vec};

/// Rolling window duration: 24 hours in seconds.
pub const WINDOW_SECS: u64 = 86_400;

/// Per-key, per-token 24-hour rolling spend window record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendWindow {
    /// Maximum amount of *this token* that may be spent in any single
    /// 24-hour window, in the token's base units.
    pub cap: i128,
    /// Unix timestamp (seconds) when the current window started.
    pub window_start: u64,
    /// Cumulative amount of *this token* spent within the current window.
    pub window_spent: i128,
}

/// Identifies one spend limit: the signer key it applies to, and the token its
/// cap is denominated in.
///
/// The shape mirrors the allowance key in `storage.rs` — a subject and a
/// token — because a limit that cannot say which asset it is denominated in
/// is a limit that cannot say what it is worth.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendLimitScope {
    /// The WebAuthn signer public key (65 bytes, uncompressed P-256).
    pub key_id: BytesN<65>,
    /// The token contract the cap is denominated in.
    pub token: Address,
}

#[contracttype]
enum SpendLimitKey {
    /// (key, token) → the window for that pair.
    Limit(SpendLimitScope),
    /// key → the tokens that key has a limit for.
    Tokens(BytesN<65>),
}

/// The tokens `key_id` has a spend limit for.
///
/// Empty means the key has no limits at all and is therefore unrestricted.
pub fn tokens(env: &Env, key_id: &BytesN<65>) -> Vec<Address> {
    env.storage()
        .persistent()
        .get(&SpendLimitKey::Tokens(key_id.clone()))
        .unwrap_or_else(|| Vec::new(env))
}

/// Whether `key_id` has any spend limit at all.
///
/// A key with no limits is unrestricted — that is the whole point of keeping
/// the feature opt-in.
pub fn has_limits(env: &Env, key_id: &BytesN<65>) -> bool {
    !tokens(env, key_id).is_empty()
}

/// Set (or replace) the 24-hour cap for `key_id` on `token`.
///
/// The window is reset to the current ledger timestamp and `window_spent` to
/// zero, exactly as the single-token limit did. A cap of zero blocks all
/// spending of that token.
pub fn set(env: &Env, key_id: &BytesN<65>, token: &Address, cap: i128) {
    let record = SpendWindow {
        cap,
        window_start: env.ledger().timestamp(),
        window_spent: 0,
    };
    env.storage().persistent().set(
        &SpendLimitKey::Limit(SpendLimitScope {
            key_id: key_id.clone(),
            token: token.clone(),
        }),
        &record,
    );

    // The scope is the set of tokens this key may move. A key with a limit on
    // one token and no limit on another is *scoped* to the first, so the
    // second is refused — see the module docs for why.
    let mut scope = tokens(env, key_id);
    if !scope.contains(token) {
        scope.push_back(token.clone());
    }
    env.storage()
        .persistent()
        .set(&SpendLimitKey::Tokens(key_id.clone()), &scope);
}

/// Remove the cap for (key_id, token).
///
/// If that was the key's only limit, the key becomes unrestricted again.
pub fn remove(env: &Env, key_id: &BytesN<65>, token: &Address) {
    env.storage()
        .persistent()
        .remove(&SpendLimitKey::Limit(SpendLimitScope {
            key_id: key_id.clone(),
            token: token.clone(),
        }));

    let mut scope = tokens(env, key_id);
    if let Some(index) = scope.first_index_of(token) {
        scope.remove(index);
    }
    if scope.is_empty() {
        env.storage()
            .persistent()
            .remove(&SpendLimitKey::Tokens(key_id.clone()));
    } else {
        env.storage()
            .persistent()
            .set(&SpendLimitKey::Tokens(key_id.clone()), &scope);
    }
}

/// Remove every cap for `key_id`, making it unrestricted again.
pub fn remove_all(env: &Env, key_id: &BytesN<65>) {
    for token in tokens(env, key_id).iter() {
        env.storage()
            .persistent()
            .remove(&SpendLimitKey::Limit(SpendLimitScope {
                key_id: key_id.clone(),
                token: token.clone(),
            }));
    }
    env.storage()
        .persistent()
        .remove(&SpendLimitKey::Tokens(key_id.clone()));
}

/// Retrieve the current spend window record for (key_id, token), if any.
pub fn get(env: &Env, key_id: &BytesN<65>, token: &Address) -> Option<SpendWindow> {
    env.storage()
        .persistent()
        .get(&SpendLimitKey::Limit(SpendLimitScope {
            key_id: key_id.clone(),
            token: token.clone(),
        }))
}

/// Enforce the per-token 24-hour rolling spend window for one authorized call.
///
/// `token` is the contract the authorized call targets. For a SEP-41 token
/// call that contract *is* the token, and `amount` is the number of the
/// token's base units being moved.
///
/// A key with no limits at all passes unconditionally. A key with at least one
/// limit is scoped: a token it has no budget for is refused, and the budget it
/// does have is checked against the rolling window and updated.
///
/// Returns `SpendLimitExceeded` if `window_spent + amount > cap` for that
/// token.
pub fn enforce(
    env: &Env,
    key_id: &BytesN<65>,
    token: &Address,
    amount: i128,
) -> Result<(), WalletError> {
    let scope = tokens(env, key_id);
    if scope.is_empty() {
        // No limit configured for this key: nothing to enforce.
        return Ok(());
    }

    if !scope.contains(token) {
        // The key is scoped and this token is not in scope. Denied, not
        // unlimited — see the module docs.
        return Err(WalletError::SpendLimitTokenNotAllowed);
    }

    let mut record = match get(env, key_id, token) {
        Some(record) => record,
        // The scope says this token has a budget but its record is gone.
        // Refuse rather than fall back to "unlimited".
        None => return Err(WalletError::SpendLimitExceeded),
    };

    let now = env.ledger().timestamp();
    if now >= record.window_start + WINDOW_SECS {
        record.window_start = now;
        record.window_spent = 0;
    }

    // A negative amount would *reduce* the running total and hand the key
    // more budget than it had. The SAC rejects negative transfers in
    // practice, but the guard belongs here.
    if amount < 0 {
        return Err(WalletError::NegativeAmount);
    }

    let new_spent = record
        .window_spent
        .checked_add(amount)
        .ok_or(WalletError::SpendLimitExceeded)?;

    if new_spent > record.cap {
        return Err(WalletError::SpendLimitExceeded);
    }

    record.window_spent = new_spent;
    env.storage().persistent().set(
        &SpendLimitKey::Limit(SpendLimitScope {
            key_id: key_id.clone(),
            token: token.clone(),
        }),
        &record,
    );

    Ok(())
}

/// Enforce the policy for an authorized call that moves no token this module
/// can account for.
///
/// That is a call whose argument layout is not part of the token interface, or
/// a host-function context such as a contract creation. The amount such a call
/// moves is unknown, so it cannot be budgeted — and a scoped key may not make
/// a call that cannot be budgeted.
pub fn enforce_unmetered(env: &Env, key_id: &BytesN<65>) -> Result<(), WalletError> {
    if has_limits(env, key_id) {
        return Err(WalletError::SpendLimitUnsupportedCall);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Env};

    fn make_key(env: &Env, seed: u8) -> BytesN<65> {
        BytesN::from_array(env, &[seed; 65])
    }

    fn contract_id(env: &Env) -> soroban_sdk::Address {
        env.register_contract(None, crate::InvisibleWallet)
    }

    /// A token contract address. Distinct addresses stand in for XLM and USDC:
    /// what makes a token a token here is its identity, not its price.
    fn token(env: &Env) -> Address {
        Address::generate(env)
    }

    // ── Authorisation: no limit configured ────────────────────────────────────
    // A key with no spend limit is intentionally unrestricted; if this fails,
    // every unconfigured key is silently blocked from spending.

    // ── No limit configured ───────────────────────────────────────────────────

    #[test]
    fn no_limit_always_passes() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x01);
        let xlm = token(&env);
        env.as_contract(&cid, || {
            assert!(enforce(&env, &key, &xlm, i128::MAX).is_ok());
            assert!(enforce_unmetered(&env, &key).is_ok());

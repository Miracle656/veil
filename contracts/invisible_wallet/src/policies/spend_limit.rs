use soroban_sdk::{contracttype, BytesN, Env};
use crate::WalletError;

/// Rolling window duration: 24 hours in seconds.
pub const WINDOW_SECS: u64 = 86_400;

/// Per-key 24-hour rolling spend window record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SpendWindow {
    /// Maximum amount that may be spent in any single 24-hour window.
    pub cap: i128,
    /// Unix timestamp (seconds) when the current window started.
    pub window_start: u64,
    /// Cumulative amount spent within the current window.
    pub window_spent: i128,
}

#[contracttype]
enum SpendLimitKey {
    Limit(BytesN<65>),
}

/// Store or update the spend limit for a WebAuthn signer key.
/// The window is reset to the current ledger timestamp and `window_spent` to 0.
pub fn set(env: &Env, key_id: &BytesN<65>, cap: i128) {
    let record = SpendWindow {
        cap,
        window_start: env.ledger().timestamp(),
        window_spent: 0,
    };
    env.storage()
        .persistent()
        .set(&SpendLimitKey::Limit(key_id.clone()), &record);
}

/// Remove the spend limit for a key (no limit = no enforcement).
pub fn remove(env: &Env, key_id: &BytesN<65>) {
    env.storage()
        .persistent()
        .remove(&SpendLimitKey::Limit(key_id.clone()));
}

/// Retrieve the current spend window record for a key, if any.
pub fn get(env: &Env, key_id: &BytesN<65>) -> Option<SpendWindow> {
    env.storage()
        .persistent()
        .get(&SpendLimitKey::Limit(key_id.clone()))
}

/// Enforce the per-key 24-hour rolling spend window and update storage.
///
/// If no limit is configured for `key_id`, the call passes unconditionally.
/// When the current ledger timestamp is at or past `window_start + WINDOW_SECS`,
/// the window resets: `window_start` is set to now and `window_spent` to zero.
/// Returns `SpendLimitExceeded` if `window_spent + amount > cap`.
pub fn enforce(env: &Env, key_id: &BytesN<65>, amount: i128) -> Result<(), WalletError> {
    let mut record = match get(env, key_id) {
        Some(r) => r,
        None => return Ok(()),
    };

    let now = env.ledger().timestamp();

    if now >= record.window_start + WINDOW_SECS {
        record.window_start = now;
        record.window_spent = 0;
    }

    let new_spent = record
        .window_spent
        .checked_add(amount)
        .ok_or(WalletError::SpendLimitExceeded)?;

    if new_spent > record.cap {
        return Err(WalletError::SpendLimitExceeded);
    }

    record.window_spent = new_spent;
    env.storage()
        .persistent()
        .set(&SpendLimitKey::Limit(key_id.clone()), &record);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Ledger, Env};

    fn make_key(env: &Env, seed: u8) -> BytesN<65> {
        BytesN::from_array(env, &[seed; 65])
    }

    fn contract_id(env: &Env) -> soroban_sdk::Address {
        env.register_contract(None, crate::InvisibleWallet)
    }

    // ── No limit configured ───────────────────────────────────────────────────

    #[test]
    fn no_limit_always_passes() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x01);
        env.as_contract(&cid, || {
            assert!(enforce(&env, &key, i128::MAX).is_ok());
        });
    }

    // ── Within cap ───────────────────────────────────────────────────────────

    #[test]
    fn within_cap_passes() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x02);
        env.as_contract(&cid, || {
            set(&env, &key, 1_000);
            assert!(enforce(&env, &key, 500).is_ok());
            assert!(enforce(&env, &key, 500).is_ok());
        });
    }

    // ── Exactly at cap ────────────────────────────────────────────────────────

    #[test]
    fn exactly_at_cap_passes() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x03);
        env.as_contract(&cid, || {
            set(&env, &key, 1_000);
            assert!(enforce(&env, &key, 1_000).is_ok());
        });
    }

    // ── Over cap rejected ────────────────────────────────────────────────────

    #[test]
    fn over_cap_rejected() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x04);
        env.as_contract(&cid, || {
            set(&env, &key, 1_000);
            assert_eq!(
                enforce(&env, &key, 1_001),
                Err(WalletError::SpendLimitExceeded)
            );
        });
    }

    // ── Cumulative spend enforced ─────────────────────────────────────────────

    #[test]
    fn cumulative_over_cap_rejected() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x05);
        env.as_contract(&cid, || {
            set(&env, &key, 1_000);
            assert!(enforce(&env, &key, 600).is_ok());
            // 401 would push total to 1001 > 1000
            assert_eq!(
                enforce(&env, &key, 401),
                Err(WalletError::SpendLimitExceeded)
            );
            // exactly 400 remaining is still allowed
            assert!(enforce(&env, &key, 400).is_ok());
            // now at cap — any further spend rejected
            assert_eq!(
                enforce(&env, &key, 1),
                Err(WalletError::SpendLimitExceeded)
            );
        });
    }

    // ── Window resets after 24h ───────────────────────────────────────────────

    #[test]
    fn window_resets_after_24h() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x06);
        env.as_contract(&cid, || {
            set(&env, &key, 1_000);
            assert!(enforce(&env, &key, 1_000).is_ok());
            assert_eq!(enforce(&env, &key, 1), Err(WalletError::SpendLimitExceeded));

            // Advance ledger time by exactly WINDOW_SECS — window resets
            let mut info = env.ledger().get();
            info.timestamp += WINDOW_SECS;
            env.ledger().set(info);

            assert!(enforce(&env, &key, 1_000).is_ok());
        });
    }

    // ── Window does NOT reset before 24h ─────────────────────────────────────

    #[test]
    fn window_not_reset_before_24h() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x07);
        env.as_contract(&cid, || {
            set(&env, &key, 1_000);
            assert!(enforce(&env, &key, 1_000).is_ok());

            // Advance to 1 second before window expiry
            let mut info = env.ledger().get();
            info.timestamp += WINDOW_SECS - 1;
            env.ledger().set(info);

            assert_eq!(enforce(&env, &key, 1), Err(WalletError::SpendLimitExceeded));
        });
    }

    // ── Spent counter persists across calls ───────────────────────────────────

    #[test]
    fn spent_persists_across_calls() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x08);
        env.as_contract(&cid, || {
            set(&env, &key, 300);
            enforce(&env, &key, 100).unwrap();
            enforce(&env, &key, 100).unwrap();
            enforce(&env, &key, 100).unwrap();

            let record = get(&env, &key).unwrap();
            assert_eq!(record.window_spent, 300);
            assert_eq!(record.cap, 300);
        });
    }

    // ── Remove clears enforcement ─────────────────────────────────────────────

    #[test]
    fn remove_clears_limit() {
        let env = Env::default();
        let cid = contract_id(&env);
        let key = make_key(&env, 0x09);
        env.as_contract(&cid, || {
            set(&env, &key, 0); // cap = 0 blocks everything
            assert_eq!(enforce(&env, &key, 1), Err(WalletError::SpendLimitExceeded));
            remove(&env, &key);
            assert!(enforce(&env, &key, 1_000_000).is_ok());
        });
    }
}

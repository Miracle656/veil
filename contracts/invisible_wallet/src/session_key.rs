use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Symbol};
use crate::WalletError;

// Approximate seconds per Stellar ledger — used when converting a wall-clock
// expiry to a ledger TTL extension.  5 s/ledger is the Stellar target; the
// 10-ledger buffer below absorbs variance.
const LEDGER_SECONDS: u64 = 5;

/// Access-control record stored per session key.
///
/// Session keys are scoped bearer credentials backed by a real ed25519 keypair.
/// The `pubkey` field holds the *public* key of the holder; every auth attempt
/// must carry an ed25519 signature over `signature_payload` produced by the
/// corresponding private key.  The `key_id` is a public lookup handle only —
/// knowing it is not sufficient to authorise a transfer.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionKeyAcl {
    /// The 32-byte ed25519 public key registered for this session key.
    ///
    /// Every `__check_auth` call via this key MUST carry an ed25519 signature
    /// of `signature_payload` verifiable against this public key.  The private
    /// key never leaves the holder's device — only the signature travels on-chain.
    pub pubkey: BytesN<32>,
    /// The only contract address this key may target.
    pub target_contract: Address,
    /// The only function selector this key may invoke.
    pub selector: Symbol,
    /// Total token budget across the lifetime of this session key (raw units).
    ///
    /// Authorisation is rejected once `spent + amount > amount_cap`.
    /// This is a *cumulative* cap, not a per-call limit: a key with
    /// `amount_cap = 1_000` can authorise at most 1 000 units in total across
    /// all transfers before it is exhausted.
    pub amount_cap: i128,
    /// Running total of all amounts successfully authorised so far.
    ///
    /// Persisted in storage after every successful `enforce` call.  Never
    /// decremented.  Overflow is rejected via `checked_add`.
    pub spent: i128,
    /// Unix timestamp (seconds) after which the key is no longer valid.
    pub expiry: u64,
}

#[contracttype]
enum SessionDataKey {
    Acl(BytesN<32>),
}

/// Persist an ACL for a session key and extend the temporary-storage TTL to
/// cover `acl.expiry`.
///
/// # TTL semantics
///
/// `temporary().set()` assigns the node's *default* ledger TTL, which is
/// expressed in ledger sequence numbers and is **unrelated to `acl.expiry`**.
/// The `extend_ttl` call converts the remaining wall-clock seconds to an
/// approximate ledger count (5 s/ledger + 10-ledger buffer) so the entry is
/// not evicted before the session key expires.
///
/// If the ledger count overflows `u32`, the TTL is clamped to `u32::MAX`.
/// A missing ACL in `get_acl` is always treated as a rejected auth; a
/// prematurely evicted entry cannot be used even if its wall-clock expiry
/// has not passed.
pub fn register(env: &Env, key_id: BytesN<32>, acl: SessionKeyAcl) {
    let storage_key = SessionDataKey::Acl(key_id.clone());
    env.storage().temporary().set(&storage_key, &acl);

    let now = env.ledger().timestamp();
    let remaining_secs = acl.expiry.saturating_sub(now);
    let ledgers_needed = (remaining_secs / LEDGER_SECONDS)
        .saturating_add(10)
        .min(u32::MAX as u64) as u32;

    if ledgers_needed > 0 {
        env.storage()
            .temporary()
            .extend_ttl(&storage_key, ledgers_needed, ledgers_needed);
    }
}

/// Retrieve the ACL for a session key, or `None` if it was never registered
/// or has been evicted.
pub fn get_acl(env: &Env, key_id: &BytesN<32>) -> Option<SessionKeyAcl> {
    env.storage()
        .temporary()
        .get(&SessionDataKey::Acl(key_id.clone()))
}

/// Remove a session key immediately (owner-initiated revocation).
pub fn revoke(env: &Env, key_id: &BytesN<32>) {
    env.storage()
        .temporary()
        .remove(&SessionDataKey::Acl(key_id.clone()));
}

/// Enforce ACL constraints for one call context and update the cumulative
/// `spent` counter.
///
/// Returns `Ok(())` only when **all** of the following hold:
///   - the key exists and has not expired,
///   - `target` matches `acl.target_contract`,
///   - `selector` matches `acl.selector`, and
///   - `acl.spent + amount <= acl.amount_cap` (cumulative budget not exceeded).
///
/// On success the updated ACL (with incremented `spent`) is written back to
/// temporary storage so the next call in the same `__check_auth` loop sees the
/// correct running total.
pub fn enforce(
    env: &Env,
    key_id: &BytesN<32>,
    target: &Address,
    selector: &Symbol,
    amount: i128,
) -> Result<(), WalletError> {
    let mut acl = get_acl(env, key_id).ok_or(WalletError::SignerNotAuthorized)?;

    if env.ledger().timestamp() > acl.expiry {
        return Err(WalletError::SessionKeyExpired);
    }

    if *target != acl.target_contract {
        return Err(WalletError::SessionKeyAclViolation);
    }

    if *selector != acl.selector {
        return Err(WalletError::SessionKeyAclViolation);
    }

    // Cumulative budget check: reject if this call would push total spend over cap.
    let new_spent = acl
        .spent
        .checked_add(amount)
        .ok_or(WalletError::SessionKeyAclViolation)?;
    if new_spent > acl.amount_cap {
        return Err(WalletError::SessionKeyAclViolation);
    }

    // Persist the updated spend counter so successive calls in the same
    // `__check_auth` invocation see the correct running total.
    acl.spent = new_spent;
    env.storage()
        .temporary()
        .set(&SessionDataKey::Acl(key_id.clone()), &acl);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger}, Env, symbol_short};

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        let contract_id = env.register_contract(None, crate::InvisibleWallet);
        let target = Address::generate(&env);
        (env, contract_id, target)
    }

    fn mock_key_id(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    fn mock_pubkey(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    fn base_acl(env: &Env, target: Address, sel: soroban_sdk::Symbol) -> SessionKeyAcl {
        SessionKeyAcl {
            pubkey: mock_pubkey(env, 0xAA),
            target_contract: target,
            selector: sel,
            amount_cap: 1_000_000,
            spent: 0,
            expiry: env.ledger().timestamp() + 10_000,
        }
    }

    // ── Target enforcement ────────────────────────────────────────────────────

    #[test]
    fn acl_fields_enforced_target() {
        let (env, contract_id, target) = setup();
        let other = Address::generate(&env);
        let key_id = mock_key_id(&env, 0x01);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), base_acl(&env, target.clone(), sel.clone()));

            assert_eq!(
                enforce(&env, &key_id, &other, &sel, 100),
                Err(WalletError::SessionKeyAclViolation)
            );
            assert!(enforce(&env, &key_id, &target, &sel, 100).is_ok());
        });
    }

    // ── Selector enforcement ──────────────────────────────────────────────────

    #[test]
    fn acl_fields_enforced_selector() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x02);
        let sel = symbol_short!("transfer");
        let other_sel = symbol_short!("approve");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), base_acl(&env, target.clone(), sel.clone()));

            assert_eq!(
                enforce(&env, &key_id, &target, &other_sel, 100),
                Err(WalletError::SessionKeyAclViolation)
            );
            assert!(enforce(&env, &key_id, &target, &sel, 100).is_ok());
        });
    }

    // ── Amount cap — per-call boundary ───────────────────────────────────────

    #[test]
    fn acl_fields_enforced_amount_cap_per_call() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x03);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), SessionKeyAcl {
                pubkey: mock_pubkey(&env, 0xBB),
                target_contract: target.clone(),
                selector: sel.clone(),
                amount_cap: 500,
                spent: 0,
                expiry: env.ledger().timestamp() + 10_000,
            });

            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 501),
                Err(WalletError::SessionKeyAclViolation)
            );
            assert!(enforce(&env, &key_id, &target, &sel, 500).is_ok());
        });
    }

    // ── Cumulative budget enforcement ─────────────────────────────────────────

    #[test]
    fn cumulative_budget_enforced() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x06);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), SessionKeyAcl {
                pubkey: mock_pubkey(&env, 0xCC),
                target_contract: target.clone(),
                selector: sel.clone(),
                amount_cap: 1_000,
                spent: 0,
                expiry: env.ledger().timestamp() + 10_000,
            });

            // First call: spend 600
            assert!(enforce(&env, &key_id, &target, &sel, 600).is_ok());
            // spent is now 600; cap is 1_000 → 400 remaining

            // Second call: 401 exceeds remaining budget even though 401 < cap
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 401),
                Err(WalletError::SessionKeyAclViolation)
            );

            // Second call: exactly 400 is still allowed
            assert!(enforce(&env, &key_id, &target, &sel, 400).is_ok());
            // spent is now 1_000 = cap

            // Third call: budget exhausted, even amount=1 is rejected
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 1),
                Err(WalletError::SessionKeyAclViolation)
            );
        });
    }

    #[test]
    fn spent_persists_across_calls() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x07);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), SessionKeyAcl {
                pubkey: mock_pubkey(&env, 0xDD),
                target_contract: target.clone(),
                selector: sel.clone(),
                amount_cap: 300,
                spent: 0,
                expiry: env.ledger().timestamp() + 10_000,
            });

            enforce(&env, &key_id, &target, &sel, 100).unwrap(); // spent = 100
            enforce(&env, &key_id, &target, &sel, 100).unwrap(); // spent = 200
            enforce(&env, &key_id, &target, &sel, 100).unwrap(); // spent = 300

            // Now fully exhausted
            let acl = get_acl(&env, &key_id).unwrap();
            assert_eq!(acl.spent, 300);
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 1),
                Err(WalletError::SessionKeyAclViolation)
            );
        });
    }

    // ── Expiry enforcement ────────────────────────────────────────────────────

    #[test]
    fn expired_key_rejected() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x04);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), SessionKeyAcl {
                pubkey: mock_pubkey(&env, 0xEE),
                target_contract: target.clone(),
                selector: sel.clone(),
                amount_cap: 1_000_000,
                spent: 0,
                expiry: 1_000,
            });

            let mut info = env.ledger().get();
            info.timestamp = 2_000;
            env.ledger().set(info);

            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 100),
                Err(WalletError::SessionKeyExpired)
            );
        });
    }

    // ── Unregistered key ──────────────────────────────────────────────────────

    #[test]
    fn unregistered_key_rejected() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x05);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 100),
                Err(WalletError::SignerNotAuthorized)
            );
        });
    }

    // ── Revocation ────────────────────────────────────────────────────────────

    #[test]
    fn revoked_key_rejected() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x08);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), base_acl(&env, target.clone(), sel.clone()));
            assert!(enforce(&env, &key_id, &target, &sel, 1).is_ok());

            revoke(&env, &key_id);

            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 1),
                Err(WalletError::SignerNotAuthorized)
            );
        });
    }
}
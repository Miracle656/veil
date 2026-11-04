use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Symbol, Val, Vec};
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
///
/// # Upgrade authority
///
/// A session key can never authorise `upgrade`. The upgrade path replaces the
/// entire wallet contract, which is strictly more powerful than any single
/// selector a session key can be scoped to, so `upgrade` is not a selector a
/// session key may name. Only the wallet's own signer set (through
/// `__check_auth`'s full signer path) may upgrade. See [`enforce`], which
/// refuses any call whose selector is `upgrade`.
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
    /// Allowed recipients. **Empty means unconstrained** (the original
    /// behaviour): the cap then bounds how much leaves, not where it goes.
    /// When non-empty, a call whose payee is not in this list is rejected, and
    /// so is any call whose payee cannot be determined.
    pub payees: Vec<Address>,
    /// Optional per-call ceiling, alongside the cumulative `amount_cap`.
    /// `None` means a single call may spend the whole remaining budget.
    pub per_call_max: Option<i128>,
}

/// The reserved selector that replaces the wallet contract. Session keys may
/// never be scoped to it, and [`enforce`] refuses it unconditionally.
pub const UPGRADE_SELECTOR: &str = "upgrade";

/// What a call spends and who receives it, read per selector.
///
/// Defined once, in [`crate::sep41`], because the session-key budget and the
/// per-key spend limit have to price the same call the same way.
pub use crate::sep41::CallEffect;

/// Reads the amount and payee out of a call's arguments using the argument
/// layout of that specific selector (SEP-41 token interface).
///
/// The layout table lives in [`crate::sep41`] — see it for the per-selector
/// argument positions.
///
/// An unknown selector, a wrong argument count or an argument of the wrong type
/// is refused with `SessionKeyAclViolation` instead of being guessed at (the
/// previous positional `args[2]` read silently produced `0` for these).
pub fn extract_call_effect(
    env: &Env,
    selector: &Symbol,
    args: &Vec<Val>,
) -> Result<CallEffect, WalletError> {
    crate::sep41::describe(env, selector, args).map_err(|_| WalletError::SessionKeyAclViolation)
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
///   - `selector` is not the reserved `upgrade` selector,
///   - `target` matches `acl.target_contract`,
///   - `selector` matches `acl.selector`, and
///   - `amount <= acl.per_call_max` when a per-call maximum is set,
///   - the payee is in `acl.payees` when that list is non-empty, and
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
    payee: Option<&Address>,
) -> Result<(), WalletError> {
    let mut acl = get_acl(env, key_id).ok_or(WalletError::SignerNotAuthorized)?;

    // Expiry is compared against the consensus ledger timestamp with a small
    // clock-skew grace window; see `crate::auth::expiration` for the rationale.
    crate::auth::expiration::ensure_not_expired(
        env.ledger().timestamp(),
        acl.expiry,
        WalletError::SessionKeyExpired,
    )?;

    // Upgrade is never delegable to a session key: replacing the contract is
    // strictly more powerful than any scoped selector, regardless of what the
    // ACL names. Refused even if the ACL was (mis)registered with it.
    if *selector == Symbol::new(env, UPGRADE_SELECTOR) {
        return Err(WalletError::SessionKeyAclViolation);
    }

    if *target != acl.target_contract {
        return Err(WalletError::SessionKeyAclViolation);
    }

    if *selector != acl.selector {
        return Err(WalletError::SessionKeyAclViolation);
    }

    if let Some(max) = acl.per_call_max {
        if amount > max {
            return Err(WalletError::SessionKeyAclViolation);
        }
    }

    // Payee constraint: only enforced when the key has an allow-list, so a key
    // registered without one behaves exactly as before. With an allow-list, a
    // call with no determinable payee (e.g. `burn`) is refused too.
    if !acl.payees.is_empty() {
        match payee {
            Some(p) if acl.payees.contains(p) => {}
            _ => return Err(WalletError::SessionKeyAclViolation),
        }
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
            payees: Vec::new(env),
            per_call_max: None,
        }
    }

    // ── Target enforcement ────────────────────────────────────────────────────

    // Hazard: a session key scoped to one token contract must not be replayable
    // against another. If this fails, a stolen session key can drain any contract
    // the wallet holds, not just the one the owner scoped it to.
    #[test]
    fn acl_fields_enforced_target() {
        let (env, contract_id, target) = setup();
        let other = Address::generate(&env);
        let key_id = mock_key_id(&env, 0x01);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), base_acl(&env, target.clone(), sel.clone()));

            assert_eq!(
                enforce(&env, &key_id, &other, &sel, 100, None),
                Err(WalletError::SessionKeyAclViolation)
            );
            assert!(enforce(&env, &key_id, &target, &sel, 100, None).is_ok());
        });
    }

    // ── Selector enforcement ──────────────────────────────────────────────────

    // Hazard: a key scoped to `transfer` must not be usable for `approve` (or
    // any other selector). If this fails, a key meant for a bounded transfer can
    // grant an unbounded allowance instead.
    #[test]
    fn acl_fields_enforced_selector() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x02);
        let sel = symbol_short!("transfer");
        let other_sel = symbol_short!("approve");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), base_acl(&env, target.clone(), sel.clone()));

            assert_eq!(
                enforce(&env, &key_id, &target, &other_sel, 100, None),
                Err(WalletError::SessionKeyAclViolation)
            );
            assert!(enforce(&env, &key_id, &target, &sel, 100, None).is_ok());
        });
    }

    // ── Upgrade is never delegable to a session key ──────────────────────────

    // Hazard: a session key must not be able to replace the wallet contract.
    // Replacing the code is strictly more powerful than any scoped transfer, so
    // even a key whose ACL names `upgrade` is refused, and the refusal does not
    // consume any of its budget.
    #[test]
    fn session_key_cannot_authorise_upgrade() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x04);
        let upgrade = Symbol::new(&env, UPGRADE_SELECTOR);

        env.as_contract(&contract_id, || {
            register(
                &env,
                key_id.clone(),
                base_acl(&env, target.clone(), upgrade.clone()),
            );

            assert_eq!(
                enforce(&env, &key_id, &target, &upgrade, 0, None),
                Err(WalletError::SessionKeyAclViolation)
            );
            // Refused before any budget was touched.
            assert_eq!(get_acl(&env, &key_id).unwrap().spent, 0);
        });
    }

    // ── Amount cap — per-call boundary ───────────────────────────────────────

    // Hazard: a single call must not exceed the cumulative cap. If this fails,
    // one oversized call can drain the entire budget in a single authorisation
    // instead of being bounded by the remaining allowance.
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
                payees: Vec::new(&env),
                per_call_max: None,
            });

            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 501, None),
                Err(WalletError::SessionKeyAclViolation)
            );
            assert!(
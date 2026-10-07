use soroban_sdk::{contracttype, Address, Bytes, BytesN, Env, Symbol, TryFromVal, Val, Vec};
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
    /// Allowed recipients. **Empty means unconstrained** (the original
    /// behaviour): the cap then bounds how much leaves, not where it goes.
    /// When non-empty, a call whose payee is not in this list is rejected, and
    /// so is any call whose payee cannot be determined.
    pub payees: Vec<Address>,
    /// Optional per-call ceiling, alongside the cumulative `amount_cap`.
    /// `None` means a single call may spend the whole remaining budget.
    pub per_call_max: Option<i128>,
}

/// What a call spends and who receives it, read per selector.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CallEffect {
    pub amount: i128,
    /// `None` for selectors with no recipient (e.g. `burn`).
    pub payee: Option<Address>,
}

/// Reads the amount and payee out of a call's arguments using the argument
/// layout of that specific selector (SEP-41 token interface):
///
/// | selector        | args                                   | amount | payee   |
/// |-----------------|----------------------------------------|--------|---------|
/// | `transfer`      | `(from, to, amount)`                   | 2      | `to`    |
/// | `transfer_from` | `(spender, from, to, amount)`          | 3      | `to`    |
/// | `approve`       | `(from, spender, amount, expiration)`  | 2      | spender |
/// | `burn`          | `(from, amount)`                       | 1      | none    |
///
/// An unknown selector, a wrong argument count or an argument of the wrong type
/// is refused with `SessionKeyAclViolation` instead of being guessed at (the
/// previous positional `args[2]` read silently produced `0` for these).
pub fn extract_call_effect(
    env: &Env,
    selector: &Symbol,
    args: &Vec<Val>,
) -> Result<CallEffect, WalletError> {
    let (len, amount_idx, payee_idx): (u32, u32, Option<u32>) =
        if *selector == Symbol::new(env, "transfer") {
            (3, 2, Some(1))
        } else if *selector == Symbol::new(env, "transfer_from") {
            (4, 3, Some(2))
        } else if *selector == Symbol::new(env, "approve") {
            (4, 2, Some(1))
        } else if *selector == Symbol::new(env, "burn") {
            (2, 1, None)
        } else {
            return Err(WalletError::SessionKeyAclViolation);
        };

    if args.len() != len {
        return Err(WalletError::SessionKeyAclViolation);
    }

    let amount = i128::try_from_val(env, &args.get(amount_idx).unwrap())
        .map_err(|_| WalletError::SessionKeyAclViolation)?;
    let payee = match payee_idx {
        Some(i) => Some(
            Address::try_from_val(env, &args.get(i).unwrap())
                .map_err(|_| WalletError::SessionKeyAclViolation)?,
        ),
        None => None,
    };
    Ok(CallEffect { amount, payee })
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
                payees: Vec::new(&env),
                per_call_max: None,
            });

            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 501, None),
                Err(WalletError::SessionKeyAclViolation)
            );
            assert!(enforce(&env, &key_id, &target, &sel, 500, None).is_ok());
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
                payees: Vec::new(&env),
                per_call_max: None,
            });

            // First call: spend 600
            assert!(enforce(&env, &key_id, &target, &sel, 600, None).is_ok());
            // spent is now 600; cap is 1_000 → 400 remaining

            // Second call: 401 exceeds remaining budget even though 401 < cap
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 401, None),
                Err(WalletError::SessionKeyAclViolation)
            );

            // Second call: exactly 400 is still allowed
            assert!(enforce(&env, &key_id, &target, &sel, 400, None).is_ok());
            // spent is now 1_000 = cap

            // Third call: budget exhausted, even amount=1 is rejected
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 1, None),
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
                payees: Vec::new(&env),
                per_call_max: None,
            });

            enforce(&env, &key_id, &target, &sel, 100, None).unwrap(); // spent = 100
            enforce(&env, &key_id, &target, &sel, 100, None).unwrap(); // spent = 200
            enforce(&env, &key_id, &target, &sel, 100, None).unwrap(); // spent = 300

            // Now fully exhausted
            let acl = get_acl(&env, &key_id).unwrap();
            assert_eq!(acl.spent, 300);
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 1, None),
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
                payees: Vec::new(&env),
                per_call_max: None,
            });

            let mut info = env.ledger().get();
            info.timestamp = 2_000;
            env.ledger().set(info);

            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 100, None),
                Err(WalletError::SessionKeyExpired)
            );
        });
    }

    // ── Expiry boundary behaviour (clock-skew tolerance) ──────────────────────

    use crate::auth::expiration::CLOCK_SKEW_TOLERANCE_SECS;

    /// Register a key expiring at `expiry`, advance the ledger clock to `now`,
    /// and return the result of a minimal `enforce` call.
    fn enforce_at(env: &Env, contract_id: &Address, target: &Address, expiry: u64, now: u64)
        -> Result<(), WalletError>
    {
        let key_id = mock_key_id(env, 0x10);
        let sel = symbol_short!("transfer");
        env.as_contract(contract_id, || {
            register(env, key_id.clone(), SessionKeyAcl {
                pubkey: mock_pubkey(env, 0xAB),
                target_contract: target.clone(),
                selector: sel.clone(),
                amount_cap: 1_000_000,
                spent: 0,
                expiry,
                payees: Vec::new(env),
                per_call_max: None,
            });
            let mut info = env.ledger().get();
            info.timestamp = now;
            env.ledger().set(info);
            enforce(env, &key_id, target, &sel, 1, None)
        })
    }

    #[test]
    fn not_rejected_exactly_at_expiry() {
        let (env, contract_id, target) = setup();
        assert!(enforce_at(&env, &contract_id, &target, 1_000, 1_000).is_ok());
    }

    #[test]
    fn not_rejected_within_grace_window() {
        // One second past expiry — the skew case the tolerance exists to absorb.
        let (env, contract_id, target) = setup();
        assert!(enforce_at(&env, &contract_id, &target, 1_000, 1_001).is_ok());
        // Right at the edge of the grace window it is still accepted.
        let (env, contract_id, target) = setup();
        assert!(
            enforce_at(&env, &contract_id, &target, 1_000, 1_000 + CLOCK_SKEW_TOLERANCE_SECS)
                .is_ok()
        );
    }

    #[test]
    fn rejected_one_second_past_grace_window() {
        let (env, contract_id, target) = setup();
        assert_eq!(
            enforce_at(&env, &contract_id, &target, 1_000, 1_000 + CLOCK_SKEW_TOLERANCE_SECS + 1),
            Err(WalletError::SessionKeyExpired)
        );
    }

    // ── Unregistered key ──────────────────────────────────────────────────────

    #[test]
    fn unregistered_key_rejected() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x05);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 100, None),
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
            assert!(enforce(&env, &key_id, &target, &sel, 1, None).is_ok());

            revoke(&env, &key_id);

            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 1, None),
                Err(WalletError::SignerNotAuthorized)
            );
        });
    }

    // ── Payee constraint, per-call max and per-selector extraction ────────────

    use soroban_sdk::{vec, IntoVal};

    fn scoped_acl(
        env: &Env,
        target: Address,
        payees: Vec<Address>,
        per_call_max: Option<i128>,
    ) -> SessionKeyAcl {
        SessionKeyAcl {
            payees,
            per_call_max,
            ..base_acl(env, target, symbol_short!("transfer"))
        }
    }

    #[test]
    fn payee_constraint_accepts_right_payee_rejects_wrong_payee() {
        let (env, contract_id, target) = setup();
        let right = Address::generate(&env);
        let wrong = Address::generate(&env);
        let key_id = mock_key_id(&env, 0x20);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), scoped_acl(&env, target.clone(), vec![&env, right.clone()], None));

            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 10, Some(&wrong)),
                Err(WalletError::SessionKeyAclViolation)
            );
            // A rejected call must not consume budget.
            assert_eq!(get_acl(&env, &key_id).unwrap().spent, 0);
            assert!(enforce(&env, &key_id, &target, &sel, 10, Some(&right)).is_ok());
            // No determinable payee is refused when a constraint exists.
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 10, None),
                Err(WalletError::SessionKeyAclViolation)
            );
        });
    }

    #[test]
    fn payee_allow_list_accepts_any_listed_payee() {
        let (env, contract_id, target) = setup();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let key_id = mock_key_id(&env, 0x21);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), scoped_acl(&env, target.clone(), vec![&env, a.clone(), b.clone()], None));
            assert!(enforce(&env, &key_id, &target, &sel, 1, Some(&a)).is_ok());
            assert!(enforce(&env, &key_id, &target, &sel, 1, Some(&b)).is_ok());
        });
    }

    #[test]
    fn no_payee_constraint_allows_any_payee() {
        let (env, contract_id, target) = setup();
        let anyone = Address::generate(&env);
        let key_id = mock_key_id(&env, 0x22);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), base_acl(&env, target.clone(), sel.clone()));
            assert!(enforce(&env, &key_id, &target, &sel, 1, Some(&anyone)).is_ok());
            assert!(enforce(&env, &key_id, &target, &sel, 1, None).is_ok());
        });
    }

    #[test]
    fn per_call_max_rejects_single_large_call() {
        let (env, contract_id, target) = setup();
        let key_id = mock_key_id(&env, 0x23);
        let sel = symbol_short!("transfer");

        env.as_contract(&contract_id, || {
            register(&env, key_id.clone(), scoped_acl(&env, target.clone(), Vec::new(&env), Some(100)));
            assert_eq!(
                enforce(&env, &key_id, &target, &sel, 101, None),
                Err(WalletError::SessionKeyAclViolation)
            );
            assert!(enforce(&env, &key_id, &target, &sel, 100, None).is_ok());
        });
    }

    #[test]
    fn extract_transfer_reads_payee_and_amount() {
        let env = Env::default();
        let from = Address::generate(&env);
        let to = Address::generate(&env);
        let args: Vec<Val> = vec![&env, from.into_val(&env), to.clone().into_val(&env), 42i128.into_val(&env)];
        let e = extract_call_effect(&env, &symbol_short!("transfer"), &args).unwrap();
        assert_eq!(e, CallEffect { amount: 42, payee: Some(to) });
    }

    #[test]
    fn extract_other_selectors_use_their_own_layout() {
        let env = Env::default();
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);

        // transfer_from(spender, from, to, amount): payee is index 2, amount index 3.
        let args: Vec<Val> = vec![&env, a.clone().into_val(&env), b.clone().into_val(&env), c.clone().into_val(&env), 7i128.into_val(&env)];
        let e = extract_call_effect(&env, &Symbol::new(&env, "transfer_from"), &args).unwrap();
        assert_eq!(e, CallEffect { amount: 7, payee: Some(c.clone()) });

        // approve(from, spender, amount, expiration_ledger)
        let args: Vec<Val> = vec![&env, a.clone().into_val(&env), b.clone().into_val(&env), 9i128.into_val(&env), 100u32.into_val(&env)];
        let e = extract_call_effect(&env, &symbol_short!("approve"), &args).unwrap();
        assert_eq!(e, CallEffect { amount: 9, payee: Some(b) });

        // burn(from, amount): amount is index 1 and there is no payee.
        let args: Vec<Val> = vec![&env, a.into_val(&env), 5i128.into_val(&env)];
        let e = extract_call_effect(&env, &symbol_short!("burn"), &args).unwrap();
        assert_eq!(e, CallEffect { amount: 5, payee: None });
    }

    #[test]
    fn extract_refuses_unknown_selector_and_malformed_args() {
        let env = Env::default();
        let from = Address::generate(&env);
        let to = Address::generate(&env);

        let args: Vec<Val> = vec![&env, from.clone().into_val(&env), to.clone().into_val(&env), 1i128.into_val(&env)];
        assert_eq!(
            extract_call_effect(&env, &symbol_short!("mint"), &args),
            Err(WalletError::SessionKeyAclViolation)
        );

        // Too few / too many arguments.
        let short: Vec<Val> = vec![&env, from.clone().into_val(&env), to.clone().into_val(&env)];
        assert_eq!(
            extract_call_effect(&env, &symbol_short!("transfer"), &short),
            Err(WalletError::SessionKeyAclViolation)
        );
        let long: Vec<Val> = vec![&env, from.clone().into_val(&env), to.clone().into_val(&env), 1i128.into_val(&env), 1i128.into_val(&env)];
        assert_eq!(
            extract_call_effect(&env, &symbol_short!("transfer"), &long),
            Err(WalletError::SessionKeyAclViolation)
        );

        // Amount of the wrong type is not silently read as 0.
        let bad: Vec<Val> = vec![&env, from.into_val(&env), to.into_val(&env), symbol_short!("x").into_val(&env)];
        assert_eq!(
            extract_call_effect(&env, &symbol_short!("transfer"), &bad),
            Err(WalletError::SessionKeyAclViolation)
        );
    }
}

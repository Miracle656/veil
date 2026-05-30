use soroban_sdk::{contracttype, Address, BytesN, Env, Symbol};
use crate::WalletError;

/// Access-control record stored per session key.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionKeyAcl {
    /// The only contract address this key may target.
    pub target_contract: Address,
    /// The only function selector this key may invoke (e.g. `Symbol::new(&env, "transfer")`).
    pub selector: Symbol,
    /// Maximum token amount allowed per authorised call.
    pub amount_cap: i128,
    /// Unix timestamp (seconds) after which the key is no longer valid.
    pub expiry: u64,
}

#[contracttype]
enum SessionDataKey {
    Acl(BytesN<32>),
}

/// Persist an ACL for a session key.  Uses temporary storage so the entry
/// is automatically evicted once the ledger's TTL passes `expiry`.
pub fn register(env: &Env, key_id: BytesN<32>, acl: SessionKeyAcl) {
    env.storage()
        .temporary()
        .set(&SessionDataKey::Acl(key_id), &acl);
}

/// Retrieve the ACL for a session key, or `None` if it was never registered
/// or has already been evicted.
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

/// Enforce all ACL fields for a given call context.
///
/// Returns `Ok(())` only when:
///   - the key exists and has not expired,
///   - `target` matches `acl.target_contract`,
///   - `selector` matches `acl.selector`, and
///   - `amount` does not exceed `acl.amount_cap`.
pub fn enforce(
    env: &Env,
    key_id: &BytesN<32>,
    target: &Address,
    selector: &Symbol,
    amount: i128,
) -> Result<(), WalletError> {
    let acl = get_acl(env, key_id).ok_or(WalletError::SignerNotAuthorized)?;

    if env.ledger().timestamp() > acl.expiry {
        return Err(WalletError::SessionKeyExpired);
    }

    if *target != acl.target_contract {
        return Err(WalletError::SessionKeyAclViolation);
    }

    if *selector != acl.selector {
        return Err(WalletError::SessionKeyAclViolation);
    }

    if amount > acl.amount_cap {
        return Err(WalletError::SessionKeyAclViolation);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::{Address as _, Ledger}, Env, symbol_short};

    fn setup() -> (Env, Address) {
        let env = Env::default();
        let contract = Address::generate(&env);
        (env, contract)
    }

    fn mock_key_id(env: &Env, seed: u8) -> BytesN<32> {
        BytesN::from_array(env, &[seed; 32])
    }

    #[test]
    fn acl_fields_enforced_target() {
        let (env, target) = setup();
        let other = Address::generate(&env);
        let key_id = mock_key_id(&env, 0x01);
        let sel = symbol_short!("transfer");

        register(&env, key_id.clone(), SessionKeyAcl {
            target_contract: target.clone(),
            selector: sel.clone(),
            amount_cap: 1_000_000,
            expiry: 9_999_999_999,
        });

        // wrong target → AclViolation
        assert_eq!(
            enforce(&env, &key_id, &other, &sel, 100),
            Err(WalletError::SessionKeyAclViolation)
        );
        // correct target → Ok
        assert!(enforce(&env, &key_id, &target, &sel, 100).is_ok());
    }

    #[test]
    fn acl_fields_enforced_selector() {
        let (env, target) = setup();
        let key_id = mock_key_id(&env, 0x02);
        let sel = symbol_short!("transfer");
        let other_sel = symbol_short!("approve");

        register(&env, key_id.clone(), SessionKeyAcl {
            target_contract: target.clone(),
            selector: sel.clone(),
            amount_cap: 1_000_000,
            expiry: 9_999_999_999,
        });

        assert_eq!(
            enforce(&env, &key_id, &target, &other_sel, 100),
            Err(WalletError::SessionKeyAclViolation)
        );
        assert!(enforce(&env, &key_id, &target, &sel, 100).is_ok());
    }

    #[test]
    fn acl_fields_enforced_amount_cap() {
        let (env, target) = setup();
        let key_id = mock_key_id(&env, 0x03);
        let sel = symbol_short!("transfer");

        register(&env, key_id.clone(), SessionKeyAcl {
            target_contract: target.clone(),
            selector: sel.clone(),
            amount_cap: 500,
            expiry: 9_999_999_999,
        });

        assert_eq!(
            enforce(&env, &key_id, &target, &sel, 501),
            Err(WalletError::SessionKeyAclViolation)
        );
        assert!(enforce(&env, &key_id, &target, &sel, 500).is_ok());
    }

    #[test]
    fn expired_key_rejected() {
        let (env, target) = setup();
        let key_id = mock_key_id(&env, 0x04);
        let sel = symbol_short!("transfer");

        register(&env, key_id.clone(), SessionKeyAcl {
            target_contract: target.clone(),
            selector: sel.clone(),
            amount_cap: 1_000_000,
            expiry: 1_000, // far in the past
        });

        // advance ledger past expiry
        let mut info = env.ledger().get();
        info.timestamp = 2_000;
        env.ledger().set(info);

        assert_eq!(
            enforce(&env, &key_id, &target, &sel, 100),
            Err(WalletError::SessionKeyExpired)
        );
    }

    #[test]
    fn unregistered_key_rejected() {
        let (env, target) = setup();
        let key_id = mock_key_id(&env, 0x05);
        let sel = symbol_short!("transfer");

        assert_eq!(
            enforce(&env, &key_id, &target, &sel, 100),
            Err(WalletError::SignerNotAuthorized)
        );
    }
}
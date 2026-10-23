extern crate alloc;

use alloc::vec;
use soroban_sdk::{
    xdr::{ScBytes, ScSymbol, ScVal, ScVec},
    Address, BytesN, Env,
};
use soroban_sdk::testutils::Address as _;

use super::{AllowanceKey, DataKey};

// Exhaustive match: adding a variant without updating these tests causes a compile error.
// If this stops compiling, a new DataKey variant was added — check that it has a
// corresponding tag test below, or the storage layout can silently drift.
fn _cover_all_variants(key: &DataKey) {
    let _ = match key {
        DataKey::Signer(_) => (),
        DataKey::Signers => (),
        DataKey::Guardian => (),
        DataKey::RpId => (),
        DataKey::Origin => (),
        DataKey::RecoveryPending => (),
        DataKey::Nonce => (),
        DataKey::Allowance(_) => (),
        DataKey::RecoveryKey => (),
        DataKey::RecoveryKeyPending => (),
        DataKey::NextSignerIndex => (),
    };
}

fn unit_key_scval(name: &str) -> ScVal {
    ScVal::Vec(Some(ScVec(
        vec![ScVal::Symbol(ScSymbol(name.try_into().unwrap()))]
            .try_into()
            .unwrap(),
    )))
}

// ── Unit-variant tests ─────────────────────────────────────────────────────────
//
// Group: lifecycle / storage layout.
// These guard the on-chain key encoding. If a tag changes, every wallet that
// already holds funds reads its state from the wrong slot and appears empty.
//
// Each test asserts the exact ScVal produced by the #[contracttype] codec so that
// renaming or adding fields is caught immediately.

#[test]
fn signers_key_tag() {
    let actual: ScVal = (&DataKey::Signers).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("Signers"));
}

// Guards authorisation: the signer set must be readable at the same key across
// upgrades, or existing wallets lose the ability to authorise transactions.
#[test]
fn guardian_key_tag() {
    let actual: ScVal = (&DataKey::Guardian).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("Guardian"));
}

// Guards authorisation: the relying-party id is bound into the passkey signing
// path; a tag change breaks passkey verification for deployed wallets.
#[test]
fn rp_id_key_tag() {
    let actual: ScVal = (&DataKey::RpId).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("RpId"));
}

// Guards authorisation: origin is checked against the passkey assertion; a tag
// change makes every existing assertion fail origin validation.
#[test]
fn origin_key_tag() {
    let actual: ScVal = (&DataKey::Origin).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("Origin"));
}

// Guards recovery: a pending recovery must be found at this key, or a recovery
// in flight is silently dropped and the guardian cannot complete it.
#[test]
fn recovery_pending_key_tag() {
    let actual: ScVal = (&DataKey::RecoveryPending).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("RecoveryPending"));
}

// Guards limits: the nonce must be read from this key, or replay protection
// resets and a signed transaction can be replayed.
#[test]
fn nonce_key_tag() {
    let actual: ScVal = (&DataKey::Nonce).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("Nonce"));
}

#[test]
fn next_signer_index_key_tag() {
    let actual: ScVal = (&DataKey::NextSignerIndex).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("NextSignerIndex"));
}

// ── Tuple-variant tests ────────────────────────────────────────────────────────
//
// Group: authorisation / limits.
// These guard the per-signer and per-allowance key encoding. A change here
// orphans existing signers or allowances, which can lock funds or bypass limits.

// Guards authorisation: each signer is stored under its own key; if the encoding
// changes, previously registered signers are no longer found and cannot sign.
#[test]
fn signer_key_tag() {
    let env = Env::default();
    // Use a deterministic 65-byte public-key vector (0x04 prefix + 64 bytes).
    let bytes = [4u8; 65];
    let key = DataKey::Signer(BytesN::from_array(&env, &bytes));
    let actual: ScVal = (&key).try_into().unwrap();

    let expected = ScVal::Vec(Some(ScVec(
        vec![
            ScVal::Symbol(ScSymbol("Signer".try_into().unwrap())),
            ScVal::Bytes(ScBytes(bytes.to_vec().try_into().unwrap())),
        ]
        .try_into()
        .unwrap(),
    )));
    assert_eq!(actual, expected);
}

// Guards limits: allowances are keyed by (spender, token); if the field order or
// names change, existing allowances are lost and spend limits silently reset.
#[test]
fn allowance_key_tag() {
    let env = Env::default();
    let spender = Address::generate(&env);
    let token = Address::generate(&env);
    let key = DataKey::Allowance(AllowanceKey {
        spender: spender.clone(),
        token: token.clone(),
    });

    let actual: ScVal = (&key).try_into().unwrap();

    // Outer shape: Vec([Symbol("Allowance"), Map(AllowanceKey)])
    let ScVal::Vec(Some(ref outer)) = actual else {
        panic!("DataKey::Allowance must encode as ScVal::Vec");
    };
    assert_eq!(
        outer.0.len(),
        2,
        "Allowance Vec must have discriminant + payload"
    );
    assert_eq!(
        outer.0[0],
        ScVal::Symbol(ScSymbol("Allowance".try_into().unwrap())),
        "discriminant symbol must be \"Allowance\""
    );

    // Inner shape: Map with exactly two entries in declaration order
    let ScVal::Map(Some(ref map)) = outer.0[1] else {
        panic!("AllowanceKey must encode as ScVal::Map");
    };
    assert_eq!(map.0.len(), 2, "AllowanceKey must have exactly two fields");
    assert_eq!(
        map.0[0].key,
        ScVal::Symbol(ScSymbol("spender".try_into().unwrap())),
        "first AllowanceKey field must be \"spender\""
    );
    assert_eq!(
        map.0[1].key,
        ScVal::Symbol(ScSymbol("token".try_into().unwrap())),
        "second AllowanceKey field must be \"token\""
    );
}

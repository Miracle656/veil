extern crate alloc;

use alloc::vec;
use soroban_sdk::{
    xdr::{ScBytes, ScSymbol, ScVal, ScVec},
    Address, BytesN, Env,
};
use soroban_sdk::testutils::Address as _;

use super::{AllowanceKey, DataKey};

// Exhaustive match: adding a variant without updating these tests causes a compile error.
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
// Each test asserts the exact ScVal produced by the #[contracttype] codec so that
// renaming or adding fields is caught immediately.

#[test]
fn signers_key_tag() {
    let actual: ScVal = (&DataKey::Signers).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("Signers"));
}

#[test]
fn guardian_key_tag() {
    let actual: ScVal = (&DataKey::Guardian).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("Guardian"));
}

#[test]
fn rp_id_key_tag() {
    let actual: ScVal = (&DataKey::RpId).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("RpId"));
}

#[test]
fn origin_key_tag() {
    let actual: ScVal = (&DataKey::Origin).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("Origin"));
}

#[test]
fn recovery_pending_key_tag() {
    let actual: ScVal = (&DataKey::RecoveryPending).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("RecoveryPending"));
}

#[test]
fn nonce_key_tag() {
    let actual: ScVal = (&DataKey::Nonce).try_into().unwrap();
    assert_eq!(actual, unit_key_scval("Nonce"));
}

// ── Tuple-variant tests ────────────────────────────────────────────────────────

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

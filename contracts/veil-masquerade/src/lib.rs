#![no_std]
//! Veil Masquerade — twenty cloth figures.
//!
//! A fixed collection: twenty tokens, ids 1 to 20, each matching one entry in
//! `brand/veil-masquerade/traits.json`. There is no minting beyond those
//! twenty and no way to add more, which is the one property a collection sold
//! on scarcity cannot be asked to take on trust.
//!
//! It shares nothing with the wallet, factory, multisig or vault contracts.
//!
//! ## Buying one requires holding a name
//!
//! A figure is not sold to the public; it is sold to people who already hold a
//! Veil name. The registry is itself an NFT contract, so "do they hold a name"
//! is `balance(buyer) > 0` on it — no reverse index, no list to scan, and no
//! second source of truth to drift.
//!
//! The gate is checked at the moment of purchase and never recorded. Selling
//! the name later does not take the figure away: the requirement is on buying,
//! not on keeping, and a token that could be clawed back is not owned.
//!
//! ## This one is upgradeable
//!
//! Like `veil-names` and unlike the wallet. The price, the gate and the
//! metadata base all have to be correctable, because the tokens live in this
//! contract and a second deployment would start empty. The cost is that the
//! admin is trusted; `set_admin` exists so that role can move to a multisig.
//!
//! ## What a buyer actually sees lives elsewhere
//!
//! The token is an id and an owner. The picture and the trait list are in a
//! JSON document the token points at: `base_uri` + a two-digit id + `.json`,
//! matching the files in `brand/veil-masquerade/metadata/`. `base_uri` is set
//! at initialize and changeable by the admin, because pinning moves and a
//! collection whose art 404s forever is worse than one whose admin can
//! repoint it.
//!
//! There are two ways in, because the standard one cannot answer the question
//! a shop asks. `token_uri` is the SEP/ERC-721 reading and panics for a token
//! nobody owns. `figure_uri` composes the same string without asking about
//! ownership, which is what a page listing twenty figures — nineteen of them
//! unsold — actually needs.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    vec, Address, BytesN, Env, IntoVal, String, Symbol,
};
use stellar_tokens::non_fungible::{
    burnable::NonFungibleBurnable, Base, NonFungibleToken, MAX_BASE_URI_LEN,
};

/// Twenty figures, fixed. Ids run 1..=20.
pub const COLLECTION_SIZE: u32 = 20;

/// Stroops per USDC. Stellar assets carry seven decimal places.
pub const UNIT: i128 = 10_000_000;

/// What one figure costs, in whole units of the payment asset.
pub const PRICE: i128 = 5;

/// Ledgers in roughly 30 days at five seconds a ledger.
const TTL_THRESHOLD: u32 = 29 * 17_280;
const TTL_EXTEND_TO: u32 = 30 * 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    /// Token id outside 1..=COLLECTION_SIZE.
    NoSuchFigure = 3,
    /// Somebody already holds this figure.
    AlreadySold = 4,
    /// The buyer holds no Veil name.
    NeedsName = 5,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// The SAC address figures are paid in (USDC).
    PayToken,
    /// Where payments go.
    Treasury,
    /// The Veil Names registry, asked whether a buyer holds a name.
    Names,
    /// token id -> () once sold. Presence is the record; the owner lives in
    /// the token itself, which is the only place that can be transferred.
    Sold(u32),
}

#[contract]
pub struct VeilMasquerade;

fn admin(e: &Env) -> Address {
    e.storage()
        .instance()
        .get(&DataKey::Admin)
        .unwrap_or_else(|| panic_with_error!(e, Error::NotInitialized))
}

fn instance_addr(e: &Env, key: DataKey) -> Address {
    e.storage()
        .instance()
        .get(&key)
        .unwrap_or_else(|| panic_with_error!(e, Error::NotInitialized))
}

/// Is `who` holding at least one Veil name?
///
/// The registry is an NFT contract, so this is its `balance`. Asking the
/// registry rather than keeping a list here means the answer cannot go stale:
/// a name sold a second ago is gone from the next call.
fn holds_a_name(e: &Env, who: &Address) -> bool {
    let registry = instance_addr(e, DataKey::Names);
    let held: u32 = e.invoke_contract(
        &registry,
        &Symbol::new(e, "balance"),
        vec![e, who.into_val(e)],
    );
    held > 0
}

fn validate_id(e: &Env, id: u32) {
    if id == 0 || id > COLLECTION_SIZE {
        panic_with_error!(e, Error::NoSuchFigure);
    }
}

/// `base_uri` + a two-digit id + `.json`.
///
/// Two digits, not however many the number needs, because the metadata files
/// are named `01.json`..`20.json` and a URI that does not match the file it
/// points at is a blank figure. Twenty fits in two digits; the assert below
/// is what stops that from silently stopping being true.
fn compose_uri(e: &Env, token_id: u32) -> String {
    const _: () = assert!(COLLECTION_SIZE < 100, "ids must fit two digits");
    const SUFFIX: &[u8] = b".json";

    let base = Base::base_uri(e);
    let base_len = base.len() as usize;
    if base_len == 0 {
        return String::from_str(e, "");
    }

    let buf = &mut [0u8; MAX_BASE_URI_LEN + 2 + SUFFIX.len()];
    base.copy_into_slice(&mut buf[..base_len]);
    buf[base_len] = b'0' + (token_id / 10) as u8;
    buf[base_len + 1] = b'0' + (token_id % 10) as u8;
    let end = base_len + 2 + SUFFIX.len();
    buf[base_len + 2..end].copy_from_slice(SUFFIX);

    String::from_bytes(e, &buf[..end])
}

#[contractimpl]
impl VeilMasquerade {
    /// Set the admin, the payment asset, the treasury, the names registry and
    /// the metadata base.
    pub fn initialize(
        e: Env,
        admin: Address,
        pay_token: Address,
        treasury: Address,
        names: Address,
        base_uri: String,
    ) {
        if e.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&e, Error::AlreadyInitialized);
        }
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::PayToken, &pay_token);
        e.storage().instance().set(&DataKey::Treasury, &treasury);
        e.storage().instance().set(&DataKey::Names, &names);

        Base::set_metadata(
            &e,
            base_uri,
            String::from_str(&e, "Veil Masquerade"),
            String::from_str(&e, "VMASQ"),
        );
    }

    /// Who currently holds the admin role.
    pub fn get_admin(e: Env) -> Address {
        admin(&e)
    }

    /// Replace this contract's WASM.
    ///
    /// The tokens live here, so a second deployment starts empty and cannot
    /// replace this one. Nothing checks that the incoming build keeps the
    /// storage layout; the replacement has to be built from this source.
    pub fn upgrade(e: Env, new_wasm_hash: BytesN<32>) {
        admin(&e).require_auth();
        e.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Hand the admin role to someone else — a multisig or a timelock.
    ///
    /// No way to renounce it to a burn address: that would freeze the metadata
    /// base and the upgrade path together, and a collection whose art can
    /// never be repointed is one bad pinning service away from being blank.
    pub fn set_admin(e: Env, new_admin: Address) {
        admin(&e).require_auth();
        e.storage().instance().set(&DataKey::Admin, &new_admin);
    }

    /// Repoint the metadata base, for when pinning moves.
    ///
    /// Writes the token metadata itself rather than a copy beside it: with two
    /// records of where the art lives, one of them eventually lies.
    pub fn set_base_uri(e: Env, base_uri: String) {
        admin(&e).require_auth();
        Base::set_metadata(&e, base_uri, Base::name(&e), Base::symbol(&e));
    }

    /// What a figure costs, in stroops of the payment asset.
    pub fn price(e: Env) -> i128 {
        let _ = &e;
        PRICE * UNIT
    }

    /// Has this figure been sold?
    pub fn is_sold(e: Env, token_id: u32) -> bool {
        validate_id(&e, token_id);
        e.storage().persistent().has(&DataKey::Sold(token_id))
    }

    /// Where this figure's metadata lives, sold or not.
    ///
    /// `token_uri` cannot answer this: the standard requires it to panic for a
    /// token nobody owns, and nineteen of twenty figures have no owner on the
    /// day the shop opens.
    pub fn figure_uri(e: Env, token_id: u32) -> String {
        validate_id(&e, token_id);
        compose_uri(&e, token_id)
    }

    /// Buy one figure.
    ///
    /// Takes payment and mints in the same transaction: either both happen or
    /// neither does, so there is no state where somebody has paid and holds
    /// nothing.
    pub fn buy(e: Env, buyer: Address, token_id: u32) -> u32 {
        buyer.require_auth();
        validate_id(&e, token_id);

        if e.storage().persistent().has(&DataKey::Sold(token_id)) {
            panic_with_error!(&e, Error::AlreadySold);
        }
        if !holds_a_name(&e, &buyer) {
            panic_with_error!(&e, Error::NeedsName);
        }

        let pay_token = instance_addr(&e, DataKey::PayToken);
        let treasury = instance_addr(&e, DataKey::Treasury);
        token::Client::new(&e, &pay_token).transfer(&buyer, &treasury, &(PRICE * UNIT));

        e.storage().persistent().set(&DataKey::Sold(token_id), &());
        e.storage().persistent().extend_ttl(
            &DataKey::Sold(token_id),
            TTL_THRESHOLD,
            TTL_EXTEND_TO,
        );

        Base::mint(&e, &buyer, token_id);

        e.events().publish(
            (symbol_short!("buy"), buyer.clone()),
            token_id,
        );
        token_id
    }
}

#[contractimpl]
impl NonFungibleToken for VeilMasquerade {
    type ContractType = Base;

    fn balance(e: &Env, account: Address) -> u32 {
        Base::balance(e, &account)
    }

    fn owner_of(e: &Env, token_id: u32) -> Address {
        Base::owner_of(e, token_id)
    }

    fn transfer(e: &Env, from: Address, to: Address, token_id: u32) {
        Base::transfer(e, &from, &to, token_id);
    }

    fn transfer_from(e: &Env, spender: Address, from: Address, to: Address, token_id: u32) {
        Base::transfer_from(e, &spender, &from, &to, token_id);
    }

    fn approve(
        e: &Env,
        approver: Address,
        approved: Address,
        token_id: u32,
        live_until_ledger: u32,
    ) {
        Base::approve(e, &approver, &approved, token_id, live_until_ledger);
    }

    fn approve_for_all(e: &Env, owner: Address, operator: Address, live_until_ledger: u32) {
        Base::approve_for_all(e, &owner, &operator, live_until_ledger);
    }

    fn get_approved(e: &Env, token_id: u32) -> Option<Address> {
        Base::get_approved(e, token_id)
    }

    fn is_approved_for_all(e: &Env, owner: Address, operator: Address) -> bool {
        Base::is_approved_for_all(e, &owner, &operator)
    }

    fn name(e: &Env) -> String {
        Base::name(e)
    }

    fn symbol(e: &Env) -> String {
        Base::symbol(e)
    }

    fn token_uri(e: &Env, token_id: u32) -> String {
        // Panics for an unowned token, which is the standard's reading. The
        // shop uses `figure_uri` instead.
        let _ = Base::owner_of(e, token_id);
        compose_uri(e, token_id)
    }
}

#[contractimpl]
impl NonFungibleBurnable for VeilMasquerade {
    fn burn(e: &Env, from: Address, token_id: u32) {
        Base::burn(e, &from, token_id);
    }

    fn burn_from(e: &Env, spender: Address, from: Address, token_id: u32) {
        Base::burn_from(e, &spender, &from, token_id);
    }
}

#[cfg(test)]
mod test;

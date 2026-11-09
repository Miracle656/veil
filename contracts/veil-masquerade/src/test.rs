#![cfg(test)]
//! Tests for the figure collection.
//!
//! The ones that matter are the promises a buyer cannot verify for themselves
//! at the moment of paying: that there are twenty and only twenty, that a
//! figure cannot be sold twice, and that the name gate is checked against the
//! registry rather than against anything this contract remembers.

extern crate std;

use soroban_sdk::{
    testutils::Address as _,
    token::StellarAssetClient,
    Address, BytesN, Env, String,
};

use crate::{
    Error, VeilMasquerade, VeilMasqueradeClient, COLLECTION_SIZE, PRICE, UNIT,
};

/// A stand-in for the names registry.
///
/// The real one is an NFT contract and the gate is its `balance`. Anything
/// exposing `balance(Address) -> u32` satisfies that, so the test registry is
/// the smallest thing that does — which also proves the gate depends on the
/// interface and not on the registry's internals.
mod registry {
    use soroban_sdk::{contract, contractimpl, Address, Env};

    #[contract]
    pub struct Registry;

    #[contractimpl]
    impl Registry {
        pub fn grant(e: Env, who: Address) {
            e.storage().persistent().set(&who, &1u32);
        }

        pub fn revoke(e: Env, who: Address) {
            e.storage().persistent().remove(&who);
        }

        pub fn balance(e: Env, account: Address) -> u32 {
            e.storage().persistent().get(&account).unwrap_or(0u32)
        }
    }
}

struct Fixture {
    e: Env,
    client: VeilMasqueradeClient<'static>,
    registry: registry::RegistryClient<'static>,
    usdc: Address,
    admin: Address,
    treasury: Address,
    alice: Address,
    bob: Address,
}

fn setup() -> Fixture {
    let e = Env::default();
    e.mock_all_auths();

    let admin = Address::generate(&e);
    let treasury = Address::generate(&e);
    let alice = Address::generate(&e);
    let bob = Address::generate(&e);

    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let usdc = sac.address();
    let minter = StellarAssetClient::new(&e, &usdc);
    minter.mint(&alice, &(1_000 * UNIT));
    minter.mint(&bob, &(1_000 * UNIT));

    let registry_id = e.register(registry::Registry, ());
    let registry = registry::RegistryClient::new(&e, &registry_id);

    let contract_id = e.register(VeilMasquerade, ());
    let client = VeilMasqueradeClient::new(&e, &contract_id);
    client.initialize(
        &admin,
        &usdc,
        &treasury,
        &registry_id,
        &String::from_str(&e, "ipfs://cid/"),
    );

    Fixture { e, client, registry, usdc, admin, treasury, alice, bob }
}

fn balance(f: &Fixture, who: &Address) -> i128 {
    soroban_sdk::token::Client::new(&f.e, &f.usdc).balance(who)
}

fn err(code: Error) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(code as u32)
}

// ───────────────────────── the name gate ─────────────────────────

#[test]
fn a_buyer_without_a_name_is_refused() {
    let f = setup();
    assert_eq!(
        f.client.try_buy(&f.alice, &1),
        Err(Ok(err(Error::NeedsName)))
    );
}

#[test]
fn a_refused_buyer_pays_nothing() {
    let f = setup();
    let before = balance(&f, &f.alice);
    let _ = f.client.try_buy(&f.alice, &1);
    assert_eq!(balance(&f, &f.alice), before);
    assert_eq!(balance(&f, &f.treasury), 0);
}

#[test]
fn holding_a_name_opens_the_sale() {
    let f = setup();
    f.registry.grant(&f.alice);
    assert_eq!(f.client.buy(&f.alice, &1), 1);
    assert_eq!(f.client.owner_of(&1), f.alice);
}

#[test]
fn selling_the_name_afterwards_does_not_take_the_figure() {
    // The gate is on buying, not on keeping. A token that could be clawed
    // back by a condition the holder no longer controls is not owned.
    let f = setup();
    f.registry.grant(&f.alice);
    f.client.buy(&f.alice, &1);

    f.registry.revoke(&f.alice);

    assert_eq!(f.client.owner_of(&1), f.alice);
    assert_eq!(f.client.balance(&f.alice), 1);
}

#[test]
fn the_gate_is_read_from_the_registry_every_time() {
    // Nothing here remembers who held a name. Granting one after a refusal
    // must be enough on the next call.
    let f = setup();
    assert!(f.client.try_buy(&f.alice, &1).is_err());

    f.registry.grant(&f.alice);
    assert_eq!(f.client.buy(&f.alice, &1), 1);
}

// ───────────────────────── scarcity ─────────────────────────

#[test]
fn there_are_exactly_twenty_figures() {
    let f = setup();
    f.registry.grant(&f.alice);

    assert_eq!(
        f.client.try_buy(&f.alice, &0),
        Err(Ok(err(Error::NoSuchFigure)))
    );
    assert_eq!(
        f.client.try_buy(&f.alice, &(COLLECTION_SIZE + 1)),
        Err(Ok(err(Error::NoSuchFigure)))
    );

    // The boundaries themselves are real.
    assert_eq!(f.client.buy(&f.alice, &1), 1);
    assert_eq!(f.client.buy(&f.alice, &COLLECTION_SIZE), COLLECTION_SIZE);
}

#[test]
fn the_whole_collection_can_be_bought_and_no_more() {
    let f = setup();
    f.registry.grant(&f.alice);

    for id in 1..=COLLECTION_SIZE {
        assert_eq!(f.client.buy(&f.alice, &id), id);
    }
    assert_eq!(f.client.balance(&f.alice), COLLECTION_SIZE);

    assert_eq!(
        f.client.try_buy(&f.alice, &(COLLECTION_SIZE + 1)),
        Err(Ok(err(Error::NoSuchFigure)))
    );
}

#[test]
fn a_figure_cannot_be_sold_twice() {
    let f = setup();
    f.registry.grant(&f.alice);
    f.registry.grant(&f.bob);

    f.client.buy(&f.alice, &7);
    assert_eq!(
        f.client.try_buy(&f.bob, &7),
        Err(Ok(err(Error::AlreadySold)))
    );
    assert_eq!(f.client.owner_of(&7), f.alice);
}

#[test]
fn a_second_buyer_of_a_sold_figure_pays_nothing() {
    let f = setup();
    f.registry.grant(&f.alice);
    f.registry.grant(&f.bob);
    f.client.buy(&f.alice, &7);

    let before = balance(&f, &f.bob);
    let _ = f.client.try_buy(&f.bob, &7);
    assert_eq!(balance(&f, &f.bob), before);
}

#[test]
fn burning_a_figure_does_not_put_it_back_on_sale() {
    // `Sold` is the record, not ownership. Otherwise a holder could burn a
    // figure to let somebody buy the same id again, and twenty would stop
    // meaning twenty.
    let f = setup();
    f.registry.grant(&f.alice);
    f.registry.grant(&f.bob);
    f.client.buy(&f.alice, &3);

    f.client.burn(&f.alice, &3);

    assert_eq!(
        f.client.try_buy(&f.bob, &3),
        Err(Ok(err(Error::AlreadySold)))
    );
}

// ───────────────────────── money ─────────────────────────

#[test]
fn buying_moves_the_price_to_the_treasury() {
    let f = setup();
    f.registry.grant(&f.alice);

    let before_buyer = balance(&f, &f.alice);
    let before_treasury = balance(&f, &f.treasury);

    f.client.buy(&f.alice, &2);

    assert_eq!(balance(&f, &f.alice), before_buyer - PRICE * UNIT);
    assert_eq!(balance(&f, &f.treasury), before_treasury + PRICE * UNIT);
}

#[test]
fn the_price_is_five_usdc() {
    let f = setup();
    assert_eq!(f.client.price(), 5 * UNIT);
}

// ───────────────────────── admin ─────────────────────────

#[test]
fn initialize_sets_the_admin_and_it_is_readable() {
    let f = setup();
    assert_eq!(f.client.get_admin(), f.admin);
}

#[test]
fn cannot_be_initialized_twice() {
    let f = setup();
    let other = Address::generate(&f.e);
    assert_eq!(
        f.client.try_initialize(
            &other,
            &f.usdc,
            &other,
            &other,
            &String::from_str(&f.e, "ipfs://other/")
        ),
        Err(Ok(err(Error::AlreadyInitialized)))
    );
}

#[test]
fn admin_can_hand_the_role_to_a_successor() {
    let f = setup();
    let successor = Address::generate(&f.e);
    f.client.set_admin(&successor);
    assert_eq!(f.client.get_admin(), successor);
}

#[test]
fn the_metadata_base_can_be_repointed() {
    // Pinning moves. A collection whose art 404s forever is worse than one
    // whose admin can point it somewhere new.
    let f = setup();
    f.client.set_base_uri(&String::from_str(&f.e, "ipfs://moved/"));
    assert_eq!(
        f.client.figure_uri(&1),
        String::from_str(&f.e, "ipfs://moved/01.json")
    );
}

#[test]
fn repointing_the_base_keeps_the_name_and_symbol() {
    // `set_base_uri` writes the whole metadata record, so getting this wrong
    // blanks the collection's name instead of moving its art.
    let f = setup();
    f.client.set_base_uri(&String::from_str(&f.e, "ipfs://moved/"));
    assert_eq!(f.client.name(), String::from_str(&f.e, "Veil Masquerade"));
    assert_eq!(f.client.symbol(), String::from_str(&f.e, "VMASQ"));
}

// ───────────────────────── metadata uris ─────────────────────────

#[test]
fn a_uri_is_two_digits_and_a_json_extension() {
    // The files are named 01.json..20.json. A URI of `ipfs://cid/1` points at
    // nothing, and a figure whose art 404s is the whole product broken.
    let f = setup();
    assert_eq!(
        f.client.figure_uri(&1),
        String::from_str(&f.e, "ipfs://cid/01.json")
    );
    assert_eq!(
        f.client.figure_uri(&9),
        String::from_str(&f.e, "ipfs://cid/09.json")
    );
    assert_eq!(
        f.client.figure_uri(&10),
        String::from_str(&f.e, "ipfs://cid/10.json")
    );
    assert_eq!(
        f.client.figure_uri(&20),
        String::from_str(&f.e, "ipfs://cid/20.json")
    );
}

#[test]
fn an_unsold_figure_still_has_a_uri() {
    // This is why `figure_uri` exists at all: on opening day nineteen of the
    // twenty have no owner, and the shop has to show them.
    let f = setup();
    assert!(!f.client.is_sold(&11));
    assert_eq!(
        f.client.figure_uri(&11),
        String::from_str(&f.e, "ipfs://cid/11.json")
    );
}

#[test]
fn figure_uri_refuses_an_id_outside_the_collection() {
    let f = setup();
    assert_eq!(
        f.client.try_figure_uri(&0),
        Err(Ok(err(Error::NoSuchFigure)))
    );
    assert_eq!(
        f.client.try_figure_uri(&(COLLECTION_SIZE + 1)),
        Err(Ok(err(Error::NoSuchFigure)))
    );
}

#[test]
fn token_uri_and_figure_uri_agree_for_a_sold_figure() {
    // Two entry points, one string. If they ever diverge, a marketplace and
    // our own shop show different art for the same token.
    let f = setup();
    f.registry.grant(&f.alice);
    f.client.buy(&f.alice, &6);
    assert_eq!(f.client.token_uri(&6), f.client.figure_uri(&6));
}

#[test]
fn token_uri_refuses_an_unsold_figure() {
    let f = setup();
    assert!(f.client.try_token_uri(&6).is_err());
}

#[test]
fn admin_calls_need_the_admin_signature() {
    let f = setup();
    let attacker = Address::generate(&f.e);

    // `setup` mocks all auths, which would make these vacuous.
    f.e.set_auths(&[]);
    assert!(f.client.try_set_admin(&attacker).is_err());

    f.e.set_auths(&[]);
    assert!(f
        .client
        .try_set_base_uri(&String::from_str(&f.e, "ipfs://evil/"))
        .is_err());

    f.e.set_auths(&[]);
    assert!(f
        .client
        .try_upgrade(&BytesN::from_array(&f.e, &[0u8; 32]))
        .is_err());

    f.e.mock_all_auths();
    assert_eq!(f.client.get_admin(), f.admin);
}

#[test]
fn buying_needs_the_buyer_signature() {
    let f = setup();
    f.registry.grant(&f.alice);

    f.e.set_auths(&[]);
    assert!(f.client.try_buy(&f.alice, &1).is_err());

    f.e.mock_all_auths();
    assert!(!f.client.is_sold(&1));
}

// ───────────────────────── reads ─────────────────────────

#[test]
fn is_sold_tracks_the_sale() {
    let f = setup();
    f.registry.grant(&f.alice);

    assert!(!f.client.is_sold(&4));
    f.client.buy(&f.alice, &4);
    assert!(f.client.is_sold(&4));
}

#[test]
fn is_sold_refuses_an_id_outside_the_collection() {
    let f = setup();
    assert_eq!(
        f.client.try_is_sold(&(COLLECTION_SIZE + 1)),
        Err(Ok(err(Error::NoSuchFigure)))
    );
}

#[test]
fn a_figure_can_be_transferred_on() {
    let f = setup();
    f.registry.grant(&f.alice);
    f.client.buy(&f.alice, &5);

    // Bob holds no name, which does not stop him receiving one: the gate is
    // on buying from the collection, not on holding a figure.
    f.client.transfer(&f.alice, &f.bob, &5);
    assert_eq!(f.client.owner_of(&5), f.bob);
}

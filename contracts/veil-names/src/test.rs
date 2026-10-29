#![cfg(test)]
//! Tests for the name registry.
//!
//! The ones that matter most are not the happy path. They are the boundaries
//! around a lapsed name: the instant resolution stops, who may take the name
//! back during the recovery window, and that a stranger cannot before it ends.
//! That window is the only thing standing between rental and a contact list
//! that quietly starts paying somebody else.

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, String,
};

use crate::{
    Error, NameState, VeilNames, VeilNamesClient, MAX_TERM_YEARS, RECOVERY_SECONDS, UNIT,
    YEAR_SECONDS,
};

struct Fixture {
    e: Env,
    client: VeilNamesClient<'static>,
    usdc: Address,
    treasury: Address,
    alice: Address,
    bob: Address,
}

fn setup() -> Fixture {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().with_mut(|l| l.timestamp = 1_700_000_000);

    let admin = Address::generate(&e);
    let treasury = Address::generate(&e);
    let alice = Address::generate(&e);
    let bob = Address::generate(&e);

    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    let usdc = sac.address();
    let minter = StellarAssetClient::new(&e, &usdc);
    minter.mint(&alice, &(1_000 * UNIT));
    minter.mint(&bob, &(1_000 * UNIT));

    let contract_id = e.register(VeilNames, ());
    let client = VeilNamesClient::new(&e, &contract_id);
    client.initialize(&admin, &usdc, &treasury);

    Fixture { e, client, usdc, treasury, alice, bob }
}

fn name(e: &Env, s: &str) -> String {
    String::from_str(e, s)
}

fn balance(f: &Fixture, who: &Address) -> i128 {
    soroban_sdk::token::Client::new(&f.e, &f.usdc).balance(who)
}

fn warp(f: &Fixture, to: u64) {
    f.e.ledger().with_mut(|l| l.timestamp = to);
}

// ───────────────────────── pricing ─────────────────────────

#[test]
fn prices_by_length_band() {
    let f = setup();
    assert_eq!(f.client.quote(&name(&f.e, "ada"), &1), 3 * UNIT);
    assert_eq!(f.client.quote(&name(&f.e, "adebayo"), &1), 5 * UNIT);
    assert_eq!(f.client.quote(&name(&f.e, "adebayoakinola"), &1), 2 * UNIT);
}

#[test]
fn multiplies_the_rate_by_the_term() {
    let f = setup();
    assert_eq!(f.client.quote(&name(&f.e, "adebayo"), &3), 15 * UNIT);
    assert_eq!(f.client.quote(&name(&f.e, "ada"), &5), 15 * UNIT);
}

#[test]
fn keeps_the_middle_band_dearest() {
    // Demand pricing, not scarcity pricing, and deliberate. If this ever
    // descends, the product decision was reversed and somebody should say so.
    let f = setup();
    let short = f.client.quote(&name(&f.e, "ada"), &1);
    let mid = f.client.quote(&name(&f.e, "adebayo"), &1);
    let long = f.client.quote(&name(&f.e, "adebayoakinola"), &1);
    assert!(mid > short);
    assert!(mid > long);
    assert!(long < short);
}

// ───────────────────────── validation ─────────────────────────

#[test]
fn rejects_a_name_outside_the_length_bounds() {
    let f = setup();
    assert_eq!(
        f.client.try_register(&f.alice, &name(&f.e, "ab"), &1),
        Err(Ok(Error::NameTooShort))
    );
    assert_eq!(
        f.client
            .try_register(&f.alice, &name(&f.e, "abcdefghijklmnopqrstu"), &1),
        Err(Ok(Error::NameTooLong))
    );
}

#[test]
fn rejects_everything_outside_lowercase_digits_and_underscore() {
    let f = setup();
    for bad in ["Ada", "ja-ck", "ja ck", "jack!", "ja.ck"] {
        assert_eq!(
            f.client.try_register(&f.alice, &name(&f.e, bad), &1),
            Err(Ok(Error::BadCharset)),
            "expected {bad} to be refused"
        );
    }
}

#[test]
fn rejects_a_cyrillic_homoglyph_rather_than_folding_it() {
    // "jаck" with U+0430 reads as "jack". A name is a payment destination, so
    // a lookalike is a redirect and not a typo.
    let f = setup();
    assert_eq!(
        f.client.try_register(&f.alice, &name(&f.e, "j\u{0430}ck"), &1),
        Err(Ok(Error::BadCharset))
    );
}

#[test]
fn rejects_a_leading_trailing_or_doubled_underscore() {
    let f = setup();
    for bad in ["_jack", "jack_", "ja__ck"] {
        assert_eq!(
            f.client.try_register(&f.alice, &name(&f.e, bad), &1),
            Err(Ok(Error::BadSeparator)),
            "expected {bad} to be refused"
        );
    }
}

#[test]
fn allows_an_interior_underscore() {
    let f = setup();
    f.client.register(&f.alice, &name(&f.e, "jack_ng"), &1);
    assert_eq!(
        f.client.resolve(&name(&f.e, "jack_ng")),
        Some(f.alice.clone())
    );
}

#[test]
fn refuses_a_reserved_name_and_its_underscored_disguise() {
    let f = setup();
    f.client.reserve(&name(&f.e, "support"));

    assert_eq!(
        f.client.try_register(&f.alice, &name(&f.e, "support"), &1),
        Err(Ok(Error::Reserved))
    );
    // Without stripping, `s_u_p_p_o_r_t` is a 13-character name at the cheapest
    // tier that reads as support in every screen that renders it.
    assert_eq!(
        f.client
            .try_register(&f.alice, &name(&f.e, "s_u_p_p_o_r_t"), &1),
        Err(Ok(Error::Reserved))
    );
}

#[test]
fn rejects_a_term_outside_one_to_five_years() {
    let f = setup();
    assert_eq!(
        f.client.try_register(&f.alice, &name(&f.e, "adebayo"), &0),
        Err(Ok(Error::BadTerm))
    );
    assert_eq!(
        f.client
            .try_register(&f.alice, &name(&f.e, "adebayo"), &(MAX_TERM_YEARS + 1)),
        Err(Ok(Error::BadTerm))
    );
}

// ───────────────────────── registering ─────────────────────────

#[test]
fn registering_takes_payment_and_issues_the_name() {
    let f = setup();
    let before = balance(&f, &f.alice);

    let token_id = f.client.register(&f.alice, &name(&f.e, "adebayo"), &2);

    // Payment and issuance are one invocation: both happened, or neither.
    assert_eq!(balance(&f, &f.alice), before - 10 * UNIT);
    assert_eq!(balance(&f, &f.treasury), 10 * UNIT);
    assert_eq!(f.client.owner_of(&token_id), f.alice);
    assert_eq!(
        f.client.resolve(&name(&f.e, "adebayo")),
        Some(f.alice.clone())
    );
    assert_eq!(f.client.balance(&f.alice), 1);
}

#[test]
fn an_active_name_cannot_be_taken() {
    let f = setup();
    f.client.register(&f.alice, &name(&f.e, "adebayo"), &1);
    assert_eq!(
        f.client.try_register(&f.bob, &name(&f.e, "adebayo"), &1),
        Err(Ok(Error::NameTaken))
    );
}

#[test]
fn a_failed_registration_takes_no_money() {
    let f = setup();
    f.client.register(&f.alice, &name(&f.e, "adebayo"), &1);
    let before = balance(&f, &f.bob);
    let _ = f.client.try_register(&f.bob, &name(&f.e, "adebayo"), &1);
    assert_eq!(balance(&f, &f.bob), before);
}

// ───────────────────────── expiry ─────────────────────────

#[test]
fn resolution_stops_at_the_exact_instant_of_expiry() {
    let f = setup();
    let start = f.e.ledger().timestamp();
    f.client.register(&f.alice, &name(&f.e, "adebayo"), &1);
    let expiry = start + YEAR_SECONDS;

    warp(&f, expiry - 1);
    assert_eq!(
        f.client.resolve(&name(&f.e, "adebayo")),
        Some(f.alice.clone())
    );

    // No grace. A name that still resolves after its term is a name whose
    // holder believes it is working.
    warp(&f, expiry);
    assert_eq!(f.client.resolve(&name(&f.e, "adebayo")), None);
}

#[test]
fn never_resolves_again_once_expired() {
    let f = setup();
    let start = f.e.ledger().timestamp();
    f.client.register(&f.alice, &name(&f.e, "adebayo"), &1);
    let expiry = start + YEAR_SECONDS;

    for t in [expiry, expiry + 1, expiry + RECOVERY_SECONDS, expiry + 10 * YEAR_SECONDS] {
        warp(&f, t);
        assert_eq!(f.client.resolve(&name(&f.e, "adebayo")), None);
    }
}

#[test]
fn walks_through_active_recovery_and_open() {
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);
    let expiry = start + YEAR_SECONDS;

    assert_eq!(f.client.state(&n), NameState::Active);
    warp(&f, expiry);
    assert_eq!(f.client.state(&n), NameState::Recovery);
    warp(&f, expiry + RECOVERY_SECONDS - 1);
    assert_eq!(f.client.state(&n), NameState::Recovery);
    warp(&f, expiry + RECOVERY_SECONDS);
    assert_eq!(f.client.state(&n), NameState::Open);
}

#[test]
fn an_unregistered_name_is_open() {
    let f = setup();
    assert_eq!(f.client.state(&name(&f.e, "nobodyhasthis")), NameState::Open);
}

// ───────────────────────── the recovery window ─────────────────────────

#[test]
fn a_stranger_cannot_take_a_name_during_recovery() {
    // The whole point of the window. Every stale contact fails for a full
    // quarter before anyone else can possibly be behind that name.
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);
    let expiry = start + YEAR_SECONDS;

    for offset in [0, 1, RECOVERY_SECONDS / 2, RECOVERY_SECONDS - 1] {
        warp(&f, expiry + offset);
        assert_eq!(
            f.client.try_register(&f.bob, &n, &1),
            Err(Ok(Error::InRecovery)),
            "bob took the name {offset}s into recovery"
        );
    }
}

#[test]
fn the_previous_holder_can_take_their_name_back_during_recovery() {
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    let first = f.client.register(&f.alice, &n, &1);
    let expiry = start + YEAR_SECONDS;

    warp(&f, expiry + RECOVERY_SECONDS / 2);
    let second = f.client.register(&f.alice, &n, &1);

    assert_ne!(first, second, "a re-registration must mint a new token id");
    assert_eq!(f.client.resolve(&n), Some(f.alice.clone()));
}

#[test]
fn anyone_can_take_the_name_once_the_window_closes() {
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);

    warp(&f, start + YEAR_SECONDS + RECOVERY_SECONDS);
    f.client.register(&f.bob, &n, &1);
    assert_eq!(f.client.resolve(&n), Some(f.bob.clone()));
}

// ───────────────────────── burn and re-mint ─────────────────────────

#[test]
fn re_registration_burns_the_old_token_and_mints_a_new_one() {
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    let old = f.client.register(&f.alice, &n, &1);

    warp(&f, start + YEAR_SECONDS + RECOVERY_SECONDS);
    let new = f.client.register(&f.bob, &n, &1);

    assert_ne!(old, new);
    assert_eq!(f.client.owner_of(&new), f.bob);
    // Alice's token is gone, not merely re-pointed: a new registration is not
    // the same collectible changing hands.
    assert_eq!(f.client.balance(&f.alice), 0);
    assert_eq!(f.client.balance(&f.bob), 1);
    assert!(f.client.try_owner_of(&old).is_err());
}

#[test]
fn transferring_the_token_moves_where_the_name_points() {
    let f = setup();
    let n = name(&f.e, "adebayo");
    let token_id = f.client.register(&f.alice, &n, &1);

    f.client.transfer(&f.alice, &f.bob, &token_id);
    assert_eq!(f.client.owner_of(&token_id), f.bob);
}

// ───────────────────────── renewal ─────────────────────────

#[test]
fn renewing_early_extends_from_the_existing_expiry() {
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);

    // Sixty days before it runs out: the time already paid for is not lost.
    warp(&f, start + YEAR_SECONDS - 60 * 24 * 60 * 60);
    f.client.renew(&f.alice, &n, &1);
    assert_eq!(f.client.expires_at(&n), Some(start + 2 * YEAR_SECONDS));
}

#[test]
fn renewing_in_recovery_extends_from_now() {
    // Dating a new term from a past expiry would sell back time already spent.
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);

    let now = start + YEAR_SECONDS + 30 * 24 * 60 * 60;
    warp(&f, now);
    f.client.renew(&f.alice, &n, &1);
    assert_eq!(f.client.expires_at(&n), Some(now + YEAR_SECONDS));
    assert_eq!(f.client.resolve(&n), Some(f.alice.clone()));
}

#[test]
fn anyone_may_pay_to_renew_somebody_elses_name() {
    // Renewal only extends a name for its current holder — it cannot move it,
    // re-point it or take it — so the worst a stranger can do is pay the bill.
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);

    let bob_before = balance(&f, &f.bob);
    f.client.renew(&f.bob, &n, &1);

    assert_eq!(balance(&f, &f.bob), bob_before - 5 * UNIT);
    assert_eq!(f.client.expires_at(&n), Some(start + 2 * YEAR_SECONDS));
    // Paying did not buy Bob anything but goodwill.
    assert_eq!(f.client.resolve(&n), Some(f.alice.clone()));
}

#[test]
fn a_renewal_cannot_push_the_term_past_the_maximum() {
    let f = setup();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &5);
    assert_eq!(
        f.client.try_renew(&f.alice, &n, &1),
        Err(Ok(Error::TermTooLong))
    );
}

#[test]
fn a_name_past_recovery_cannot_be_renewed() {
    // It is simply gone; renewing would hand it back to someone with no claim.
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);

    warp(&f, start + YEAR_SECONDS + RECOVERY_SECONDS);
    assert_eq!(
        f.client.try_renew(&f.alice, &n, &1),
        Err(Ok(Error::NameNotFound))
    );
}

#[test]
fn an_unregistered_name_cannot_be_renewed() {
    let f = setup();
    assert_eq!(
        f.client.try_renew(&f.alice, &name(&f.e, "nobodyhasthis"), &1),
        Err(Ok(Error::NameNotFound))
    );
}

// ───────────────────────── re-targeting ─────────────────────────

#[test]
fn the_holder_can_point_a_name_at_another_address() {
    let f = setup();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);

    f.client.set_target(&n, &f.bob);
    assert_eq!(f.client.resolve(&n), Some(f.bob.clone()));
}

#[test]
fn an_expired_name_cannot_be_re_targeted() {
    let f = setup();
    let start = f.e.ledger().timestamp();
    let n = name(&f.e, "adebayo");
    f.client.register(&f.alice, &n, &1);

    warp(&f, start + YEAR_SECONDS);
    assert_eq!(
        f.client.try_set_target(&n, &f.bob),
        Err(Ok(Error::NameNotFound))
    );
}

// ───────────────────────── setup ─────────────────────────

#[test]
fn cannot_be_initialized_twice() {
    let f = setup();
    let other = Address::generate(&f.e);
    assert_eq!(
        f.client.try_initialize(&other, &f.usdc, &other),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#![cfg(test)]

extern crate std;

use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events as _},
    token, Address, Bytes, BytesN, Env, IntoVal, Symbol,
};

use crate::{StealthAnnouncer, StealthAnnouncerClient, ANNOUNCEMENT_VERSION};

#[test]
fn publishes_versioned_announcement_with_filterable_view_tag() {
    let env = Env::default();
    let contract_id = env.register(StealthAnnouncer, ());
    let client = StealthAnnouncerClient::new(&env, &contract_id);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    let token_client = token::Client::new(&env, &token_address);
    let ephemeral_public_key = BytesN::from_array(&env, &[7; 32]);
    let view_tag = BytesN::from_array(&env, &[42]);
    let sealed_note = Bytes::from_slice(&env, &[1, 2, 3]);

    assert_eq!(token_client.balance(&contract_id), 0);
    client.announce(&ephemeral_public_key, &view_tag, &sealed_note);

    // The test host exposes the events of the most recent invocation, so read
    // them immediately after `announce` rather than after another contract call.
    let events = env.events().all();
    assert_eq!(events.len(), 1);
    let event = events.get(0).unwrap();

    assert_eq!(event.1.len(), 2);
    let topic_name: Symbol = event.1.get(0).unwrap().into_val(&env);
    let topic_view_tag: BytesN<1> = event.1.get(1).unwrap().into_val(&env);
    assert_eq!(topic_name, symbol_short!("announce"));
    assert_eq!(topic_view_tag, view_tag);

    let data: (u32, BytesN<32>, Bytes) = event.2.into_val(&env);
    assert_eq!(
        data,
        (ANNOUNCEMENT_VERSION, ephemeral_public_key, sealed_note)
    );

    // The announcer only announces: it never takes custody of funds.
    assert_eq!(token_client.balance(&contract_id), 0);
}

#![cfg(test)]

extern crate std;

use soroban_sdk::{
    testutils::{storage::Persistent as _, Address as _, Events as _, Ledger as _},
    token,
    Address, Env, Symbol, TryFromVal, Vec,
};

use crate::{
    DataKey, MultisigContract, MultisigContractClient, MultisigError,
    PROPOSAL_TTL_EXTEND_TO, PROPOSAL_TTL_THRESHOLD,
};

/// Helper to wrap MultisigError into soroban_sdk::Error for matching against try_* calls.
fn err(code: MultisigError) -> soroban_sdk::Error {
    soroban_sdk::Error::from_contract_error(code as u32)
}

struct Fixture {
    env: Env,
    contract_id: Address,
    client: MultisigContractClient<'static>,
    owner1: Address,
    owner2: Address,
    owner3: Address,
    token: Address,
    token_client: token::Client<'static>,
    sac_client: token::StellarAssetClient<'static>,
}

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(MultisigContract, ());
    let client = MultisigContractClient::new(&env, &contract_id);

    let owner1 = Address::generate(&env);
    let owner2 = Address::generate(&env);
    let owner3 = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let token_client = token::Client::new(&env, &token);
    let sac_client = token::StellarAssetClient::new(&env, &token);

    Fixture {
        env,
        contract_id,
        client,
        owner1,
        owner2,
        owner3,
        token,
        token_client,
        sac_client,
    }
}

fn init_fixture(f: &Fixture, threshold: u32) {
    let mut owners = Vec::new(&f.env);
    owners.push_back(f.owner1.clone());
    owners.push_back(f.owner2.clone());
    owners.push_back(f.owner3.clone());
    f.client.initialize(&owners, &threshold, &f.token);
}

// ── 1. Happy path flow ────────────────────────────────────────────────────────

#[test]
fn test_multisig_flow() {
    let f = setup();
    init_fixture(&f, 2);

    // Fund the multisig wallet
    f.sac_client.mint(&f.contract_id, &1000);

    assert_eq!(f.client.get_threshold(), 2);
    assert_eq!(f.client.get_owners().len(), 3);

    let to = Address::generate(&f.env);
    let prop_id = f.client.propose_transaction(&f.owner1, &to, &100);
    assert_eq!(prop_id, 1);

    let proposal = f.client.get_proposal(&1);
    assert_eq!(proposal.executed, false);
    assert_eq!(proposal.approvals.len(), 0);

    f.client.sign_transaction(&1, &f.owner1);
    let proposal = f.client.get_proposal(&1);
    assert_eq!(proposal.approvals.len(), 1);
    assert_eq!(proposal.executed, false);

    f.client.sign_transaction(&1, &f.owner2);
    let proposal = f.client.get_proposal(&1);
    assert_eq!(proposal.approvals.len(), 2);
    assert_eq!(proposal.executed, true);

    // Check that the transfer actually happened
    assert_eq!(f.token_client.balance(&to), 100);
    assert_eq!(f.token_client.balance(&f.contract_id), 900);
}

// ── 2. Ownership & Authorization checks ──────────────────────────────────────

#[test]
fn test_non_owner_cannot_propose() {
    let f = setup();
    init_fixture(&f, 2);

    let stranger = Address::generate(&f.env);
    let to = Address::generate(&f.env);

    assert_eq!(
        f.client.try_propose_transaction(&stranger, &to, &100),
        Err(Ok(err(MultisigError::NotAnOwner)))
    );
}

#[test]
fn test_non_owner_cannot_sign() {
    let f = setup();
    init_fixture(&f, 2);

    let to = Address::generate(&f.env);
    let prop_id = f.client.propose_transaction(&f.owner1, &to, &100);

    let stranger = Address::generate(&f.env);
    assert_eq!(
        f.client.try_sign_transaction(&prop_id, &stranger),
        Err(Ok(err(MultisigError::NotAnOwner)))
    );
}

// ── 3. Signing semantics ─────────────────────────────────────────────────────

#[test]
fn test_signing_twice_counts_once() {
    let f = setup();
    init_fixture(&f, 2);

    let to = Address::generate(&f.env);
    let prop_id = f.client.propose_transaction(&f.owner1, &to, &100);

    // First sign
    f.client.sign_transaction(&prop_id, &f.owner1);
    let proposal = f.client.get_proposal(&prop_id);
    assert_eq!(proposal.approvals.len(), 1);
    assert_eq!(proposal.approvals.get(0).unwrap(), f.owner1);

    // Second sign by same owner: succeeds without error, but approval count stays 1
    f.client.sign_transaction(&prop_id, &f.owner1);
    let proposal_after = f.client.get_proposal(&prop_id);
    assert_eq!(proposal_after.approvals.len(), 1);
    assert_eq!(proposal_after.executed, false);
}

#[test]
fn test_signing_executed_proposal_fails() {
    let f = setup();
    init_fixture(&f, 2);
    f.sac_client.mint(&f.contract_id, &1000);

    let to = Address::generate(&f.env);
    let prop_id = f.client.propose_transaction(&f.owner1, &to, &100);

    f.client.sign_transaction(&prop_id, &f.owner1);
    f.client.sign_transaction(&prop_id, &f.owner2);

    let proposal = f.client.get_proposal(&prop_id);
    assert_eq!(proposal.executed, true);

    // Signing an executed proposal must fail with ProposalAlreadyExecuted
    assert_eq!(
        f.client.try_sign_transaction(&prop_id, &f.owner3),
        Err(Ok(err(MultisigError::ProposalAlreadyExecuted)))
    );
    assert_eq!(
        f.client.try_sign_transaction(&prop_id, &f.owner1),
        Err(Ok(err(MultisigError::ProposalAlreadyExecuted)))
    );
}

// ── 4. Initialization boundary checks ────────────────────────────────────────

#[test]
fn test_threshold_zero_fails() {
    let f = setup();
    let mut owners = Vec::new(&f.env);
    owners.push_back(f.owner1.clone());

    assert_eq!(
        f.client.try_initialize(&owners, &0, &f.token),
        Err(Ok(err(MultisigError::ThresholdZero)))
    );
}

#[test]
fn test_threshold_above_owner_count_fails() {
    let f = setup();
    let mut owners = Vec::new(&f.env);
    owners.push_back(f.owner1.clone());
    owners.push_back(f.owner2.clone());

    assert_eq!(
        f.client.try_initialize(&owners, &3, &f.token),
        Err(Ok(err(MultisigError::ThresholdTooHigh)))
    );
}

#[test]
fn test_initialize_cannot_run_twice() {
    let f = setup();
    init_fixture(&f, 2);

    let mut owners = Vec::new(&f.env);
    owners.push_back(f.owner1.clone());

    assert_eq!(
        f.client.try_initialize(&owners, &1, &f.token),
        Err(Ok(err(MultisigError::AlreadyInitialized)))
    );
}

#[test]
fn test_reject_duplicate_owners() {
    let f = setup();
    let mut owners = Vec::new(&f.env);
    owners.push_back(f.owner1.clone());
    owners.push_back(f.owner2.clone());
    owners.push_back(f.owner1.clone()); // duplicate

    assert_eq!(
        f.client.try_initialize(&owners, &2, &f.token),
        Err(Ok(err(MultisigError::DuplicateOwners)))
    );

    let mut two_same = Vec::new(&f.env);
    two_same.push_back(f.owner1.clone());
    two_same.push_back(f.owner1.clone());

    assert_eq!(
        f.client.try_initialize(&two_same, &2, &f.token),
        Err(Ok(err(MultisigError::DuplicateOwners)))
    );
}

// ── 5. Input validation on proposals ─────────────────────────────────────────

#[test]
fn test_reject_zero_and_negative_amounts() {
    let f = setup();
    init_fixture(&f, 2);

    let to = Address::generate(&f.env);

    assert_eq!(
        f.client.try_propose_transaction(&f.owner1, &to, &0),
        Err(Ok(err(MultisigError::InvalidAmount)))
    );
    assert_eq!(
        f.client.try_propose_transaction(&f.owner1, &to, &-1),
        Err(Ok(err(MultisigError::InvalidAmount)))
    );
    assert_eq!(
        f.client.try_propose_transaction(&f.owner1, &to, &-1000),
        Err(Ok(err(MultisigError::InvalidAmount)))
    );
}

#[test]
fn test_unknown_proposal_id_fails() {
    let f = setup();
    init_fixture(&f, 2);

    assert_eq!(
        f.client.try_get_proposal(&999),
        Err(Ok(err(MultisigError::ProposalNotFound)))
    );
    assert_eq!(
        f.client.try_sign_transaction(&999, &f.owner1),
        Err(Ok(err(MultisigError::ProposalNotFound)))
    );
}

#[test]
fn test_proposal_ids_count_up_from_one() {
    let f = setup();
    init_fixture(&f, 2);

    let to = Address::generate(&f.env);
    let id1 = f.client.propose_transaction(&f.owner1, &to, &10);
    assert_eq!(id1, 1);
    assert_eq!(f.client.get_proposal_count(), 1);

    let id2 = f.client.propose_transaction(&f.owner2, &to, &20);
    assert_eq!(id2, 2);
    assert_eq!(f.client.get_proposal_count(), 2);

    let id3 = f.client.propose_transaction(&f.owner3, &to, &30);
    assert_eq!(id3, 3);
    assert_eq!(f.client.get_proposal_count(), 3);
}

// ── 6. Unfunded transfer & late execution ─────────────────────────────────────

#[test]
fn test_insufficient_funds_fails_and_leaves_proposal_unexecuted_until_funded() {
    let f = setup();
    init_fixture(&f, 2);

    // Multisig has 0 tokens balance
    assert_eq!(f.token_client.balance(&f.contract_id), 0);

    let to = Address::generate(&f.env);
    let prop_id = f.client.propose_transaction(&f.owner1, &to, &500);

    // First signer approves (approvals = 1 < threshold 2)
    f.client.sign_transaction(&prop_id, &f.owner1);
    let prop = f.client.get_proposal(&prop_id);
    assert_eq!(prop.approvals.len(), 1);
    assert_eq!(prop.executed, false);

    // Second signer attempts to approve (meets threshold 2, triggers transfer)
    // Transfer fails due to insufficient balance, causing the transaction to fail.
    let res = f.client.try_sign_transaction(&prop_id, &f.owner2);
    assert!(res.is_err(), "transfer should fail when wallet cannot afford it");

    // The whole invocation reverted, so the proposal remains unexecuted in storage,
    // and owner2's approval was rolled back with the revert.
    let prop_after_fail = f.client.get_proposal(&prop_id);
    assert_eq!(prop_after_fail.executed, false);
    assert_eq!(prop_after_fail.approvals.len(), 1);

    // Now fund the multisig contract
    f.sac_client.mint(&f.contract_id, &1000);

    // Sign again with owner2 — this time it succeeds and executes
    f.client.sign_transaction(&prop_id, &f.owner2);
    let prop_executed = f.client.get_proposal(&prop_id);
    assert_eq!(prop_executed.executed, true);
    assert_eq!(prop_executed.approvals.len(), 2);
    assert_eq!(f.token_client.balance(&to), 500);
    assert_eq!(f.token_client.balance(&f.contract_id), 500);
}

// ── 7. Events published with expected data ───────────────────────────────────

#[test]
fn test_three_events_published_with_right_data() {
    let f = setup();
    init_fixture(&f, 2);
    f.sac_client.mint(&f.contract_id, &1000);

    let to = Address::generate(&f.env);
    let amount: i128 = 250;

    // 1. Propose event
    let prop_id = f.client.propose_transaction(&f.owner1, &to, &amount);
    let events = f.env.events().all();
    let propose_event = events.last().unwrap();
    assert_eq!(propose_event.0, f.contract_id);
    assert_eq!(propose_event.1.len(), 2);
    let topic0 = Symbol::try_from_val(&f.env, &propose_event.1.get(0).unwrap()).unwrap();
    let topic1 = u64::try_from_val(&f.env, &propose_event.1.get(1).unwrap()).unwrap();
    assert_eq!(topic0, Symbol::new(&f.env, "propose"));
    assert_eq!(topic1, prop_id);
    let propose_data: (Address, Address, i128) =
        TryFromVal::try_from_val(&f.env, &propose_event.2).unwrap();
    assert_eq!(propose_data, (f.owner1.clone(), to.clone(), amount));

    // 2. Approve event
    f.client.sign_transaction(&prop_id, &f.owner1);
    let events = f.env.events().all();
    let approve_event = events.last().unwrap();
    assert_eq!(approve_event.0, f.contract_id);
    assert_eq!(approve_event.1.len(), 2);
    let topic0 = Symbol::try_from_val(&f.env, &approve_event.1.get(0).unwrap()).unwrap();
    let topic1 = u64::try_from_val(&f.env, &approve_event.1.get(1).unwrap()).unwrap();
    assert_eq!(topic0, Symbol::new(&f.env, "approve"));
    assert_eq!(topic1, prop_id);
    let approve_data: (Address, u32) =
        TryFromVal::try_from_val(&f.env, &approve_event.2).unwrap();
    assert_eq!(approve_data, (f.owner1.clone(), 1u32));

    // 3. Execute event (along with second approve event and token transfer event)
    f.client.sign_transaction(&prop_id, &f.owner2);
    let events = f.env.events().all();

    // Find the execute event emitted by our multisig contract
    let execute_event = events
        .iter()
        .find(|e| {
            if e.0 != f.contract_id || e.1.len() != 2 {
                return false;
            }
            let t0 = Symbol::try_from_val(&f.env, &e.1.get(0).unwrap()).ok();
            let t1 = u64::try_from_val(&f.env, &e.1.get(1).unwrap()).ok();
            t0 == Some(Symbol::new(&f.env, "execute")) && t1 == Some(prop_id)
        })
        .expect("execute event must be published");

    let execute_data: (Address, i128) =
        TryFromVal::try_from_val(&f.env, &execute_event.2).unwrap();
    assert_eq!(execute_data, (to.clone(), amount));
}

// ── 8. Not initialized checks ────────────────────────────────────────────────

#[test]
fn test_uninitialized_calls_fail() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigContract, ());
    let client = MultisigContractClient::new(&env, &contract_id);

    let dummy = Address::generate(&env);

    assert_eq!(
        client.try_get_owners(),
        Err(Ok(err(MultisigError::NotInitialized)))
    );
    assert_eq!(
        client.try_get_threshold(),
        Err(Ok(err(MultisigError::NotInitialized)))
    );
    assert_eq!(
        client.try_propose_transaction(&dummy, &dummy, &100),
        Err(Ok(err(MultisigError::NotInitialized)))
    );
    assert_eq!(
        client.try_sign_transaction(&1, &dummy),
        Err(Ok(err(MultisigError::NotInitialized)))
    );
}

// ── 9. Persistent storage and TTL extension ──────────────────────────────────

#[test]
fn test_proposals_stored_in_persistent_storage_with_ttl_extension() {
    let f = setup();
    init_fixture(&f, 2);

    let to = Address::generate(&f.env);
    let prop_id = f.client.propose_transaction(&f.owner1, &to, &100);

    // Verify storage durability and TTL
    f.env.as_contract(&f.contract_id, || {
        let key = DataKey::Proposal(prop_id);
        // Stored in persistent storage, NOT in instance storage
        assert!(f.env.storage().persistent().has(&key));
        assert!(!f.env.storage().instance().has(&key));

        assert_eq!(
            f.env.storage().persistent().get_ttl(&key),
            PROPOSAL_TTL_EXTEND_TO
        );
    });

    // Advance ledger sequence to approach the threshold
    f.env.ledger().with_mut(|l| {
        l.max_entry_ttl = PROPOSAL_TTL_EXTEND_TO * 3;
    });
    f.env.as_contract(&f.contract_id, || {
        let ttl = PROPOSAL_TTL_EXTEND_TO * 2;
        f.env.storage().instance().extend_ttl(ttl, ttl);
    });

    // Advance sequence number
    f.env.ledger().with_mut(|l| {
        l.sequence_number += PROPOSAL_TTL_EXTEND_TO - PROPOSAL_TTL_THRESHOLD + 100;
    });

    // Reading proposal extends TTL back to PROPOSAL_TTL_EXTEND_TO
    let _ = f.client.get_proposal(&prop_id);

    f.env.as_contract(&f.contract_id, || {
        let key = DataKey::Proposal(prop_id);
        assert_eq!(
            f.env.storage().persistent().get_ttl(&key),
            PROPOSAL_TTL_EXTEND_TO
        );
    });
}

// ── 10. Instance storage does not grow with proposals ─────────────────────────

#[test]
fn test_instance_storage_does_not_grow_with_proposals() {
    let f = setup();
    init_fixture(&f, 2);

    let to = Address::generate(&f.env);

    // Create 300 proposals
    for i in 1..=300 {
        let id = f.client.propose_transaction(&f.owner1, &to, &i);
        assert_eq!(id, i as u64);
    }

    assert_eq!(f.client.get_proposal_count(), 300);

    // Verify none of the 300 proposals are in instance storage
    f.env.as_contract(&f.contract_id, || {
        for i in 1..=300 {
            let key = DataKey::Proposal(i as u64);
            assert!(f.env.storage().persistent().has(&key));
            assert!(!f.env.storage().instance().has(&key));
        }

        // Only the expected instance keys exist
        assert!(f.env.storage().instance().has(&DataKey::Owners));
        assert!(f.env.storage().instance().has(&DataKey::Threshold));
        assert!(f.env.storage().instance().has(&DataKey::Token));
        assert!(f.env.storage().instance().has(&DataKey::ProposalCount));
    });

    // Verify reading proposals or proposing another proposal touches only persistent entry,
    // and does not load all proposals in instance storage.
    f.env.cost_estimate().budget().reset_unlimited();
    let prop_300 = f.client.get_proposal(&300);
    assert_eq!(prop_300.id, 300);
    let read_bytes = f.env.cost_estimate().resources().read_bytes;

    // Reading another single proposal should have essentially the same read_bytes
    // (isolated persistent entry lookup, not reading 300 proposals in one huge instance blob).
    f.env.cost_estimate().budget().reset_unlimited();
    let prop_1 = f.client.get_proposal(&1);
    assert_eq!(prop_1.id, 1);
    let read_bytes_1 = f.env.cost_estimate().resources().read_bytes;

    assert!(
        read_bytes <= read_bytes_1 + 100 && read_bytes_1 <= read_bytes + 100,
        "single proposal read IO should be constant: {read_bytes} vs {read_bytes_1}"
    );
}

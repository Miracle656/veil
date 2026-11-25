//! Multisig wallet contract
#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, token, Address, Env,
    Symbol, Vec,
};

/// TTL policy for proposals in persistent storage (~30 days, matching factory and veil-names).
pub const PROPOSAL_TTL_THRESHOLD: u32 = 29 * 17_280;
pub const PROPOSAL_TTL_EXTEND_TO: u32 = 30 * 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MultisigError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    ThresholdZero = 3,
    ThresholdTooHigh = 4,
    DuplicateOwners = 5,
    NotAnOwner = 6,
    InvalidAmount = 7,
    ProposalNotFound = 8,
    ProposalAlreadyExecuted = 9,
}

pub use MultisigError as Error;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    pub id: u64,
    pub to: Address,
    pub amount: i128,
    pub approvals: Vec<Address>,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owners,
    Threshold,
    ProposalCount,
    Token,
    Proposal(u64),
}

fn load_proposal(env: &Env, id: u64) -> Option<Proposal> {
    let key = DataKey::Proposal(id);
    let proposal: Option<Proposal> = env.storage().persistent().get(&key);
    if proposal.is_some() {
        env.storage()
            .persistent()
            .extend_ttl(&key, PROPOSAL_TTL_THRESHOLD, PROPOSAL_TTL_EXTEND_TO);
    }
    proposal
}

fn save_proposal(env: &Env, id: u64, proposal: &Proposal) {
    let key = DataKey::Proposal(id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, PROPOSAL_TTL_THRESHOLD, PROPOSAL_TTL_EXTEND_TO);
}

#[contract]
pub struct MultisigContract;

#[contractimpl]
impl MultisigContract {
    /// Initialize the multisig with a list of owners, threshold `m`, and a token address (e.g. native SAC).
    pub fn initialize(env: Env, owners: Vec<Address>, threshold: u32, token: Address) {
        if env.storage().instance().has(&DataKey::Threshold) {
            panic_with_error!(&env, MultisigError::AlreadyInitialized);
        }
        if threshold == 0 {
            panic_with_error!(&env, MultisigError::ThresholdZero);
        }
        if owners.len() < threshold {
            panic_with_error!(&env, MultisigError::ThresholdTooHigh);
        }

        // Check for duplicate owners
        for i in 0..owners.len() {
            let owner = owners.get(i).unwrap();
            for j in (i + 1)..owners.len() {
                if owner == owners.get(j).unwrap() {
                    panic_with_error!(&env, MultisigError::DuplicateOwners);
                }
            }
        }

        env.storage().instance().set(&DataKey::Owners, &owners);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
    }

    /// Propose a transaction; returns a proposal id.
    pub fn propose_transaction(env: Env, caller: Address, to: Address, amount: i128) -> u64 {
        caller.require_auth();

        if amount <= 0 {
            panic_with_error!(&env, MultisigError::InvalidAmount);
        }

        let owners: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Owners)
            .unwrap_or_else(|| panic_with_error!(&env, MultisigError::NotInitialized));

        let mut is_owner = false;
        for owner in owners.iter() {
            if owner == caller {
                is_owner = true;
                break;
            }
        }
        if !is_owner {
            panic_with_error!(&env, MultisigError::NotAnOwner);
        }

        let mut count: u64 = env.storage().instance().get(&DataKey::ProposalCount).unwrap_or(0);
        count += 1;
        env.storage().instance().set(&DataKey::ProposalCount, &count);

        let proposal = Proposal {
            id: count,
            to: to.clone(),
            amount,
            approvals: Vec::new(&env),
            executed: false,
        };

        save_proposal(&env, count, &proposal);

        env.events().publish(
            (Symbol::new(&env, "propose"), count),
            (caller, to, amount),
        );

        count
    }

    /// Sign/approve a proposal
    pub fn sign_transaction(env: Env, proposal_id: u64, signer: Address) {
        signer.require_auth();

        // Check if signer is an owner
        let owners: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Owners)
            .unwrap_or_else(|| panic_with_error!(&env, MultisigError::NotInitialized));

        let mut is_owner = false;
        for owner in owners.iter() {
            if owner == signer {
                is_owner = true;
                break;
            }
        }
        if !is_owner {
            panic_with_error!(&env, MultisigError::NotAnOwner);
        }

        // Fetch proposal from persistent storage (with TTL extension)
        let mut proposal: Proposal = load_proposal(&env, proposal_id)
            .unwrap_or_else(|| panic_with_error!(&env, MultisigError::ProposalNotFound));

        if proposal.executed {
            panic_with_error!(&env, MultisigError::ProposalAlreadyExecuted);
        }

        // Check if signer already approved
        let mut already_approved = false;
        for approved in proposal.approvals.iter() {
            if approved == signer {
                already_approved = true;
                break;
            }
        }
        if !already_approved {
            proposal.approvals.push_back(signer.clone());

            env.events().publish(
                (Symbol::new(&env, "approve"), proposal_id),
                (signer.clone(), proposal.approvals.len()),
            );
        }

        // If threshold met, execute proposal
        let threshold: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or_else(|| panic_with_error!(&env, MultisigError::NotInitialized));

        if proposal.approvals.len() >= threshold {
            proposal.executed = true;
            let token_address: Address = env
                .storage()
                .instance()
                .get(&DataKey::Token)
                .unwrap_or_else(|| panic_with_error!(&env, MultisigError::NotInitialized));
            let token_client = token::Client::new(&env, &token_address);
            token_client.transfer(&env.current_contract_address(), &proposal.to, &proposal.amount);

            env.events().publish(
                (Symbol::new(&env, "execute"), proposal_id),
                (proposal.to.clone(), proposal.amount),
            );
        }

        save_proposal(&env, proposal_id, &proposal);
    }

    /// Query a proposal (to, amount, approvals)
    pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal {
        load_proposal(&env, proposal_id)
            .unwrap_or_else(|| panic_with_error!(&env, MultisigError::ProposalNotFound))
    }

    /// Query the configuration
    pub fn get_owners(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Owners)
            .unwrap_or_else(|| panic_with_error!(&env, MultisigError::NotInitialized))
    }

    pub fn get_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::Threshold)
            .unwrap_or_else(|| panic_with_error!(&env, MultisigError::NotInitialized))
    }

    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::ProposalCount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod test;

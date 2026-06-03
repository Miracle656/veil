//! Multisig wallet contract
#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, token, Address, Env, Symbol, Vec
};

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

#[contract]
pub struct MultisigContract;

#[contractimpl]
impl MultisigContract {
    /// Initialize the multisig with a list of owners, threshold `m`, and a token address (e.g. native SAC).
    pub fn initialize(env: Env, owners: Vec<Address>, threshold: u32, token: Address) {
        if env.storage().instance().has(&DataKey::Threshold) {
            panic!("already initialized");
        }
        if threshold == 0 {
            panic!("threshold must be greater than 0");
        }
        if owners.len() < threshold as u32 {
            panic!("threshold cannot exceed owners length");
        }

        env.storage().instance().set(&DataKey::Owners, &owners);
        env.storage().instance().set(&DataKey::Threshold, &threshold);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::ProposalCount, &0u64);
    }

    /// Propose a transaction; returns a proposal id.
    pub fn propose_transaction(env: Env, caller: Address, to: Address, amount: i128) -> u64 {
        caller.require_auth();

        let owners: Vec<Address> = env.storage().instance().get(&DataKey::Owners).expect("not initialized");
        let mut is_owner = false;
        for owner in owners.iter() {
            if owner == caller {
                is_owner = true;
                break;
            }
        }
        if !is_owner {
            panic!("caller is not an owner");
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

        env.storage().instance().set(&DataKey::Proposal(count), &proposal);

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
        let owners: Vec<Address> = env.storage().instance().get(&DataKey::Owners).expect("not initialized");
        let mut is_owner = false;
        for owner in owners.iter() {
            if owner == signer {
                is_owner = true;
                break;
            }
        }
        if !is_owner {
            panic!("not an owner");
        }

        // Fetch proposal
        let mut proposal: Proposal = env.storage().instance().get(&DataKey::Proposal(proposal_id)).expect("proposal not found");
        if proposal.executed {
            panic!("proposal already executed");
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
        let threshold: u32 = env.storage().instance().get(&DataKey::Threshold).unwrap();
        if proposal.approvals.len() >= threshold {
            proposal.executed = true;
            let token_address: Address = env.storage().instance().get(&DataKey::Token).unwrap();
            let token_client = token::Client::new(&env, &token_address);
            token_client.transfer(&env.current_contract_address(), &proposal.to, &proposal.amount);

            env.events().publish(
                (Symbol::new(&env, "execute"), proposal_id),
                (proposal.to.clone(), proposal.amount),
            );
        }

        env.storage().instance().set(&DataKey::Proposal(proposal_id), &proposal);
    }

    /// Query a proposal (to, amount, approvals)
    pub fn get_proposal(env: Env, proposal_id: u64) -> Proposal {
        env.storage().instance().get(&DataKey::Proposal(proposal_id)).expect("proposal not found")
    }

    /// Query the configuration
    pub fn get_owners(env: Env) -> Vec<Address> {
        env.storage().instance().get(&DataKey::Owners).expect("not initialized")
    }

    pub fn get_threshold(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Threshold).expect("not initialized")
    }

    pub fn get_proposal_count(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::ProposalCount).unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{Env, Address, testutils::Address as _};

    #[test]
    fn test_multisig_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, MultisigContract);
        let client = MultisigContractClient::new(&env, &contract_id);

        let owner1 = Address::generate(&env);
        let owner2 = Address::generate(&env);
        let owner3 = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token = env.register_stellar_asset_contract(token_admin.clone());
        let token_client = token::Client::new(&env, &token);

        // Mint some tokens to the multisig contract so it has funds to transfer
        let sac_client = token::StellarAssetClient::new(&env, &token);
        sac_client.mint(&contract_id, &1000);

        let mut owners = Vec::new(&env);
        owners.push_back(owner1.clone());
        owners.push_back(owner2.clone());
        owners.push_back(owner3.clone());

        client.initialize(&owners, &2, &token);

        assert_eq!(client.get_threshold(), 2);
        assert_eq!(client.get_owners().len(), 3);

        let to = Address::generate(&env);
        let prop_id = client.propose_transaction(&owner1, &to, &100);
        assert_eq!(prop_id, 1);

        let proposal = client.get_proposal(&1);
        assert_eq!(proposal.executed, false);
        assert_eq!(proposal.approvals.len(), 0);

        client.sign_transaction(&1, &owner1);
        let proposal = client.get_proposal(&1);
        assert_eq!(proposal.approvals.len(), 1);
        assert_eq!(proposal.executed, false);

        client.sign_transaction(&1, &owner2);
        let proposal = client.get_proposal(&1);
        assert_eq!(proposal.approvals.len(), 2);
        assert_eq!(proposal.executed, true);

        // Check that the transfer actually happened
        assert_eq!(token_client.balance(&to), 100);
        assert_eq!(token_client.balance(&contract_id), 900);
    }
}

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

    // ── Threshold evaluation (#1207) ─────────────────────────────────────────
    //
    // The whole feature is the check `approvals.len() >= threshold`. Off by one
    // in one direction blocks a payment; in the other it pays out with a
    // signature missing. These tests attempt the second.

    struct Ctx {
        env: Env,
        contract_id: Address,
        owners: [Address; 3],
        to: Address,
        token_address: Address,
    }

    impl Ctx {
        fn client(&self) -> MultisigContractClient<'_> {
            MultisigContractClient::new(&self.env, &self.contract_id)
        }

        fn balance(&self, who: &Address) -> i128 {
            token::Client::new(&self.env, &self.token_address).balance(who)
        }
    }

    /// Three owners, the given threshold, 1000 tokens in the multisig and one
    /// proposal of 100 to `to`.
    fn setup(threshold: u32) -> Ctx {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(MultisigContract, ());
        let owners = [Address::generate(&env), Address::generate(&env), Address::generate(&env)];
        let token_address = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        token::StellarAssetClient::new(&env, &token_address).mint(&contract_id, &1000);

        let client = MultisigContractClient::new(&env, &contract_id);
        let mut list = Vec::new(&env);
        for o in owners.iter() {
            list.push_back(o.clone());
        }
        client.initialize(&list, &threshold, &token_address);

        let to = Address::generate(&env);
        assert_eq!(client.propose_transaction(&owners[0], &to, &100), 1);

        Ctx { env, contract_id, owners, to, token_address }
    }

    #[test]
    fn one_signature_below_threshold_does_not_pay() {
        // Breaks: a 3-of-3 paying out on two signatures.
        let ctx = setup(3);
        let client = ctx.client();
        client.sign_transaction(&1, &ctx.owners[0]);
        client.sign_transaction(&1, &ctx.owners[1]);

        let p = client.get_proposal(&1);
        assert_eq!(p.approvals.len(), 2);
        assert!(!p.executed);
        assert_eq!(ctx.balance(&ctx.to), 0);
        assert_eq!(ctx.balance(&ctx.contract_id), 1000);
    }

    #[test]
    fn exactly_at_threshold_pays_once() {
        // Breaks: a legitimate 3-of-3 blocked, or paid twice.
        let ctx = setup(3);
        let client = ctx.client();
        for o in ctx.owners.iter() {
            client.sign_transaction(&1, o);
        }
        assert!(client.get_proposal(&1).executed);
        assert_eq!(ctx.balance(&ctx.to), 100);
        assert_eq!(ctx.balance(&ctx.contract_id), 900);
    }

    #[test]
    fn threshold_of_one_pays_on_the_first_signature() {
        // Boundary: the smallest threshold. Breaks: 1-of-N needing two.
        let ctx = setup(1);
        ctx.client().sign_transaction(&1, &ctx.owners[2]);
        assert!(ctx.client().get_proposal(&1).executed);
        assert_eq!(ctx.balance(&ctx.to), 100);
    }

    #[test]
    fn a_repeated_signature_counts_once() {
        // Breaks: one owner meeting a 2-of-3 alone by signing twice.
        let ctx = setup(2);
        let client = ctx.client();
        client.sign_transaction(&1, &ctx.owners[0]);
        client.sign_transaction(&1, &ctx.owners[0]);
        client.sign_transaction(&1, &ctx.owners[0]);

        let p = client.get_proposal(&1);
        assert_eq!(p.approvals.len(), 1);
        assert!(!p.executed);
        assert_eq!(ctx.balance(&ctx.to), 0);

        // A second, different owner does meet it.
        client.sign_transaction(&1, &ctx.owners[1]);
        assert!(client.get_proposal(&1).executed);
        assert_eq!(ctx.balance(&ctx.to), 100);
    }

    #[test]
    fn a_non_owner_signature_is_refused_and_does_not_count() {
        // Breaks: an outsider supplying the missing signature.
        let ctx = setup(2);
        let client = ctx.client();
        client.sign_transaction(&1, &ctx.owners[0]);
        let outsider = Address::generate(&ctx.env);
        assert!(client.try_sign_transaction(&1, &outsider).is_err());

        let p = client.get_proposal(&1);
        assert_eq!(p.approvals.len(), 1);
        assert!(!p.executed);
        assert_eq!(ctx.balance(&ctx.to), 0);
    }

    #[test]
    fn an_owner_signature_needs_that_owners_auth() {
        // Without mock_all_auths. Breaks: anyone approving in an owner's name.
        let ctx = setup(1);
        ctx.env.set_auths(&[]);
        assert!(ctx.client().try_sign_transaction(&1, &ctx.owners[0]).is_err());
        assert_eq!(ctx.balance(&ctx.to), 0);
    }

    #[test]
    fn an_executed_proposal_cannot_be_signed_again() {
        // Breaks: a late signature replaying the payment.
        let ctx = setup(2);
        let client = ctx.client();
        client.sign_transaction(&1, &ctx.owners[0]);
        client.sign_transaction(&1, &ctx.owners[1]);
        assert!(client.try_sign_transaction(&1, &ctx.owners[2]).is_err());
        assert_eq!(ctx.balance(&ctx.to), 100);
    }

    #[test]
    fn approvals_do_not_carry_between_proposals() {
        // Breaks: signatures on one proposal counting toward another.
        let ctx = setup(2);
        let client = ctx.client();
        assert_eq!(client.propose_transaction(&ctx.owners[1], &ctx.to, &50), 2);
        client.sign_transaction(&1, &ctx.owners[0]);
        client.sign_transaction(&2, &ctx.owners[1]);
        assert!(!client.get_proposal(&1).executed);
        assert!(!client.get_proposal(&2).executed);
        assert_eq!(ctx.balance(&ctx.to), 0);
    }

    #[test]
    fn only_an_owner_can_propose() {
        // Breaks: an outsider queueing payments for owners to rubber-stamp.
        let ctx = setup(2);
        let outsider = Address::generate(&ctx.env);
        assert!(ctx.client().try_propose_transaction(&outsider, &ctx.to, &1).is_err());
        assert_eq!(ctx.client().get_proposal_count(), 1);
    }

    #[test]
    fn initialize_refuses_a_threshold_that_is_zero_or_above_the_owner_count() {
        // Boundary: 0 (anything executes) and owners + 1 (nothing ever can).
        let env = Env::default();
        env.mock_all_auths();
        let token = Address::generate(&env);
        let mut owners = Vec::new(&env);
        owners.push_back(Address::generate(&env));
        owners.push_back(Address::generate(&env));

        for bad in [0u32, 3] {
            let id = env.register(MultisigContract, ());
            let client = MultisigContractClient::new(&env, &id);
            assert!(client.try_initialize(&owners, &bad, &token).is_err());
        }
        // Exactly the owner count is allowed.
        let id = env.register(MultisigContract, ());
        MultisigContractClient::new(&env, &id).initialize(&owners, &2, &token);
    }

    #[test]
    fn initialize_cannot_be_called_twice() {
        // Breaks: anyone replacing the owners of a funded multisig.
        let ctx = setup(2);
        let mut mine = Vec::new(&ctx.env);
        mine.push_back(Address::generate(&ctx.env));
        let token = Address::generate(&ctx.env);
        assert!(ctx.client().try_initialize(&mine, &1, &token).is_err());
        assert_eq!(ctx.client().get_owners().len(), 3);
    }
}

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultConfig {
    pub owner: Address,
    pub token: Address,
    pub delay_seconds: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdrawal {
    pub id: u64,
    pub to: Address,
    pub amount: i128,
    pub queued_at: u64,
    pub unlock_at: u64,
    pub cancelled: bool,
    pub executed: bool,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Config,
    WithdrawalCount,
    ReservedAmount,
    Withdrawal(u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum VaultError {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    InvalidDelay = 3,
    InvalidAmount = 4,
    WithdrawalNotFound = 5,
    WithdrawalNotPending = 6,
    TimelockActive = 7,
    InsufficientAvailableBalance = 8,
    ArithmeticOverflow = 9,
}

#[contract]
pub struct VaultContract;

#[contractimpl]
impl VaultContract {
    pub fn initialize(
        env: Env,
        owner: Address,
        token: Address,
        delay_seconds: u64,
    ) -> Result<(), VaultError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(VaultError::AlreadyInitialized);
        }
        if delay_seconds == 0 {
            return Err(VaultError::InvalidDelay);
        }

        owner.require_auth();

        let config = VaultConfig {
            owner,
            token,
            delay_seconds,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::WithdrawalCount, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::ReservedAmount, &0i128);

        env.events()
            .publish((symbol_short!("vault"), symbol_short!("init")), config);

        Ok(())
    }

    pub fn queue_withdrawal(env: Env, to: Address, amount: i128) -> Result<u64, VaultError> {
        if amount <= 0 {
            return Err(VaultError::InvalidAmount);
        }

        let config = Self::load_config(&env)?;
        config.owner.require_auth();

        let vault_address = env.current_contract_address();
        let balance = token::Client::new(&env, &config.token).balance(&vault_address);
        let reserved = Self::reserved_amount(&env);
        let available = balance
            .checked_sub(reserved)
            .ok_or(VaultError::ArithmeticOverflow)?;
        if amount > available {
            return Err(VaultError::InsufficientAvailableBalance);
        }

        let id = Self::withdrawal_count(&env)
            .checked_add(1)
            .ok_or(VaultError::ArithmeticOverflow)?;
        let queued_at = env.ledger().timestamp();
        let unlock_at = queued_at
            .checked_add(config.delay_seconds)
            .ok_or(VaultError::ArithmeticOverflow)?;
        let new_reserved = reserved
            .checked_add(amount)
            .ok_or(VaultError::ArithmeticOverflow)?;

        let withdrawal = Withdrawal {
            id,
            to: to.clone(),
            amount,
            queued_at,
            unlock_at,
            cancelled: false,
            executed: false,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Withdrawal(id), &withdrawal);
        env.storage().instance().set(&DataKey::WithdrawalCount, &id);
        env.storage()
            .instance()
            .set(&DataKey::ReservedAmount, &new_reserved);

        env.events().publish(
            (symbol_short!("vault"), symbol_short!("queue")),
            (id, to, amount, unlock_at),
        );

        Ok(id)
    }

    pub fn cancel_withdrawal(env: Env, withdrawal_id: u64) -> Result<(), VaultError> {
        let config = Self::load_config(&env)?;
        config.owner.require_auth();

        let mut withdrawal = Self::load_withdrawal(&env, withdrawal_id)?;
        if withdrawal.cancelled || withdrawal.executed {
            return Err(VaultError::WithdrawalNotPending);
        }

        withdrawal.cancelled = true;
        let new_reserved = Self::reserved_amount(&env)
            .checked_sub(withdrawal.amount)
            .ok_or(VaultError::ArithmeticOverflow)?;

        env.storage()
            .persistent()
            .set(&DataKey::Withdrawal(withdrawal_id), &withdrawal);
        env.storage()
            .instance()
            .set(&DataKey::ReservedAmount, &new_reserved);

        env.events().publish(
            (symbol_short!("vault"), symbol_short!("cancel")),
            withdrawal_id,
        );

        Ok(())
    }

    pub fn execute_withdrawal(env: Env, withdrawal_id: u64) -> Result<(), VaultError> {
        let config = Self::load_config(&env)?;
        let mut withdrawal = Self::load_withdrawal(&env, withdrawal_id)?;
        if withdrawal.cancelled || withdrawal.executed {
            return Err(VaultError::WithdrawalNotPending);
        }
        if env.ledger().timestamp() < withdrawal.unlock_at {
            return Err(VaultError::TimelockActive);
        }

        withdrawal.executed = true;
        let new_reserved = Self::reserved_amount(&env)
            .checked_sub(withdrawal.amount)
            .ok_or(VaultError::ArithmeticOverflow)?;

        // Persist finalization before the external token call. Soroban rolls
        // these writes back if the transfer fails.
        env.storage()
            .persistent()
            .set(&DataKey::Withdrawal(withdrawal_id), &withdrawal);
        env.storage()
            .instance()
            .set(&DataKey::ReservedAmount, &new_reserved);

        token::Client::new(&env, &config.token).transfer(
            &env.current_contract_address(),
            &withdrawal.to,
            &withdrawal.amount,
        );

        env.events().publish(
            (symbol_short!("vault"), symbol_short!("execute")),
            (withdrawal_id, withdrawal.to, withdrawal.amount),
        );

        Ok(())
    }

    pub fn get_config(env: Env) -> Result<VaultConfig, VaultError> {
        Self::load_config(&env)
    }

    pub fn get_withdrawal(env: Env, withdrawal_id: u64) -> Result<Withdrawal, VaultError> {
        Self::load_withdrawal(&env, withdrawal_id)
    }

    pub fn get_withdrawal_count(env: Env) -> u64 {
        Self::withdrawal_count(&env)
    }

    pub fn get_reserved_amount(env: Env) -> i128 {
        Self::reserved_amount(&env)
    }

    pub fn get_available_balance(env: Env) -> Result<i128, VaultError> {
        let config = Self::load_config(&env)?;
        let balance =
            token::Client::new(&env, &config.token).balance(&env.current_contract_address());
        balance
            .checked_sub(Self::reserved_amount(&env))
            .ok_or(VaultError::ArithmeticOverflow)
    }

    fn load_config(env: &Env) -> Result<VaultConfig, VaultError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(VaultError::NotInitialized)
    }

    fn load_withdrawal(env: &Env, withdrawal_id: u64) -> Result<Withdrawal, VaultError> {
        env.storage()
            .persistent()
            .get(&DataKey::Withdrawal(withdrawal_id))
            .ok_or(VaultError::WithdrawalNotFound)
    }

    fn withdrawal_count(env: &Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::WithdrawalCount)
            .unwrap_or(0)
    }

    fn reserved_amount(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ReservedAmount)
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Ledger as _},
        token, Address, Env,
    };

    const DELAY_SECONDS: u64 = 86_400;

    struct TestContext {
        env: Env,
        contract_id: Address,
        owner: Address,
        recipient: Address,
        token_address: Address,
    }

    impl TestContext {
        fn client(&self) -> VaultContractClient<'_> {
            VaultContractClient::new(&self.env, &self.contract_id)
        }

        fn token_client(&self) -> token::Client<'_> {
            token::Client::new(&self.env, &self.token_address)
        }
    }

    fn setup(balance: i128) -> TestContext {
        let env = Env::default();
        env.mock_all_auths();
        env.ledger().with_mut(|ledger| ledger.timestamp = 1_000);

        let contract_id = env.register(VaultContract, ());
        let owner = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_address = env
            .register_stellar_asset_contract_v2(token_admin)
            .address();

        token::StellarAssetClient::new(&env, &token_address).mint(&contract_id, &balance);

        let client = VaultContractClient::new(&env, &contract_id);
        client.initialize(&owner, &token_address, &DELAY_SECONDS);

        TestContext {
            env,
            contract_id,
            owner,
            recipient,
            token_address,
        }
    }

    #[test]
    fn queue_enforces_timelock_then_executes() {
        let ctx = setup(1_000);
        let client = ctx.client();
        let token_client = ctx.token_client();

        let id = client.queue_withdrawal(&ctx.recipient, &250);
        let withdrawal = client.get_withdrawal(&id);
        assert_eq!(id, 1);
        assert_eq!(withdrawal.queued_at, 1_000);
        assert_eq!(withdrawal.unlock_at, 1_000 + DELAY_SECONDS);
        assert_eq!(client.get_reserved_amount(), 250);
        assert_eq!(client.get_available_balance(), 750);

        assert!(client.try_execute_withdrawal(&id).is_err());
        assert_eq!(token_client.balance(&ctx.recipient), 0);
        assert_eq!(token_client.balance(&ctx.contract_id), 1_000);

        ctx.env
            .ledger()
            .with_mut(|ledger| ledger.timestamp = withdrawal.unlock_at);
        client.execute_withdrawal(&id);

        let executed = client.get_withdrawal(&id);
        assert!(executed.executed);
        assert!(!executed.cancelled);
        assert_eq!(client.get_reserved_amount(), 0);
        assert_eq!(token_client.balance(&ctx.recipient), 250);
        assert_eq!(token_client.balance(&ctx.contract_id), 750);
    }

    #[test]
    fn owner_can_cancel_pending_withdrawal() {
        let ctx = setup(1_000);
        let client = ctx.client();
        let token_client = ctx.token_client();

        let id = client.queue_withdrawal(&ctx.recipient, &400);
        client.cancel_withdrawal(&id);

        let cancelled = client.get_withdrawal(&id);
        assert!(cancelled.cancelled);
        assert!(!cancelled.executed);
        assert_eq!(client.get_reserved_amount(), 0);
        assert_eq!(client.get_available_balance(), 1_000);

        ctx.env
            .ledger()
            .with_mut(|ledger| ledger.timestamp = cancelled.unlock_at + 1);
        assert!(client.try_execute_withdrawal(&id).is_err());
        assert_eq!(token_client.balance(&ctx.recipient), 0);
        assert_eq!(token_client.balance(&ctx.contract_id), 1_000);
    }

    #[test]
    fn finalized_withdrawals_cannot_be_replayed() {
        let ctx = setup(1_000);
        let client = ctx.client();
        let token_client = ctx.token_client();

        let executed_id = client.queue_withdrawal(&ctx.recipient, &200);
        ctx.env
            .ledger()
            .with_mut(|ledger| ledger.timestamp = 1_000 + DELAY_SECONDS);
        client.execute_withdrawal(&executed_id);

        assert!(client.try_execute_withdrawal(&executed_id).is_err());
        assert!(client.try_cancel_withdrawal(&executed_id).is_err());
        assert_eq!(token_client.balance(&ctx.recipient), 200);

        let cancelled_id = client.queue_withdrawal(&ctx.recipient, &100);
        client.cancel_withdrawal(&cancelled_id);
        assert!(client.try_cancel_withdrawal(&cancelled_id).is_err());
        assert!(client.try_execute_withdrawal(&cancelled_id).is_err());
        assert_eq!(token_client.balance(&ctx.recipient), 200);
    }

    #[test]
    fn queue_cannot_overcommit_vault_balance() {
        let ctx = setup(500);
        let client = ctx.client();

        client.queue_withdrawal(&ctx.recipient, &400);
        assert!(client.try_queue_withdrawal(&ctx.owner, &101).is_err());
        assert_eq!(client.get_reserved_amount(), 400);
        assert_eq!(client.get_available_balance(), 100);
    }

    #[test]
    fn initialize_and_amount_validation() {
        let ctx = setup(500);
        let client = ctx.client();

        assert!(client
            .try_initialize(&ctx.owner, &ctx.owner, &DELAY_SECONDS)
            .is_err());
        assert!(client.try_queue_withdrawal(&ctx.recipient, &0).is_err());
        assert!(client.try_queue_withdrawal(&ctx.recipient, &-1).is_err());
    }
}

// Pre-deployment review findings (#1278), written as tests of the behaviour
// the vault should have. Test-only: not part of the release WASM.
#[cfg(test)]
mod audit_tests;

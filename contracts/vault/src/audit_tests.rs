//! Pre-deployment review of the vault (#1278).
//!
//! No Veil contract is upgradeable. Whatever is deployed stays at its address,
//! and a fix means a new deployment plus a migration for everyone inside. So
//! each finding below is written as a test of the behaviour the vault *should*
//! have. Against the current contract those tests fail, which is the point.
//!
//! They are `#[ignore]`d so CI stays green while the maintainers decide on the
//! contract changes. Each one fails today and should pass once its finding is
//! fixed. Run them with:
//!
//!     cargo test -p vault -- --ignored
//!
//! Nothing here changes the contract. This file is compiled only under
//! `cfg(test)`, so the release WASM, and its hash in
//! contracts/expected-hashes.json, are unchanged.

use super::*;
use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _, MockAuth, MockAuthInvoke,
    },
    Address, Env, IntoVal,
};

const DAY: u64 = 86_400;
/// Soroban closes a ledger roughly every 5 seconds.
const SECONDS_PER_LEDGER: u64 = 5;

struct Vault {
    env: Env,
    id: Address,
    owner: Address,
}

impl Vault {
    fn client(&self) -> VaultContractClient<'_> {
        VaultContractClient::new(&self.env, &self.id)
    }
}

fn token(env: &Env) -> Address {
    env.register_stellar_asset_contract_v2(Address::generate(env))
        .address()
}

/// A vault holding `balance` of a fresh token, initialized by its owner.
fn funded_vault(balance: i128, delay_seconds: u64) -> Vault {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|ledger| {
        ledger.timestamp = 1_000;
        // Room for a long lock to be covered by a TTL extension. It does not
        // need to be exactly the network's value.
        ledger.max_entry_ttl = 6_312_000;
    });

    let id = env.register(VaultContract, ());
    let owner = Address::generate(&env);
    let token = token(&env);
    token::StellarAssetClient::new(&env, &token).mint(&id, &balance);
    VaultContractClient::new(&env, &id).initialize(&owner, &token, &delay_seconds);

    Vault { env, id, owner }
}

/// Finding 1 (high): anyone can initialize a freshly deployed vault and
/// become its owner.
///
/// `initialize` takes the owner as an argument and only asks *that* address to
/// sign, so whoever calls it first owns the vault. The web wallet's
/// `deployAndInitializeVault` (frontend/wallet/lib/vault.ts) sends the deploy
/// and the `initialize` as two separate transactions, waiting for the first to
/// land. Anyone watching the ledger can initialize the new contract in between,
/// with themselves as owner. The app's own `initialize` then fails with
/// `AlreadyInitialized`, so the usual result is a vault that cannot be set up:
/// a griefing attack that costs the user fees. It turns into a loss if money
/// reaches that address anyway, for example through the "attach an existing
/// vault" flow, because the stranger can queue withdrawals of it to themselves.
///
/// Fix: initialize in a `__constructor` (soroban-sdk 22, protocol 22), so the
/// deploy and the configuration are one atomic operation and there is no
/// `initialize` left to call. When that lands, this test's setup changes, since
/// `register` takes the constructor args, but the property stays the same.
#[test]
#[ignore = "#1278 finding 1: initialize is callable by anyone before the owner; needs a constructor (contract change)"]
fn a_third_party_cannot_initialize_someone_elses_vault() {
    let env = Env::default();
    let vault = env.register(VaultContract, ());
    let attacker = Address::generate(&env);
    let token = token(&env);

    // Only the attacker signs. Nobody who deployed the vault is involved.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &vault,
            fn_name: "initialize",
            args: (&attacker, &token, DAY).into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let result = VaultContractClient::new(&env, &vault).try_initialize(&attacker, &token, &DAY);
    assert!(
        result.is_err(),
        "a stranger initialized the vault and became its owner"
    );
}

/// Finding 2 (high): a queued withdrawal never expires, so the lock only
/// holds once.
///
/// The vault's job is to be a commitment device: money you cannot casually
/// spend. But a queued withdrawal stays executable forever after `unlock_at`.
/// So a user can queue the whole balance on day one, wait one delay, and from
/// then on hold a standing, already-unlocked exit they can take at any moment,
/// with no delay at all. Every later deposit can be covered the same way.
///
/// Fix: give each withdrawal an execution window, for example
/// `expires_at = unlock_at + window`, after which `execute_withdrawal` refuses
/// and the reservation is released, so leaving the vault needs a fresh queue
/// and a fresh delay.
#[test]
#[ignore = "#1278 finding 2: an unlocked withdrawal stays executable forever; needs an expiry (contract change)"]
fn a_queued_withdrawal_does_not_stay_executable_forever() {
    let vault = funded_vault(1_000, DAY);
    let client = vault.client();

    let id = client.queue_withdrawal(&vault.owner, &1_000);
    let unlock_at = client.get_withdrawal(&id).unlock_at;

    // A year after it unlocked, the whole balance is still one call away.
    vault
        .env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = unlock_at + 365 * DAY);

    assert!(
        client.try_execute_withdrawal(&id).is_err(),
        "a withdrawal queued a year ago still executes with no delay"
    );
}

/// Finding 3a (medium): a queued withdrawal's record can be archived before it
/// unlocks.
///
/// The contract never extends a TTL. `Withdrawal(id)` lives in persistent
/// storage with the network's minimum TTL, so for a lock longer than that, the
/// record is archived before `unlock_at`. Funds are not lost, since an archived
/// entry can be restored, but `execute_withdrawal` fails until someone pays to
/// restore it, and neither app knows how to.
///
/// Fix: `extend_ttl` on the withdrawal entry in `queue_withdrawal`, to at least
/// the ledger at which it can be executed, plus a margin.
#[test]
#[ignore = "#1278 finding 3: storage TTLs are never extended; a long lock can be archived before it unlocks (contract change)"]
fn a_queued_withdrawal_record_outlives_its_unlock_time() {
    let delay = 90 * DAY;
    let vault = funded_vault(1_000, delay);
    let id = vault.client().queue_withdrawal(&vault.owner, &100);

    let ttl = vault.env.as_contract(&vault.id, || {
        vault
            .env
            .storage()
            .persistent()
            .get_ttl(&DataKey::Withdrawal(id))
    });
    let ledgers_until_unlock = (delay / SECONDS_PER_LEDGER) as u32;
    assert!(
        ttl >= ledgers_until_unlock,
        "withdrawal record TTL is {ttl} ledgers but it unlocks in {ledgers_until_unlock}"
    );
}

/// Finding 3b (medium): the vault instance itself, with config, reserved
/// amount and withdrawal count, is never kept alive.
///
/// Instance storage is never extended either, so a vault nobody touches for
/// longer than its TTL is archived as a whole, while it holds the user's money.
/// Fix: `env.storage().instance().extend_ttl(..)` on every entry point.
#[test]
#[ignore = "#1278 finding 3: instance TTL is never extended (contract change)"]
fn the_vault_instance_is_kept_alive_while_a_withdrawal_is_pending() {
    let delay = 90 * DAY;
    let vault = funded_vault(1_000, delay);
    vault.client().queue_withdrawal(&vault.owner, &100);

    let ttl = vault
        .env
        .as_contract(&vault.id, || vault.env.storage().instance().get_ttl());
    let ledgers_until_unlock = (delay / SECONDS_PER_LEDGER) as u32;
    assert!(
        ttl >= ledgers_until_unlock,
        "instance TTL is {ttl} ledgers but the pending withdrawal unlocks in {ledgers_until_unlock}"
    );
}

/// Finding 4 (high): a delay with no upper bound can lock the funds
/// permanently.
///
/// `initialize` accepts any non-zero `delay_seconds`. With a delay so large
/// that `queued_at + delay_seconds` overflows a u64, every `queue_withdrawal`
/// fails with `ArithmeticOverflow`, forever, and there is no other way out.
/// More plausibly, a units slip in a client (milliseconds passed as seconds)
/// gives a 1,000x delay: a 30-day lock becomes 82 years. Since `delay_seconds`
/// is fixed at initialization and the contract cannot be upgraded, either is
/// permanent.
///
/// Fix: reject delays above a sane maximum in `initialize` (or the
/// constructor).
#[test]
#[ignore = "#1278 finding 4: no maximum delay; an oversized delay locks funds permanently (contract change)"]
fn initialize_rejects_a_delay_that_would_lock_funds_for_good() {
    let env = Env::default();
    env.mock_all_auths();
    let vault = env.register(VaultContract, ());
    let owner = Address::generate(&env);
    let token = token(&env);

    let result = VaultContractClient::new(&env, &vault).try_initialize(&owner, &token, &u64::MAX);
    assert!(
        result.is_err(),
        "a vault was initialized with a delay no withdrawal can ever be queued under"
    );
}

/// Finding 5 (low): the errors do not tell a cancelled withdrawal from an
/// executed one.
///
/// Both come back as `WithdrawalNotPending`. This is the same shape as the
/// mainnet wallet's #1182, where two different states returned identical
/// errors. Here it is milder: `get_withdrawal` reports `cancelled` and
/// `executed`, so a client can find out with a second call. But an app that
/// shows the error alone tells a user "not pending" either way, whether their
/// money left or stayed.
///
/// Fix: separate `WithdrawalCancelled` and `WithdrawalExecuted` errors.
#[test]
#[ignore = "#1278 finding 5: cancelled and executed withdrawals return the same error (contract change)"]
fn errors_tell_a_cancelled_withdrawal_from_an_executed_one() {
    let vault = funded_vault(1_000, DAY);
    let client = vault.client();

    let cancelled = client.queue_withdrawal(&vault.owner, &100);
    client.cancel_withdrawal(&cancelled);

    let executed = client.queue_withdrawal(&vault.owner, &100);
    let unlock_at = client.get_withdrawal(&executed).unlock_at;
    vault
        .env
        .ledger()
        .with_mut(|ledger| ledger.timestamp = unlock_at);
    client.execute_withdrawal(&executed);

    let on_cancelled = client.try_execute_withdrawal(&cancelled).unwrap_err().unwrap();
    let on_executed = client.try_execute_withdrawal(&executed).unwrap_err().unwrap();
    assert_ne!(
        on_cancelled, on_executed,
        "a cancelled and an executed withdrawal are indistinguishable by error"
    );
}

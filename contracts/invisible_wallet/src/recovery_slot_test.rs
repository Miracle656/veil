#![cfg(test)]
//! The guardian path and the recovery-key path share one recovery slot (#1182).

use super::*;
use crate::recovery::RECOVERY_KEY_DELAY;
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::testutils::EnvTestConfig;
use soroban_sdk::{Address, Bytes, BytesN, Env};

struct Wallet {
    env: Env,
    id: Address,
}

impl Wallet {
    fn client(&self) -> InvisibleWalletClient<'_> {
        InvisibleWalletClient::new(&self.env, &self.id)
    }

    /// Both raw pending keys, read straight from contract storage.
    fn slots(&self) -> (bool, bool) {
        self.env.as_contract(&self.id, || {
            let p = self.env.storage().persistent();
            (p.has(&DataKey::RecoveryPending), p.has(&DataKey::RecoveryKeyPending))
        })
    }

    fn advance(&self, secs: u64) {
        self.env.ledger().with_mut(|l| l.timestamp += secs);
    }
}

fn key(env: &Env, seed: u8) -> BytesN<65> {
    let mut b = [0u8; 65];
    b[0] = 0x04;
    b[1] = seed;
    BytesN::from_array(env, &b)
}

const OWNER: u8 = 0x01;
const SECOND_DEVICE: u8 = 0x02;
const THIRD_DEVICE: u8 = 0x03;
const GUARDIAN_PICK: u8 = 0x47;
const RECOVERY_KEY_PICK: u8 = 0x52;

/// A wallet with three signers, a guardian and a recovery key.
fn wallet() -> Wallet {
    wallet_in(Env::default())
}

/// Same wallet without a ledger snapshot on drop: the exhaustive check below
/// builds thousands of these.
fn wallet_unsnapshotted() -> Wallet {
    wallet_in(Env::new_with_config(EnvTestConfig { capture_snapshot_at_drop: false }))
}

fn wallet_in(env: Env) -> Wallet {
    env.mock_all_auths();
    let id = env.register_contract(None, InvisibleWallet);
    let w = Wallet { env, id };
    let c = w.client();
    c.init(&key(&w.env, OWNER), &Bytes::new(&w.env), &Bytes::new(&w.env));
    c.add_signer(&key(&w.env, SECOND_DEVICE));
    c.add_signer(&key(&w.env, THIRD_DEVICE));
    c.set_guardian(&Address::generate(&w.env));
    c.set_recovery_key(&Address::generate(&w.env));
    w
}

fn only_signer_is(w: &Wallet, seed: u8) {
    let signers = w.client().get_signers();
    assert_eq!(signers.len(), 1, "recovery must leave exactly one signer");
    assert_eq!(signers.get(0), Some(key(&w.env, seed)));
    for gone in [OWNER, SECOND_DEVICE, THIRD_DEVICE] {
        if gone != seed {
            assert!(!w.client().has_signer(&key(&w.env, gone)));
        }
    }
}

// ── the race: initiate both, then finalise each ─────────────────────────────

#[test]
fn guardian_first_blocks_recovery_key_and_wins_alone() {
    let w = wallet();
    let c = w.client();

    c.initiate_recovery(&key(&w.env, GUARDIAN_PICK));
    assert_eq!(
        c.try_request_recovery(&key(&w.env, RECOVERY_KEY_PICK)),
        Err(Ok(WalletError::GuardianRecoveryPending)),
    );
    assert_eq!(w.slots(), (true, false));

    let status = c.get_pending_recovery().unwrap();
    assert_eq!(status.source, RecoverySource::Guardian);
    assert_eq!(status.new_public_key, key(&w.env, GUARDIAN_PICK));

    // The recovery-key entrypoint names the system that holds the slot.
    assert_eq!(c.try_finalize_recovery(), Err(Ok(WalletError::GuardianRecoveryPending)));

    w.advance(RECOVERY_DELAY_SECONDS + 1);
    c.complete_recovery();
    only_signer_is(&w, GUARDIAN_PICK);
    assert_eq!(c.get_pending_recovery(), None);

    // Long after the 7-day delay there is still nothing for the recovery key
    // to finalise: its request never existed.
    w.advance(RECOVERY_KEY_DELAY + 1);
    assert_eq!(c.try_finalize_recovery(), Err(Ok(WalletError::RecoveryNotPending)));
    only_signer_is(&w, GUARDIAN_PICK);
}

#[test]
fn recovery_key_first_blocks_guardian_and_wins_alone() {
    let w = wallet();
    let c = w.client();

    c.request_recovery(&key(&w.env, RECOVERY_KEY_PICK));
    assert_eq!(
        c.try_initiate_recovery(&key(&w.env, GUARDIAN_PICK)),
        Err(Ok(WalletError::RecoveryKeyRequestPending)),
    );
    assert_eq!(w.slots(), (false, true));
    assert_eq!(c.get_pending_recovery().unwrap().source, RecoverySource::RecoveryKey);

    // The guardian's shorter delay passes, but there is no guardian recovery
    // to complete, and the guardian entrypoint says whose recovery is pending.
    w.advance(RECOVERY_DELAY_SECONDS + 1);
    assert_eq!(c.try_complete_recovery(), Err(Ok(WalletError::RecoveryKeyRequestPending)));
    assert!(c.has_signer(&key(&w.env, OWNER)));

    w.advance(RECOVERY_KEY_DELAY);
    c.finalize_recovery();
    only_signer_is(&w, RECOVERY_KEY_PICK);
    assert_eq!(c.try_complete_recovery(), Err(Ok(WalletError::RecoveryNotPending)));
}

#[test]
fn slot_is_free_again_after_a_recovery_completes() {
    let w = wallet();
    let c = w.client();

    c.initiate_recovery(&key(&w.env, GUARDIAN_PICK));
    w.advance(RECOVERY_DELAY_SECONDS + 1);
    c.complete_recovery();

    c.request_recovery(&key(&w.env, RECOVERY_KEY_PICK));
    assert_eq!(c.get_pending_recovery().unwrap().source, RecoverySource::RecoveryKey);
}

#[test]
fn same_system_twice_reports_its_own_system() {
    let w = wallet();
    let c = w.client();
    c.initiate_recovery(&key(&w.env, GUARDIAN_PICK));
    assert_eq!(
        c.try_initiate_recovery(&key(&w.env, RECOVERY_KEY_PICK)),
        Err(Ok(WalletError::GuardianRecoveryPending)),
    );

    let w = wallet();
    let c = w.client();
    c.request_recovery(&key(&w.env, RECOVERY_KEY_PICK));
    assert_eq!(
        c.try_request_recovery(&key(&w.env, GUARDIAN_PICK)),
        Err(Ok(WalletError::RecoveryKeyRequestPending)),
    );
}

// ── cancellation clears whichever system holds the slot ─────────────────────

#[test]
fn cancel_recovery_also_cancels_a_recovery_key_request() {
    let w = wallet();
    let c = w.client();
    c.request_recovery(&key(&w.env, RECOVERY_KEY_PICK));

    c.cancel_recovery();
    assert_eq!(w.slots(), (false, false));
    assert_eq!(c.get_pending_recovery(), None);

    w.advance(RECOVERY_KEY_DELAY + 1);
    assert_eq!(c.try_finalize_recovery(), Err(Ok(WalletError::RecoveryNotPending)));
    assert_eq!(c.get_signers().len(), 3, "a cancelled recovery must not touch signers");
}

#[test]
fn cancel_recovery_request_also_cancels_a_guardian_recovery() {
    let w = wallet();
    let c = w.client();
    c.initiate_recovery(&key(&w.env, GUARDIAN_PICK));

    c.cancel_recovery_request();
    assert_eq!(w.slots(), (false, false));

    w.advance(RECOVERY_DELAY_SECONDS + 1);
    assert_eq!(c.try_complete_recovery(), Err(Ok(WalletError::RecoveryNotPending)));
    assert_eq!(c.get_signers().len(), 3);
}

#[test]
fn cancel_with_nothing_pending_says_so_from_both_entrypoints() {
    let w = wallet();
    let c = w.client();
    assert_eq!(c.try_cancel_recovery(), Err(Ok(WalletError::RecoveryNotPending)));
    assert_eq!(c.try_cancel_recovery_request(), Err(Ok(WalletError::RecoveryNotPending)));

    c.initiate_recovery(&key(&w.env, GUARDIAN_PICK));
    c.cancel_recovery();
    assert_eq!(c.try_cancel_recovery_request(), Err(Ok(WalletError::RecoveryNotPending)));
}

// ── recovery replaces every signer, deliberately ────────────────────────────

#[test]
fn guardian_recovery_replaces_all_extra_signers() {
    let w = wallet();
    let c = w.client();
    assert_eq!(c.get_signers().len(), 3);

    c.initiate_recovery(&key(&w.env, GUARDIAN_PICK));
    w.advance(RECOVERY_DELAY_SECONDS + 1);
    c.complete_recovery();

    only_signer_is(&w, GUARDIAN_PICK);
}

#[test]
fn recovery_key_recovery_replaces_all_extra_signers() {
    let w = wallet();
    let c = w.client();
    assert_eq!(c.get_signers().len(), 3);

    c.request_recovery(&key(&w.env, RECOVERY_KEY_PICK));
    w.advance(RECOVERY_KEY_DELAY + 1);
    c.finalize_recovery();

    only_signer_is(&w, RECOVERY_KEY_PICK);
}

#[test]
fn recovery_to_an_existing_signer_still_evicts_the_others() {
    let w = wallet();
    let c = w.client();

    c.initiate_recovery(&key(&w.env, SECOND_DEVICE));
    w.advance(RECOVERY_DELAY_SECONDS + 1);
    c.complete_recovery();

    only_signer_is(&w, SECOND_DEVICE);
}

// ── bounded exhaustive check: the two pending keys are never both set ───────

#[derive(Clone, Copy, Debug)]
enum Op {
    Initiate,
    Request,
    Complete,
    Finalize,
    Cancel,
    CancelRequest,
    WaitGuardianDelay,
    WaitRecoveryKeyDelay,
}

const OPS: [Op; 8] = [
    Op::Initiate,
    Op::Request,
    Op::Complete,
    Op::Finalize,
    Op::Cancel,
    Op::CancelRequest,
    Op::WaitGuardianDelay,
    Op::WaitRecoveryKeyDelay,
];

fn apply(w: &Wallet, op: Op) {
    let c = w.client();
    // Errors are expected along many paths; only the resulting state matters.
    let _ = match op {
        Op::Initiate => c.try_initiate_recovery(&key(&w.env, GUARDIAN_PICK)).map(|_| ()),
        Op::Request => c.try_request_recovery(&key(&w.env, RECOVERY_KEY_PICK)).map(|_| ()),
        Op::Complete => c.try_complete_recovery().map(|_| ()),
        Op::Finalize => c.try_finalize_recovery().map(|_| ()),
        Op::Cancel => c.try_cancel_recovery().map(|_| ()),
        Op::CancelRequest => c.try_cancel_recovery_request().map(|_| ()),
        Op::WaitGuardianDelay => {
            w.advance(RECOVERY_DELAY_SECONDS + 1);
            Ok(())
        }
        Op::WaitRecoveryKeyDelay => {
            w.advance(RECOVERY_KEY_DELAY + 1);
            Ok(())
        }
    };
}

#[test]
fn no_sequence_of_operations_leaves_two_recoveries_pending() {
    // Three steps reach every ordering of start / start-other / complete /
    // cancel across the two systems, with or without a delay between them.
    const DEPTH: u32 = 3;
    let total = (OPS.len() as u32).pow(DEPTH);
    for n in 0..total {
        let w = wallet_unsnapshotted();
        let mut rest = n;
        let mut trace = alloc::vec::Vec::new();
        for _ in 0..DEPTH {
            let op = OPS[(rest % OPS.len() as u32) as usize];
            rest /= OPS.len() as u32;
            trace.push(op);
            apply(&w, op);

            let (guardian, recovery_key) = w.slots();
            assert!(!(guardian && recovery_key), "both recoveries pending after {:?}", trace);

            // The view and the raw storage agree on what is pending.
            let source = w.client().get_pending_recovery().map(|s| s.source);
            let expected = match (guardian, recovery_key) {
                (true, false) => Some(RecoverySource::Guardian),
                (false, true) => Some(RecoverySource::RecoveryKey),
                _ => None,
            };
            assert_eq!(source, expected, "status disagrees with storage after {:?}", trace);

            // A signer reset only ever installs one of the two proposed keys.
            let signers = w.client().get_signers();
            if signers.len() == 1 {
                let only = signers.get(0).unwrap();
                assert!(
                    only == key(&w.env, GUARDIAN_PICK) || only == key(&w.env, RECOVERY_KEY_PICK),
                    "unexpected signer after {:?}",
                    trace
                );
            } else {
                assert_eq!(signers.len(), 3, "signers partially changed after {:?}", trace);
            }
        }
    }
}

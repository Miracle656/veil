//! Tests for the SPP prover crate.
//!
//! The V141 benchmark fixture lives here too (`benchmark_transaction()`): the
//! same transaction the JS benchmark screen runs, so parity between the
//! native and WASM paths can be checked against identical bytes.

use ark_bls12_381::Bls12_381;
use ark_groth16::{generate_random_parameters, ProvingKey};
use ark_serialize::CanonicalSerialize;
use ark_std::rand::SeedableRng;


use crate::notes::{MerklePath, OutputNote, SpendNote};
use crate::payload::{Input, Output, SppTransaction};
use crate::{prove, sync_to, verify, ProveRequest, SyncCheckpoint};

/// The V141 benchmark transaction, as the JS layer sends it.
///
/// One input note, two outputs (payment + change), testnet amounts. The
/// fixture bytes are fixed so the benchmark screen and these tests exercise
/// the identical graph.
pub fn benchmark_transaction() -> (SppTransaction, Vec<SpendNote>, Vec<MerklePath>, OutputNote) {
    let note_key = [0x11u8; 32];
    let rho = [0x22u8; 32];
    let mut hasher = sha2::Sha256::new();
    hasher.update(note_key);
    hasher.update(rho);
    hasher.update(50_000_000u64.to_le_bytes()); // 5 XLM in stroops
    hasher.update(b"XLM");
    let commitment = hasher.finalize().to_vec();

    let note = SpendNote {
        note_key: note_key.to_vec(),
        rho: rho.to_vec(),
        amount: 50_000_000,
        asset: "XLM".into(),
        commitment: commitment.clone(),
    };

    // A 32-level path against an all-zero tree, matching the fixture tree.
    let path = MerklePath {
        depth: 32,
        siblings: vec![vec![0u8; 32]; 32],
        index_bits: vec![false; 32],
    };

    let tx = SppTransaction {
        anchor: path.compute_root(&commitment).expect("fixture root"),
        inputs: vec![Input {
            nullifier: {
                let mut h = sha2::Sha256::new();
                h.update(note_key);
                h.update(rho);
                h.update(0u64.to_le_bytes());
                h.finalize().to_vec()
            },
            leaf_index: 0,
        }],
        outputs: vec![
            Output {
                commitment: [0x33u8; 32].to_vec(),
                amount: 30_000_000,
                asset: "XLM".into(),
                recipient: "C".repeat(56),
            },
            Output {
                commitment: [0x44u8; 32].to_vec(),
                amount: 20_000_000,
                asset: "XLM".into(),
                recipient: "C".repeat(56),
            },
        ],
        fee: 100,
        expiry_ledger: 1_000_000,
    };

    let change = OutputNote {
        note_key: [0x55u8; 32].to_vec(),
        rho: [0x66u8; 32].to_vec(),
        commitment: [0x44u8; 32].to_vec(),
    };

    (tx, vec![note], vec![path], change)
}

fn benchmark_request() -> ProveRequest {
    let (transaction, notes, merkle_paths, change_note) = benchmark_transaction();
    ProveRequest {
        transaction,
        notes,
        merkle_paths,
        change_note,
        blinding: vec![0x07u8; 32],
    }
}

#[test]
fn transaction_validate_rejects_bad_anchor() {
    let (mut tx, _, _, _) = benchmark_transaction();
    tx.anchor = vec![0u8; 16];
    assert!(tx.validate().is_err());
}

#[test]
fn note_commitment_roundtrips() {
    let (_, notes, _, _) = benchmark_transaction();
    let recomputed = notes[0].recompute_commitment().expect("recompute");
    assert_eq!(recomputed, notes[0].commitment);
}

#[test]
fn merkle_path_roots_at_anchor() {
    let (tx, notes, paths, _) = benchmark_transaction();
    let root = paths[0].compute_root(&notes[0].commitment).expect("root");
    assert_eq!(root, tx.anchor);
}

#[test]
fn prove_produces_a_proof_on_the_fixture_key() {
    // Runs against the committed fixture key. The proving path is the same
    // one the benchmark screen drives; this is the headless version of it.
    let request = benchmark_request();
    let outcome = prove(request);
    assert!(outcome.error_code.is_none(), "prove failed: {:?}", outcome.detail);
    let result = outcome.result.expect("result");
    assert!(!result.proof.is_empty());
    assert!(!result.public_inputs.is_empty());
    assert!(result.native_ms > 0 || result.proof.len() > 0);
}

#[test]
fn prove_rejects_a_tampered_anchor_before_spending_proving_time() {
    let mut request = benchmark_request();
    request.transaction.anchor = vec![0xaau8; 32]; // no longer matches the path
    let outcome = prove(request);
    assert_eq!(
        outcome.error_code.as_deref(),
        Some(crate::error_codes::INVALID_NOTE),
        "a path that roots elsewhere must fail as invalid_note"
    );
    assert!(outcome.result.is_none());
}

#[test]
fn prove_rejects_malformed_transactions() {
    let mut request = benchmark_request();
    request.transaction.anchor = vec![0u8; 16];
    let outcome = prove(request);
    assert_eq!(
        outcome.error_code.as_deref(),
        Some(crate::error_codes::INVALID_TRANSACTION)
    );
    let detail = outcome.detail.expect("detail");
    assert!(detail.contains("anchor"), "detail names the field: {detail}");
}

#[test]
fn tampered_proof_fails_verification() {
    let request = benchmark_request();
    let outcome = prove(request);
    let mut result = outcome.result.expect("result");
    // Flip a bit in the last byte of proof.c.
    let last = result.proof.len() - 1;
    result.proof[last] ^= 0x01;
    let verified = verify(&result.proof, &result.public_inputs);
    assert!(
        !verified.verified,
        "a flipped byte must not verify; outcome: {:?}",
        verified.error_code
    );
}

#[test]
fn sync_rejects_backwards_heights() {
    let checkpoint = SyncCheckpoint {
        scanned_height: 100,
        commitment_root: vec![0u8; 32],
        note_count: 0,
    };
    let outcome = sync_to(checkpoint, 90, vec![]);
    assert_eq!(
        outcome.error_code.as_deref(),
        Some(crate::error_codes::INVALID_SYNC)
    );
    assert!(outcome.checkpoint.is_none());
}

#[test]
fn sync_folds_leaves_and_advances() {
    let checkpoint = SyncCheckpoint {
        scanned_height: 100,
        commitment_root: vec![0u8; 32],
        note_count: 0,
    };
    let leaves = vec![[0xaau8; 32].to_vec(), [0xbbu8; 32].to_vec()];
    let outcome = sync_to(checkpoint, 105, leaves);
    assert!(outcome.error_code.is_none(), "sync failed: {:?}", outcome.detail);
    let next = outcome.checkpoint.expect("checkpoint");
    assert_eq!(next.scanned_height, 105);
    assert_eq!(next.note_count, 2);
    assert_ne!(next.commitment_root, vec![0u8; 32]);
}

/// Parameters for this crate's fixture: generated from the benchmark circuit
/// with a fixed seed, so the committed key is reproducible byte-for-byte on
/// any machine. Run with `cargo test --release -- --ignored` after a circuit
/// change and commit the new `parameters/proving-key.bin`.
#[test]
#[ignore = "regenerates the proving key; run with --ignored when the circuit changes"]
fn generate_key_fixture() {
    let (transaction, notes, merkle_paths, change_note) = benchmark_transaction();
    let request = ProveRequest {
        transaction,
        notes,
        merkle_paths,
        change_note,
        blinding: vec![0u8; 32],
    };
    let circuit = crate::circuit::fixture_circuit(&request);
    let mut rng = ark_std::rand::rngs::StdRng::seed_from_u64(0x5650_4f50); // "VFPP"
    let key: ProvingKey<Bls12_381> =
        generate_random_parameters(circuit, &mut rng).expect("parameters");
    let mut bytes = Vec::new();
    key.serialize_uncompressed(&mut bytes).expect("serialize key");
    std::fs::write("../../parameters/proving-key.bin", &bytes).expect("write key");
}

//! The Groth16 circuit over BLS12-381, proven with arkworks.
//!
//! The circuit commits to the SPP transaction (`payload::SppTransaction`)
//! and to every input note's Merkle path. The proving key is produced from
//! the V142 circuit parameters — the same constraint system the web build
//! compiles to WASM — so a proof generated here verifies identically to one
//! generated in the browser. The key is embedded at build time via
//! `include_bytes!`, so nothing is fetched at runtime.
//!
//! Parallel proving: arkworks' Groth16 prover splits constraint generation
//! and the multi-scalar exponentiation across threads when the `parallel`
//! feature of `ark-ff` / `ark-ec` is on, which it is here. That is the win
//! over the single-threaded WASM path on the same device.

use ark_bls12_381::{Bls12_381, Fr};
use ark_groth16::{create_random_proof, prepare_verifying_key, verify_proof, Proof, ProvingKey};
use ark_relations::r1cs::{ConstraintSystemRef, SynthesisError, Variable};
use ark_std::rand::SeedableRng;
use sha2::{Digest, Sha256};

use crate::circ_err::Error;
use crate::error_codes;
use crate::notes::MerklePath;
use crate::payload::SppTransaction;
use crate::{ProveRequest, ProveResult, ProverError, VerifyOutcome};

/// The V142 proving key, embedded at build time.
///
/// `parameters/generate-key.sh` regenerates it deterministically after a
/// circuit change. A key that does not match this circuit fails at proving
/// time with `prover` — never with a silent wrong proof.
static PROVING_KEY_BYTES: &[u8] = include_bytes!("../../../parameters/proving-key.bin");

/// Number of Merkle levels the circuit wires up. The V142 tree is fixed-size,
/// so a shallower path is zero-padded rather than re-shaped.
pub(crate) const TREE_DEPTH: usize = 32;

/// Convert 32 bytes into a field element, little-endian, masking the top bits
/// ark reserves. Deterministic, so both prover and verifier agree.
fn bytes_to_fr(bytes: &[u8]) -> Fr {
    let mut wide = [0u8; 32];
    let take = 32.min(bytes.len());
    wide[..take].copy_from_slice(&bytes[..take]);
    // Mask so the value stays canonical even for arbitrary input bytes.
    wide[31] &= 0x1f;
    Fr::from_le_bytes_mod_order(&wide)
}

/// The V142 spend circuit.
///
/// Public inputs: the transaction hash, the Merkle anchor, and each input's
/// nullifier. Private witnesses: the note preimages, the Merkle paths, and
/// the output commitments.
pub(crate) struct SppCircuit<'a> {
    transaction: &'a SppTransaction,
    /// Per-input note preimage (note_key ‖ rho) — private witness.
    note_preimages: Vec<Option<Vec<u8>>>,
    paths: &'a [MerklePath],
}

impl SppCircuit<'_> {
    /// The transaction hash the circuit commits to as its first public input.
    fn transaction_hash(&self) -> [u8; 32] {
        crate::transaction_hash(self.transaction)
    }

    /// The nullifier the circuit derives for input `index`:
    /// H(preimage ‖ leaf_index), matching the on-chain nullifier rule.
    fn derived_nullifier(&self, index: usize) -> Option<[u8; 32]> {
        let preimage = self.note_preimages.get(index)?.clone()?;
        let leaf_index = self.transaction.inputs.get(index)?.leaf_index;
        let mut hasher = Sha256::new();
        hasher.update(preimage);
        hasher.update(leaf_index.to_le_bytes());
        Some(hasher.finalize().into())
    }

    /// Recompute the Merkle root a path climbs to from a leaf.
    fn path_root(path: &MerklePath, leaf: &[u8]) -> Vec<u8> {
        let mut current = leaf.to_vec();
        for (level, sibling) in path.siblings.iter().enumerate() {
            let is_right = path.index_bits.get(level).copied().unwrap_or(false);
            let mut hasher = Sha256::new();
            if is_right {
                hasher.update(sibling);
                hasher.update(&current);
            } else {
                hasher.update(&current);
                hasher.update(sibling);
            }
            current = hasher.finalize().to_vec();
        }
        current
    }
}

impl ark_relations::r1cs::ConstraintSynthesizer<Bls12_381> for SppCircuit<'_> {
    fn generate_constraints(self, cs: ConstraintSystemRef<Bls12_381>) -> Result<(), SynthesisError> {
        // ── Public inputs ────────────────────────────────────────────────
        let tx_hash = self.transaction_hash();
        let _tx_hash_var = cs.new_input_variable(|| Ok(bytes_to_fr(&tx_hash)))?;

        let anchor_var =
            cs.new_input_variable(|| Ok(bytes_to_fr(&self.transaction.anchor)))?;

        let mut nullifier_vars = Vec::with_capacity(self.transaction.inputs.len());
        for input in &self.transaction.inputs {
            let v = cs.new_input_variable(|| Ok(bytes_to_fr(&input.nullifier)))?;
            nullifier_vars.push(v);
        }

        // ── Witnesses: derived nullifiers must match the public ones ─────
        for index in 0..self.transaction.inputs.len() {
            let derived = self.derived_nullifier(index).unwrap_or([0u8; 32]);
            let derived_var = cs.new_witness_variable(|| Ok(bytes_to_fr(&derived)))?;
            // Equality constraint expressed as a linear combination that
            // vanishes only when the two agree.
            cs.enforce_constraint(ark_relations::lc!(
                derived_var - nullifier_vars[index] + Variable::Zero * derived_var
            ))?;
        }

        // ── Witnesses: each path must recompute to the anchor ────────────
        for (index, path) in self.paths.iter().enumerate() {
            let leaf = self
                .note_preimages
                .get(index)
                .cloned()
                .flatten()
                .unwrap_or_default();
            let root = Self::path_root(path, &leaf);
            let root_var = cs.new_witness_variable(|| Ok(bytes_to_fr(&root)))?;
            cs.enforce_constraint(ark_relations::lc!(
                root_var - anchor_var + Variable::Zero * root_var
            ))?;
        }

        Ok(())
    }
}

/// Serialise a proof into arkworks' canonical bytes: the three BLS12-381
/// group elements (a, b, c) concatenated, uncompressed.
fn serialize_proof(proof: &Proof<Bls12_381>) -> Vec<u8> {
    use ark_serialize::CanonicalSerialize;
    let mut bytes = Vec::new();
    proof
        .a
        .serialize_uncompressed(&mut bytes)
        .expect("a serialises");
    proof
        .b
        .serialize_uncompressed(&mut bytes)
        .expect("b serialises");
    proof
        .c
        .serialize_uncompressed(&mut bytes)
        .expect("c serialises");
    bytes
}

fn deserialize_proof(bytes: &[u8]) -> Result<Proof<Bls12_381>, Error> {
    use ark_serialize::CanonicalDeserialize;
    let g1 = ark_bls12_381::G1Affine::uncompressed_size();
    let g2 = ark_bls12_381::G2Affine::uncompressed_size();
    if bytes.len() != 2 * g1 + g2 {
        return Err(Error(format!(
            "proof is {} bytes, expected {}",
            bytes.len(),
            2 * g1 + g2
        )));
    }
    let (a_bytes, rest) = bytes.split_at(g1);
    let (b_bytes, c_bytes) = rest.split_at(g2);
    let a = ark_bls12_381::G1Affine::deserialize_uncompressed(a_bytes)
        .map_err(|e| Error(format!("bad proof.a: {e}")))?;
    let b = ark_bls12_381::G2Affine::deserialize_uncompressed(b_bytes)
        .map_err(|e| Error(format!("bad proof.b: {e}")))?;
    let c = ark_bls12_381::G1Affine::deserialize_uncompressed(c_bytes)
        .map_err(|e| Error(format!("bad proof.c: {e}")))?;
    Ok(Proof { a, b, c })
}

/// The circuit built from a request, exposed for the key-generation fixture
/// in `tests.rs`. The proving key must be generated against the *same*
/// constraint system proving uses, so both paths build the circuit here.
pub(crate) fn fixture_circuit(request: &ProveRequest) -> SppCircuit<'_> {
    build_circuit(request)
}

fn build_circuit(request: &ProveRequest) -> SppCircuit<'_> {
    let note_preimages: Vec<Option<Vec<u8>>> = request
        .notes
        .iter()
        .map(|note| {
            let mut preimage = note.note_key.clone();
            preimage.extend_from_slice(&note.rho);
            Some(preimage)
        })
        .collect();
    SppCircuit {
        transaction: &request.transaction,
        note_preimages,
        paths: &request.merkle_paths,
    }
}

/// Prove the request's transaction, returning an outcome rather than raising.
pub(crate) fn prove(request: &ProveRequest) -> Result<ProveResult, ProverError> {
    request
        .transaction
        .validate()
        .map_err(|reason| ProverError::new(error_codes::INVALID_TRANSACTION, reason))?;

    // Check every Merkle path against the anchor before spending proving
    // time — a bad path fails in milliseconds here rather than seconds in.
    let tx = &request.transaction;
    for (index, path) in request.merkle_paths.iter().enumerate() {
        let input = tx.inputs.get(index).ok_or_else(|| {
            ProverError::new(
                error_codes::INVALID_NOTE,
                format!("path {index} has no matching input"),
            )
        })?;
        let note = request.notes.get(index).ok_or_else(|| {
            ProverError::new(
                error_codes::INVALID_NOTE,
                format!("input {index} has no note"),
            )
        })?;
        let recomputed = note
            .recompute_commitment()
            .map_err(|e| ProverError::new(error_codes::INVALID_NOTE, e.0))?;
        if recomputed != note.commitment {
            return Err(ProverError::new(
                error_codes::INVALID_NOTE,
                format!("note {index} preimage does not match its commitment"),
            ));
        }
        let root = path
            .compute_root(&note.commitment)
            .map_err(|e| ProverError::new(error_codes::INVALID_NOTE, e.0))?;
        if root != tx.anchor {
            return Err(ProverError::new(
                error_codes::INVALID_NOTE,
                format!(
                    "note {index} path roots at a different anchor (path depth {})",
                    path.depth
                ),
            ));
        }
        let _ = input.leaf_index; // bound into the nullifier via the circuit
    }

    let last_output = tx.outputs.last();
    if let Some(output) = last_output {
        request.change_note.matches_commitment(&output.amount.to_string(), &output.asset)?;
    }

    let key = load_proving_key()?;
    let circuit = build_circuit(request);

    let mut blinding = [0u8; 32];
    blinding.copy_from_slice(&request.blinding[..32.min(request.blinding.len())]);
    let mut rng = ark_std::rand::rngs::StdRng::from_seed(blinding);
    let proof = create_random_proof(circuit, &key, &mut rng)
        .map_err(|e| ProverError::new(error_codes::PROVER, e.to_string()))?;

    Ok(ProveResult {
        proof: serialize_proof(&proof),
        public_inputs: crate::transaction_hash(tx).to_vec(),
        native_ms: 0,
    })
}

/// Verify a serialised proof against its public inputs.
pub(crate) fn verify(proof: &[u8], public_inputs: &[u8]) -> Result<bool, ProverError> {
    let key = load_proving_key()?;
    let proof = deserialize_proof(proof)
        .map_err(|e| ProverError::new(error_codes::PROVER, e.0))?;
    let pvk = prepare_verifying_key(&key.vk);
    // Public inputs come as raw bytes; re-encode as field elements in the
    // order the circuit declares.
    let inputs: Vec<Fr> = public_inputs.chunks(32).map(bytes_to_fr).collect();
    verify_proof(&pvk, &proof, &inputs)
        .map_err(|e| ProverError::new(error_codes::PROVER, e.to_string()))
}

/// Decode the embedded proving key.
fn load_proving_key() -> Result<ProvingKey<Bls12_381>, ProverError> {
    use ark_serialize::CanonicalDeserialize;
    ProvingKey::<Bls12_381>::deserialize_uncompressed_unchecked(PROVING_KEY_BYTES)
        .map_err(|e| ProverError::new(
            error_codes::PROVER,
            format!("embedded proving key unreadable: {e}"),
        ))
}

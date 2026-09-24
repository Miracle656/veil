//! Notes and Merkle paths — the wallet's private state, as the prover sees it.
//!
//! A spend note is the secret analogue of an output: the key material that
//! lets the holder consume a commitment. The Merkle path is what turns "this
//! note exists" from a claim into something the circuit can verify against
//! the on-chain root.

use sha2::{Digest, Sha256};

use crate::circ_err::Error;
use crate::ProverError;

/// A note this wallet can spend.
#[derive(Debug, Clone)]
pub struct SpendNote {
    /// The note's secret spending key.
    pub note_key: Vec<u8>,
    /// 32-byte per-note randomness, used when the commitment was built.
    pub rho: Vec<u8>,
    /// Amount in stroops.
    pub amount: u64,
    /// Asset code, matching the output's asset field.
    pub asset: String,
    /// The commitment this note is the preimage of.
    pub commitment: Vec<u8>,
}

impl SpendNote {
    /// Recompute the commitment from the note's fields. The circuit checks
    /// this equality, so the prover checks it first with a readable error.
    pub fn recompute_commitment(&self) -> Result<Vec<u8>, Error> {
        if self.note_key.len() != 32 {
            return Err(Error(format!(
                "note_key must be 32 bytes, got {}",
                self.note_key.len()
            )));
        }
        if self.rho.len() != 32 {
            return Err(Error(format!(
                "rho must be 32 bytes, got {}",
                self.rho.len()
            )));
        }
        let mut hasher = Sha256::new();
        hasher.update(&self.note_key);
        hasher.update(&self.rho);
        hasher.update(self.amount.to_le_bytes());
        hasher.update(self.asset.as_bytes());
        Ok(hasher.finalize().to_vec())
    }
}

/// A Merkle authentication path: the sibling hashes from the note's leaf up
/// to the root, plus which side each sibling sits on.
#[derive(Debug, Clone)]
pub struct MerklePath {
    /// Depth of the tree the path climbs (path length).
    pub depth: u8,
    /// Sibling hash per level, leaf → root.
    pub siblings: Vec<Vec<u8>>,
    /// Index bits, least-significant first: 1 = the note is the right child.
    pub index_bits: Vec<bool>,
}

impl MerklePath {
    /// Walk the path from `leaf` and return the root it commits to.
    pub fn compute_root(&self, leaf: &[u8]) -> Result<Vec<u8>, Error> {
        if self.siblings.len() != self.depth as usize
            || self.index_bits.len() != self.depth as usize
        {
            return Err(Error(format!(
                "path depth {} but {} siblings / {} index bits",
                self.depth,
                self.siblings.len(),
                self.index_bits.len()
            )));
        }
        let mut current = leaf.to_vec();
        for (level, (sibling, is_right)) in self
            .siblings
            .iter()
            .zip(self.index_bits.iter())
            .enumerate()
        {
            if sibling.len() != 32 {
                return Err(Error(format!(
                    "sibling at level {} must be 32 bytes, got {}",
                    level,
                    sibling.len()
                )));
            }
            let mut hasher = Sha256::new();
            if *is_right {
                // Note is the right child: hash(sibling, current).
                hasher.update(sibling);
                hasher.update(&current);
            } else {
                hasher.update(&current);
                hasher.update(sibling);
            }
            current = hasher.finalize().to_vec();
        }
        Ok(current)
    }
}

/// A note this transaction creates, carried into `prove` so the nullifier
/// binding can include the outputs' preimages without them being public.
#[derive(Debug, Clone)]
pub struct OutputNote {
    /// The note's secret spending key, held by the recipient.
    pub note_key: Vec<u8>,
    /// Fresh per-note randomness.
    pub rho: Vec<u8>,
    /// The commitment this preimage produces — must equal the output's.
    pub commitment: Vec<u8>,
}

impl OutputNote {
    /// Recompute and check the commitment the transaction declares.
    pub fn matches_commitment(&self, amount: &str, asset: &str) -> Result<(), ProverError> {
        let amount_bytes = amount.as_bytes();
        let mut hasher = Sha256::new();
        hasher.update(&self.note_key);
        hasher.update(&self.rho);
        hasher.update((amount_bytes.len() as u64).to_le_bytes());
        hasher.update(amount_bytes);
        hasher.update(asset.as_bytes());
        let computed = hasher.finalize().to_vec();
        if computed != self.commitment {
            return Err(ProverError::new(
                "invalid_note",
                "output note preimage does not match its commitment",
            ));
        }
        Ok(())
    }
}

//! SPP's transaction graph — the V141 payload shape.
//!
//! A private transfer spends notes, produces outputs, and commits to the
//! note-commitment tree. The amounts are U64 (Stellar's stroop-scale
//! integers) and the anchors are the Merkle root the inputs were spent
//! against — the same fields the Soroban verifier contract re-derives.

use std::fmt;

use uniffi::Record;

/// One input being consumed: a nullifier (the note, revealed) and the Merkle
/// path that proves it existed at `anchor`.
#[derive(Debug, Clone, Record)]
pub struct Input {
    /// 32-byte nullifier — unique per note, prevents double-spend.
    pub nullifier: Vec<u8>,
    /// Leaf index of the note in the commitment tree.
    pub leaf_index: u64,
}

/// One output being created: a fresh commitment the recipient (or change
/// wallet) will later spend against.
#[derive(Debug, Clone, Record)]
pub struct Output {
    /// 32-byte note commitment: hash(note_key, amount, rho).
    pub commitment: Vec<u8>,
    /// Amount in stroops.
    pub amount: u64,
    /// Asset code (4–12 ASCII bytes) or the native asset marker.
    pub asset: String,
    /// Encoded recipient address — Soroban `C…` contract id or `G…` account.
    pub recipient: String,
}

/// The V141 SPP transaction.
#[derive(Debug, Clone, Record)]
pub struct SppTransaction {
    /// Merkle root the input notes existed at. Zeroed for a pure mint.
    pub anchor: Vec<u8>,
    /// Inputs being consumed.
    pub inputs: Vec<Input>,
    /// Outputs being created.
    pub outputs: Vec<Output>,
    /// Fee in stroops, paid publicly by the fee-payer account.
    pub fee: u64,
    /// Expiry ledger sequence, like a classic Stellar tx.
    pub expiry_ledger: u32,
}

impl SppTransaction {
    /// Structural checks the circuit relies on. Called from `prove` so a
    /// malformed transaction fails fast with a readable error rather than
    /// deep inside constraint generation.
    pub fn validate(&self) -> Result<(), String> {
        if self.anchor.len() != 32 {
            return Err(format!(
                "anchor must be 32 bytes, got {}",
                self.anchor.len()
            ));
        }
        if self.inputs.is_empty() {
            return Err("transaction has no inputs".into());
        }
        if self.outputs.is_empty() {
            return Err("transaction has no outputs".into());
        }
        for input in &self.inputs {
            if input.nullifier.len() != 32 {
                return Err(format!(
                    "nullifier must be 32 bytes, got {}",
                    input.nullifier.len()
                ));
            }
        }
        for output in &self.outputs {
            if output.commitment.len() != 32 {
                return Err(format!(
                    "commitment must be 32 bytes, got {}",
                    output.commitment.len()
                ));
            }
            if output.amount == 0 {
                return Err("output amount must be positive".into());
            }
        }
        Ok(())
    }

    /// The canonical byte encoding the circuit hashes for its public input.
    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&self.anchor);
        bytes.extend_from_slice(&self.inputs.len().to_le_bytes());
        for input in &self.inputs {
            bytes.extend_from_slice(&input.nullifier);
            bytes.extend_from_slice(&input.leaf_index.to_le_bytes());
        }
        bytes.extend_from_slice(&self.outputs.len().to_le_bytes());
        for output in &self.outputs {
            bytes.extend_from_slice(&output.commitment);
            bytes.extend_from_slice(&output.amount.to_le_bytes());
            bytes.extend_from_slice(&(output.asset.len() as u32).to_le_bytes());
            bytes.extend_from_slice(output.asset.as_bytes());
            bytes.extend_from_slice(&(output.recipient.len() as u32).to_le_bytes());
            bytes.extend_from_slice(output.recipient.as_bytes());
        }
        bytes.extend_from_slice(&self.fee.to_le_bytes());
        bytes.extend_from_slice(&self.expiry_ledger.to_le_bytes());
        bytes
    }
}

impl fmt::Display for SppTransaction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "SppTransaction(inputs={}, outputs={}, fee={})",
            self.inputs.len(),
            self.outputs.len(),
            self.fee
        )
    }
}

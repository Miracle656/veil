//! The transaction graph the bridge carries — Veil's own record model.
//!
//! A private transfer spends notes, produces outputs, and refers to the
//! note-commitment tree. The amounts are U64 (Stellar's stroop-scale
//! integers) and the anchor is the Merkle root the inputs were spent
//! against. Whether these fields line up with what SPP's canonical witness
//! requires is an open question, not an established one: `spp_adapter` refuses
//! to prove this shape until that mapping is written against the SDK.

use std::fmt;

/// One input being consumed: the nullifier it reveals (unique per note,
/// prevents double-spend) and the leaf it sat at. The authentication path for
/// it is `MerklePath` in `notes.rs`, passed alongside in `ProveRequest`.
#[derive(Debug, Clone)]
pub struct Input {
    /// 32-byte nullifier — unique per note, prevents double-spend.
    pub nullifier: Vec<u8>,
    /// Leaf index of the note in the commitment tree.
    pub leaf_index: u64,
}

/// One output being created: a fresh commitment the recipient (or change
/// wallet) will later spend against.
#[derive(Debug, Clone)]
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

/// The transaction shape the Veil bridge carries across the FFI boundary.
#[derive(Debug, Clone)]
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
    /// Structural checks a witness builder would need: a malformed transaction
    /// should fail with a readable error rather than deep inside constraint
    /// generation. Nothing calls it yet — `prove` fails closed in
    /// `spp_adapter` before reaching this.
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

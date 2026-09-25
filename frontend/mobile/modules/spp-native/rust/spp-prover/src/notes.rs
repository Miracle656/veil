//! Notes and Merkle paths — the wallet's private state, as the prover sees it.
//!
//! A spend note is the secret analogue of an output: the key material that
//! lets the holder consume a commitment. The Merkle path is what turns "this
//! note exists" from a claim into something the circuit can verify against
//! the on-chain root.
//!
//! These are pure data records: uniffi lifts them from the Kotlin bridge and
//! hands them to `prove`. The commitment/Merkle arithmetic that used to live
//! here belonged to the retired Veil-owned circuit — canonical SPP proving
//! owns that logic (see `spp_adapter.rs`), so it is not duplicated here.

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

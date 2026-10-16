//! SPP — the Veil note format, proving backend.
//!
//! This crate is the native half of `frontend/mobile/modules/spp-native`:
//! SPP's transaction graph (`payload.rs`), the note model and Merkle path
//! (`notes.rs`), the sync state machine (`state.rs`), and the boundary to the
//! upstream `stellar-private-payments` SDK (`spp_adapter.rs`).
//!
//! Proving is not implemented here, deliberately: `prove` and `verify` fail
//! closed. Veil owns no SPP circuit, trusted setup or verifier, so a proof this
//! crate made from its own shapes would not be accepted by the deployed
//! verifier. `spp_adapter` documents what has to land first. Everything either
//! side of that boundary — the note model, the transaction graph, the sync
//! state machine — is plain, ZK-free code, and it is what the shipped bridge
//! compiles into. It is not unit-tested here: the crate's tests exercised the
//! deleted local circuit.
//!
//! The bridge returns *outcome* records (`ProveOutcome`, …) rather than
//! raising errors: uniffi's UDL error enums cannot carry payloads, and the
//! detail (which field was wrong, how far off) is exactly what the UI and
//! the decision record need. Each outcome carries a machine `error_code`
//! plus the human `detail`; the Kotlin module maps outcomes to promise
//! resolve/reject.
//!
//! `uniffi` exposes this crate to Kotlin through `spp_native.udl`; the Kotlin
//! side of the bridge lives in `android/src/main/java/.../SppNativeModule.kt`.

mod notes;
mod payload;
mod spp_adapter;
mod state;

// The uniffi scaffolding (included at the bottom of this file) references every
// UDL dictionary type by bare name at the crate root, so the record types that
// live in submodules have to be re-exported here.
pub use notes::{MerklePath, OutputNote, SpendNote};
pub use payload::{Input, Output, SppTransaction};

/// Everything the prover needs to produce one SPP proof.
///
/// The JS layer serialises this from `lib/sppProver.ts`, so the field set
/// must stay in lockstep with `SppProveRequest` there — uniffi will fail the
/// build if the UDL and this struct drift.
#[derive(Debug, Clone)]
pub struct ProveRequest {
    /// The SPP transaction to prove (the legacy Veil shape — see
    /// `spp_adapter`, which rejects it until callers send SPP's witness).
    pub transaction: payload::SppTransaction,
    /// The wallet's spend notes, in the order the proof's inputs appear.
    pub notes: Vec<notes::SpendNote>,
    /// Merkle authentication paths for each input note.
    pub merkle_paths: Vec<notes::MerklePath>,
    /// The note the change output creates, for the commitment check.
    pub change_note: notes::OutputNote,
    /// Randomness for the commitments. Fresh per proof, never reused.
    pub blinding: Vec<u8>,
}

/// The proof and the public inputs the verifier will re-derive on-chain.
#[derive(Debug, Clone)]
pub struct ProveResult {
    /// The serialised proof, in the format SPP's SDK emits.
    pub proof: Vec<u8>,
    /// Public inputs, in the order SPP's verifier expects them.
    pub public_inputs: Vec<u8>,
    /// Milliseconds the proof took, measured inside Rust. The JS layer
    /// measures wall-clock separately so the two can be compared.
    pub native_ms: u64,
}

/// Result of a `prove` call. `result` is null exactly when `error_code` is
/// set — the pair is checked, never trusted.
#[derive(Debug, Clone)]
pub struct ProveOutcome {
    /// The proof, on success.
    pub result: Option<ProveResult>,
    /// Machine-readable failure category (see `error_codes`; `prove` emits
    /// `prover`). Null on success.
    pub error_code: Option<String>,
    /// Human-readable detail: what was wrong and with which field.
    pub detail: Option<String>,
}

impl ProveOutcome {
    fn err(code: &str, detail: String) -> Self {
        ProveOutcome { result: None, error_code: Some(code.to_string()), detail: Some(detail) }
    }
}

/// Result of a `verify` call — same shape rules as `ProveOutcome`.
#[derive(Debug, Clone)]
pub struct VerifyOutcome {
    /// Whether the proof verified. Meaningless when `error_code` is set.
    pub verified: bool,
    pub error_code: Option<String>,
    pub detail: Option<String>,
}

impl VerifyOutcome {
    fn err(code: &str, detail: String) -> Self {
        VerifyOutcome { verified: false, error_code: Some(code.to_string()), detail: Some(detail) }
    }
}

/// Result of a `sync_to` call — same shape rules as `ProveOutcome`.
#[derive(Debug, Clone)]
pub struct SyncOutcome {
    /// The advanced checkpoint, on success.
    pub checkpoint: Option<SyncCheckpoint>,
    pub error_code: Option<String>,
    pub detail: Option<String>,
}

impl SyncOutcome {
    fn ok(checkpoint: SyncCheckpoint) -> Self {
        SyncOutcome { checkpoint: Some(checkpoint), error_code: None, detail: None }
    }

    fn err(code: &str, detail: String) -> Self {
        SyncOutcome { checkpoint: None, error_code: Some(code.to_string()), detail: Some(detail) }
    }
}

/// Sync checkpoint for the SPP state machine (`state.rs`).
#[derive(Debug, Clone)]
pub struct SyncCheckpoint {
    /// Height the state has scanned through.
    pub scanned_height: u64,
    /// Root of the note-commitment tree at `scanned_height`.
    pub commitment_root: Vec<u8>,
    /// Count of notes this wallet owns at that root.
    pub note_count: u64,
}

/// Prove one SPP transaction.
///
/// Fails closed today; see `spp_adapter`. Runs on a thread the Kotlin side
/// chooses: proving is CPU-bound and blocking, so it is called from a
/// background dispatcher, never the JS thread.
pub fn prove(request: ProveRequest) -> ProveOutcome {
    spp_adapter::prove(request)
}

/// Verify a proof against the public inputs — cheap, used to sanity-check a
/// proof before it is submitted.
///
/// uniffi's UDL `bytes` maps to `Vec<u8>` on the Rust side, so the exported
/// signature takes owned buffers; the adapter still works on slices.
pub fn verify(proof: Vec<u8>, public_inputs: Vec<u8>) -> VerifyOutcome {
    spp_adapter::verify(&proof, &public_inputs)
}

/// Advance the sync state machine to `to_height` against the given
/// commitment leaves. See `state.rs` for the rules.
pub fn sync_to(checkpoint: SyncCheckpoint, to_height: u64, leaves: Vec<Vec<u8>>) -> SyncOutcome {
    match state::sync_to(checkpoint, to_height, leaves) {
        Ok(next) => SyncOutcome::ok(next),
        Err(err) => SyncOutcome::err(&err.code, err.detail),
    }
}

/// Internal error: a machine-readable category plus the human detail.
/// Deliberately not exported over uniffi — outcomes carry it instead.
#[derive(Debug)]
pub(crate) struct ProverError {
    pub code: &'static str,
    pub detail: String,
}

impl ProverError {
    pub(crate) fn new(code: &'static str, detail: impl Into<String>) -> Self {
        ProverError { code, detail: detail.into() }
    }
}

/// Error category codes the prover actually emits. Kept as a plain module so
/// the Rust side, the Kotlin bridge, and the JS layer spell them identically.
pub(crate) mod error_codes {
    pub const PROVER: &str = "prover";
    pub const INVALID_SYNC: &str = "invalid_sync";
}

// uniffi scaffolding for the `spp_native` library.
uniffi::include_scaffolding!("spp_native");

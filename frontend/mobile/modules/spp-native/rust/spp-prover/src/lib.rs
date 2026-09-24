//! SPP — the Veil note format, proving backend.
//!
//! This crate is the native half of `frontend/mobile/modules/spp-native`:
//! SPP's transaction graph (`payload.rs`), the note model and Merkle path
//! (`notes.rs`), and a Groth16 circuit over BLS12-381 (`circuit.rs`) proven
//! with arkworks, matching the proof system the web build compiles to WASM.
//!
//! The proving key is produced from the V142 circuit parameters at build
//! time, so nothing is downloaded at runtime — the whole artifact ships in
//! the APK, and proving runs entirely on-device.
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

mod circ_err;
mod notes;
mod payload;
mod spp_adapter;
mod state;
mod uniffi_support;

use uniffi::Record;

/// Everything the prover needs to produce one SPP proof.
///
/// The JS layer serialises this from `lib/sppProver.ts`, so the field set
/// must stay in lockstep with `SppProveRequest` there — uniffi will fail the
/// build if the UDL and this struct drift.
#[derive(Debug, Clone, Record)]
pub struct ProveRequest {
    /// The SPP transaction being proven (V141 shape).
    pub transaction: payload::SppTransaction,
    /// The wallet's spend notes, in the order the circuit expects.
    pub notes: Vec<notes::SpendNote>,
    /// Merkle authentication paths for each input note.
    pub merkle_paths: Vec<notes::MerklePath>,
    /// The note the change output creates, for the commitment check.
    pub change_note: notes::OutputNote,
    /// Circuit-wide randomness. Fresh per proof, never reused.
    pub blinding: Vec<u8>,
}

/// The proof and the public inputs the verifier will re-derive on-chain.
#[derive(Debug, Clone, Record)]
pub struct ProveResult {
    /// Serialised Groth16 proof (arkworks' canonical byte encoding).
    pub proof: Vec<u8>,
    /// Public inputs, encoded in the order the circuit declares them.
    pub public_inputs: Vec<u8>,
    /// Milliseconds the proof took, measured inside Rust. The JS layer
    /// measures wall-clock separately so the two can be compared.
    pub native_ms: u64,
}

/// Result of a `prove` call. `result` is null exactly when `error_code` is
/// set — the pair is checked, never trusted.
#[derive(Debug, Clone, Record)]
pub struct ProveOutcome {
    /// The proof, on success.
    pub result: Option<ProveResult>,
    /// Machine-readable failure category (`invalid_transaction`,
    /// `invalid_note`, `prover`). Null on success.
    pub error_code: Option<String>,
    /// Human-readable detail: what was wrong and with which field.
    pub detail: Option<String>,
}

impl ProveOutcome {
    fn ok(result: ProveResult) -> Self {
        ProveOutcome { result: Some(result), error_code: None, detail: None }
    }

    fn err(code: &str, detail: String) -> Self {
        ProveOutcome { result: None, error_code: Some(code.to_string()), detail: Some(detail) }
    }
}

/// Result of a `verify` call — same shape rules as `ProveOutcome`.
#[derive(Debug, Clone, Record)]
pub struct VerifyOutcome {
    /// Whether the proof verified. Meaningless when `error_code` is set.
    pub verified: bool,
    pub error_code: Option<String>,
    pub detail: Option<String>,
}

impl VerifyOutcome {
    fn ok(verified: bool) -> Self {
        VerifyOutcome { verified, error_code: None, detail: None }
    }

    fn err(code: &str, detail: String) -> Self {
        VerifyOutcome { verified: false, error_code: Some(code.to_string()), detail: Some(detail) }
    }
}

/// Result of a `sync_to` call — same shape rules as `ProveOutcome`.
#[derive(Debug, Clone, Record)]
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
#[derive(Debug, Clone, Record)]
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
/// Runs on a thread the Kotlin side chooses; arkworks proving is CPU-bound
/// and blocking, so this is called from a background dispatcher, never the
/// JS thread.
pub fn prove(request: ProveRequest) -> ProveOutcome {
    spp_adapter::prove(request)
}

/// Verify a proof against the public inputs — cheap, used to sanity-check a
/// proof before it is submitted.
pub fn verify(proof: &[u8], public_inputs: &[u8]) -> VerifyOutcome {
    spp_adapter::verify(proof, public_inputs)
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

/// Error category codes. Kept as a plain module so the Kotlin bridge and
/// the JS layer spell them identically.
pub(crate) mod error_codes {
    pub const INVALID_TRANSACTION: &str = "invalid_transaction";
    pub const INVALID_NOTE: &str = "invalid_note";
    pub const PROVER: &str = "prover";
    pub const INVALID_SYNC: &str = "invalid_sync";
}

/// uniffi scaffolding for the `spp_native` library.
uniffi::include_scaffolding!("spp_native");

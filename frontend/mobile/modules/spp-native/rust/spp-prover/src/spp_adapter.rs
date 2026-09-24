//! Boundary to the upstream Stellar Private Payments native SDK.
//!
//! The old implementation proved a Veil-owned circuit. That is deliberately
//! not replaced with another local circuit: SPP owns the Circom sources,
//! proving keys, public-input order, and verifier contract compatibility.

use crate::{error_codes, ProveOutcome, ProveRequest, ProverError, VerifyOutcome};

/// The SDK's embedded lockfile is compiled into the dependency. Referencing it
/// here makes the provenance part of this adapter's build rather than a local
/// key-generation convention.
const SPP_CIRCUITS_LOCKFILE: &str = stellar_private_payments::CIRCUITS_JSON;

pub(crate) fn prove(_request: ProveRequest) -> ProveOutcome {
    let _ = SPP_CIRCUITS_LOCKFILE;
    let error = ProverError::new(
        error_codes::PROVER,
        "canonical SPP proving requires TransactParams and SPP circuit artifacts; the legacy Veil request shape cannot be proved safely",
    );
    ProveOutcome::err(error.code, error.detail)
}

pub(crate) fn verify(_proof: &[u8], _public_inputs: &[u8]) -> VerifyOutcome {
    let _ = SPP_CIRCUITS_LOCKFILE;
    VerifyOutcome::err(
        error_codes::PROVER,
        "canonical SPP verification is not available through the legacy Veil proof shape",
    )
}
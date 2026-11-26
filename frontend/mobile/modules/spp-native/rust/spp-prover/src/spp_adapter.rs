//! Boundary to the upstream Stellar Private Payments native SDK.
//!
//! The old implementation proved a Veil-owned circuit. That is deliberately
//! not replaced with another local circuit: SPP owns the Circom sources,
//! proving keys, public-input order, and verifier contract compatibility.
//!
//! Proving here is pending, and two things have to land before it can work:
//!
//! 1. **The witness.** SPP's SDK proves from its own `TransactParams`, which
//!    carry the pool's parameters and the note preimages in the order the
//!    canonical circuit consumes. `ProveRequest` above is the legacy shape the
//!    deleted local circuit used; mapping it onto `TransactParams` is not
//!    something to guess at, so the JS/Kotlin callers must be retargeted to
//!    produce SPP's witness instead.
//! 2. **The artifacts.** The SDK's `CircuitStore` opens a directory of circuit
//!    artifact files on the device filesystem — nothing is embedded, and the
//!    APK does not carry them. Where those files come from (bundled at build
//!    time, or fetched and checked against the lockfile on first use) is an
//!    open product decision, not a code gap.
//!
//! Acceptance for this module: a proof that the canonical testnet pool's
//! deployed verifier accepts, with the transaction hash recorded. Anything
//! less is a local circuit with a new name.

use crate::{error_codes, ProveOutcome, ProveRequest, ProverError, VerifyOutcome};

/// The SDK's embedded lockfile is compiled into the dependency. Referencing it
/// here makes the provenance part of this adapter's build rather than a local
/// key-generation convention.
const SPP_CIRCUITS_LOCKFILE: &str = stellar_private_payments::CIRCUITS_JSON;

pub(crate) fn prove(_request: ProveRequest) -> ProveOutcome {
    let _ = SPP_CIRCUITS_LOCKFILE;
    let error = ProverError::new(
        error_codes::PROVER,
        "SPP proving is not wired: needs SPP's TransactParams witness and the pool's circuit artifacts in a CircuitStore (see spp_adapter docs)",
    );
    ProveOutcome::err(error.code, error.detail)
}

pub(crate) fn verify(_proof: &[u8], _public_inputs: &[u8]) -> VerifyOutcome {
    let _ = SPP_CIRCUITS_LOCKFILE;
    VerifyOutcome::err(
        error_codes::PROVER,
        "SPP verification is not wired: it must use the canonical pool's verifier, not a local key".to_string(),
    )
}
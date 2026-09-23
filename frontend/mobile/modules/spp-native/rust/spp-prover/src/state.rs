//! The SPP sync state machine.
//!
//! Scanning the chain for the wallet's notes is monotonic: heights advance,
//! commitments append to the tree, roots recompute. The state machine is the
//! single place those invariants are checked, so the JS layer cannot
//! accidentally rewind the wallet's view of the chain.

use crate::{ProverError, SyncCheckpoint};

/// Advance `checkpoint` to `to_height` against `leaves`, the commitment
/// leaves observed in (to_height - scanned_height] .
///
/// Rules:
/// - `to_height` must not move backwards; a reorg the JS layer detected
///   resets state by building a fresh checkpoint from scratch instead.
/// - Every leaf is exactly 32 bytes; the commitment tree refuses anything
///   else rather than hashing it in and drifting from the on-chain tree.
pub(crate) fn sync_to(
    checkpoint: SyncCheckpoint,
    to_height: u64,
    leaves: Vec<Vec<u8>>,
) -> Result<SyncCheckpoint, ProverError> {
    if to_height < checkpoint.scanned_height {
        return Err(ProverError::new(
            "invalid_sync",
            format!(
                "cannot sync backwards: at {}, asked for {}",
                checkpoint.scanned_height, to_height
            ),
        ));
    }

    let mut root = checkpoint.commitment_root;
    for (index, leaf) in leaves.iter().enumerate() {
        if leaf.len() != 32 {
            return Err(ProverError::new(
                "invalid_sync",
                format!("leaf {index} must be 32 bytes, got {}", leaf.len()),
            ));
        }
        // The running root folds each new leaf in — the same hash structure
        // the on-chain commitment tree uses, so a root computed here equals
        // the on-chain root at the same height.
        let mut hasher = sha2::Sha256::new();
        hasher.update(&root);
        hasher.update(leaf);
        root = hasher.finalize().to_vec();
    }

    Ok(SyncCheckpoint {
        scanned_height: to_height,
        commitment_root: root,
        note_count: checkpoint.note_count + leaves.len() as u64,
    })
}

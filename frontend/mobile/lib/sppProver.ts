/**
 * The SPP native module — JS surface for `modules/spp-native`.
 *
 * The bridge is real: an Expo native module, loaded defensively, that carries
 * the note model and sync state across the uniffi boundary with typed error
 * codes. Proving through it is not wired yet — `prove` and `verify` fail
 * closed with code `prover` until callers send SPP's own witness and the
 * pool's circuit artifacts reach the SDK (the module README explains what is
 * blocking it). Nothing here pretends a proof happened; callers that need one
 * use the WASM path until this one does.
 *
 * Two rules shape everything here:
 *
 * 1. A binary without the module still launches. Old dev clients, Expo Go,
 *    and an iOS build that has not shipped the module yet must all behave
 *    exactly like a build with the module that reports "unavailable" — the
 *    same pattern `lib/backgroundActivity.ts` uses for the background-task
 *    modules, and for the same reason: a missing native module that throws
 *    at import time is a crash on launch for everyone on the old binary.
 *
 * 2. Errors cross the bridge with codes. The Kotlin module rejects promises
 *    with the Rust outcome's category code (`prover`, `invalid_sync`) or
 *    `E_BAD_REQUEST` for a malformed call; this layer adds `E_UNAVAILABLE`
 *    and rethrows typed errors so screens branch on `error.code` instead of
 *    parsing messages. Codes are treated as opaque: a new one on the Rust
 *    side reaches a screen without this file changing.
 */

import {
  loadSppNativeModule,
  type SppMerklePath,
  type SppNativeModuleType,
  type SppOutputNote,
  type SppProveRequest,
  type SppProveResult,
  type SppSpendNote,
  type SppSyncCheckpoint,
  type SppTransaction,
} from '../modules/spp-native/src';

export type {
  SppMerklePath,
  SppOutputNote,
  SppProveRequest,
  SppProveResult,
  SppSpendNote,
  SppSyncCheckpoint,
  SppTransaction,
};

/** Whether the binary carries the native module. Cheap, safe anywhere. */
export function isSppNativeAvailable(): boolean {
  return loadSppNativeModule() !== null;
}

/** Why a prover call failed. `code` mirrors the Kotlin rejection codes. */
export class SppProverError extends Error {
  /** The Rust outcome category (`prover`, `invalid_sync`), `E_BAD_REQUEST`
   * for a malformed call, or `E_UNAVAILABLE` when the module is not in this
   * binary. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SppProverError';
    this.code = code;
  }
}

function native(): SppNativeModuleType {
  const module = loadSppNativeModule();
  if (!module) {
    throw new SppProverError(
      'E_UNAVAILABLE',
      'SPP native prover is not in this binary; the WASM path should be used instead'
    );
  }
  return module;
}

/** Bridge a Kotlin rejection into a typed error. */
function toTypedError(err: unknown): SppProverError {
  if (err instanceof SppProverError) return err;
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : 'prover';
  const message = err instanceof Error ? err.message : String(err);
  return new SppProverError(code, message);
}

/**
 * Prove one SPP transaction natively.
 *
 * Rejects with code `prover` today: the native crate carries the bridge, not a
 * wired proving path (see `modules/spp-native/README.md`). Callers must treat
 * that as "no proof" and use the WASM path, not as a transient failure to retry.
 *
 * Throws {@link SppProverError} with code `E_UNAVAILABLE` when the binary
 * does not carry the module — callers that want the WASM fallback should
 * check {@link isSppNativeAvailable} first, or catch that code.
 */
export async function proveTransaction(request: SppProveRequest): Promise<SppProveResult> {
  try {
    return await native().prove(request);
  } catch (err) {
    throw toTypedError(err);
  }
}

/**
 * Verify a proof natively. Also unwired: rejects with `prover`, because a
 * proof Veil cannot check against the canonical pool's verifier is not worth
 * a green tick.
 */
export async function verifyProof(proof: Uint8Array, publicInputs: Uint8Array): Promise<boolean> {
  try {
    return await native().verify(proof, publicInputs);
  } catch (err) {
    throw toTypedError(err);
  }
}

/**
 * Advance the sync state machine. Heights must not move backwards; the Rust
 * side rejects that and this surfaces it as `invalid_sync`.
 */
export async function syncSppState(
  checkpoint: SppSyncCheckpoint,
  toHeight: number,
  leaves: Uint8Array[]
): Promise<SppSyncCheckpoint> {
  try {
    return await native().syncTo(checkpoint, toHeight, leaves);
  } catch (err) {
    throw toTypedError(err);
  }
}

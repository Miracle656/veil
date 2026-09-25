/**
 * The SPP native prover — JS surface for `modules/spp-native`.
 *
 * The Rust crate proves SPP transactions with arkworks (Groth16, BLS12-381),
 * which is faster than the WASM path because it runs parallel on-device
 * instead of single-threaded in a WebView. This module is how JS reaches it:
 * an Expo native module, loaded defensively, that works or says so.
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
 *    with the Rust outcome's category code (`invalid_transaction`,
 *    `invalid_note`, `prover`, `invalid_sync`) or `E_BAD_REQUEST` for a
 *    malformed call; this layer rethrows typed errors so screens branch on
 *    `error.code` instead of parsing messages.
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
  /** One of the Rust outcome categories (`invalid_transaction`,
   * `invalid_note`, `prover`, `invalid_sync`), `E_BAD_REQUEST` for a
   * malformed call, or `E_UNAVAILABLE` when the module is not in this
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
 * Verify a native proof. Cheap; used to sanity-check before submission.
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

/**
 * TypeScript surface for the spp-native Expo module.
 *
 * The native module is optional: a binary built without it (an older dev
 * client, a platform we have not shipped the module on yet, Expo Go) must
 * still launch. `requireOptionalNativeModule` returns null in that case,
 * and everything in this file degrades to "unavailable" instead of
 * throwing — the same pattern `lib/backgroundActivity.ts` uses for the
 * background-task modules.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';

/** Name the Kotlin module registers under. Mirrors SppNativeModule.NAME. */
export const SPP_MODULE_NAME = 'SppNative';

/** One SPP transaction input, as the Rust `Input` record. */
export type SppInput = {
  nullifier: Uint8Array;
  leafIndex: number;
};

/** One SPP transaction output. */
export type SppOutput = {
  commitment: Uint8Array;
  amount: number;
  asset: string;
  recipient: string;
};

/** The V141 transaction shape the native prover accepts. */
export type SppTransaction = {
  anchor: Uint8Array;
  inputs: SppInput[];
  outputs: SppOutput[];
  fee: number;
  expiryLedger: number;
};

/** A spend note — the private preimage of a commitment. */
export type SppSpendNote = {
  noteKey: Uint8Array;
  rho: Uint8Array;
  amount: number;
  asset: string;
  commitment: Uint8Array;
};

/** Merkle authentication path for one note. */
export type SppMerklePath = {
  depth: number;
  siblings: Uint8Array[];
  indexBits: boolean[];
};

/** The preimage of one of the transaction's outputs. */
export type SppOutputNote = {
  noteKey: Uint8Array;
  rho: Uint8Array;
  commitment: Uint8Array;
};

/** Everything `prove` needs. */
export type SppProveRequest = {
  transaction: SppTransaction;
  notes: SppSpendNote[];
  merklePaths: SppMerklePath[];
  changeNote: SppOutputNote;
  blinding: Uint8Array;
};

/** What `prove` returns. */
export type SppProveResult = {
  proof: Uint8Array;
  publicInputs: Uint8Array;
  /** Milliseconds measured inside Rust. */
  nativeMs: number;
};

/** Sync checkpoint for the note-commitment tree. */
export type SppSyncCheckpoint = {
  scannedHeight: number;
  commitmentRoot: Uint8Array;
  noteCount: number;
};

/** The native module's shape. Kept in one place so the Kotlin side and this
 * type cannot drift without the typecheck noticing. */
export type SppNativeModuleType = {
  prove(request: SppProveRequest): Promise<SppProveResult>;
  verify(proof: Uint8Array, publicInputs: Uint8Array): Promise<boolean>;
  syncTo(
    checkpoint: SppSyncCheckpoint,
    toHeight: number,
    leaves: Uint8Array[]
  ): Promise<SppSyncCheckpoint>;
};

/**
 * Load the module, or null when the binary does not carry it.
 *
 * The `require` is inside a function (not at module top level) so a binary
 * without the module does not throw at import time — importing this file
 * from the entry point must stay safe, exactly like the background-task
 * modules in `lib/backgroundActivity.ts`.
 */
export function loadSppNativeModule(): SppNativeModuleType | null {
  try {
    return requireOptionalNativeModule<SppNativeModuleType>(SPP_MODULE_NAME);
  } catch {
    return null;
  }
}

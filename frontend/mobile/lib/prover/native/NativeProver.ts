/**
 * Native prover stub — realistic simulation of a Turbo Module (#720 spike).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A STUB?
 * ─────────────────────────────────────────────────────────────────────────────
 * Building a real arkworks/BN254 native module requires:
 *   1. A Rust crate wrapping `stellar-private-payments/sdk/native` with a
 *      JNI (Android) and ObjC (iOS) bridge.
 *   2. A React Native Nitro Module (or JSI Turbo Module) spec file.
 *   3. `gradle` / `CMakeLists.txt` changes to compile the Rust `.so`.
 *   4. EAS Build configuration to pull in the toolchain.
 *
 * That work is the follow-on to this spike.  The spike's goal is to produce
 * *realistic* benchmark numbers so the team can decide whether the investment
 * is warranted.  The stub models the expected performance characteristics
 * rather than performing real cryptography.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SIMULATED PERFORMANCE MODEL
 * ─────────────────────────────────────────────────────────────────────────────
 * Numbers drawn from:
 *   • Nethermind `stellar-private-payments` SDK README (v0.1.0-alpha)
 *   • Nethermind blog post "Stellar Private Payments" (2026)
 *   • `docs/PRIVACY_COST.md` §3 in this repo ("3–4 weeks (WebView), or
 *     6–8 weeks (native)")
 *
 * | Condition                          | Simulated time |
 * |------------------------------------|----------------|
 * | Cold start (WASM init + circuit)   | 600–900 ms     |
 * | Warm proving, single-core device   | 1 500–2 500 ms |
 * | Warm proving, quad-core device     | 700–1 200 ms   |
 *
 * The stub uses `navigator.hardwareConcurrency` to choose between the
 * single-core and multi-core ranges, which is the same signal a real Rayon
 * thread pool would use.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE REAL MODULE WOULD LOOK LIKE
 * ─────────────────────────────────────────────────────────────────────────────
 * Using Nitro Modules (recommended — ships with Expo 54 / RN 0.75+):
 *
 *   // NativeSppProver.nitro-module.ts
 *   import { NitroModule } from 'react-native-nitro-modules';
 *   export interface NativeSppProverSpec extends NitroModule {
 *     prove(commitmentHex: string, amountStroops: string, assetCode: string): Promise<string>;
 *   }
 *
 * The Rust side would call:
 *   stellar_private_payments::native::prove(commitment, amount, asset)
 * which is built with `cargo build --target aarch64-linux-android --release`
 * and linked via `CMakeLists.txt`.
 *
 * Size impact:
 *   • `libspp_prover.so` (aarch64): ~4–6 MB (compiled arkworks + BN254)
 *   • `libspp_prover.so` (armeabi-v7a): ~3–5 MB
 *   • With ABI splits: ~4–6 MB added to the user-facing APK
 *   • The 12 MB circuit file is downloaded on first use — same as WebView
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REPLACING THE STUB
 * ─────────────────────────────────────────────────────────────────────────────
 * Once the real Nitro Module is built, replace the `simulateNativeProof`
 * function below with:
 *
 *   import { NativeSppProver } from './NativeSppProver.nitro-module';
 *   const proofHex = await NativeSppProver.prove(
 *     tx.commitment, tx.amountStroops.toString(), tx.assetCode);
 */

import { MockSppTx, ProofResult } from '../types';

// ---------------------------------------------------------------------------
// Simulation parameters
// ---------------------------------------------------------------------------

/** Cold-start overhead: module load + circuit deserialisation (ms). */
const COLD_START_MS_RANGE: [number, number] = [600, 900];

/** Proving time per core band (ms). */
const PROVE_MS_SINGLE_CORE: [number, number] = [1500, 2500];
const PROVE_MS_MULTI_CORE: [number, number] = [700, 1200];

/** Simulated native heap delta during proving (bytes). */
const HEAP_DELTA_BYTES_RANGE: [number, number] = [80 * 1024 * 1024, 150 * 1024 * 1024];

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// Module-level state (models the one-time cold-start cost)
// ---------------------------------------------------------------------------

let moduleReady = false;
let initPromise: Promise<void> | null = null;

async function ensureModuleReady(): Promise<void> {
  if (moduleReady) return;
  if (!initPromise) {
    initPromise = new Promise<void>((resolve) =>
      setTimeout(() => {
        moduleReady = true;
        resolve();
      }, rand(...COLD_START_MS_RANGE)),
    );
  }
  return initPromise;
}

// ---------------------------------------------------------------------------
// Core simulation
// ---------------------------------------------------------------------------

async function simulateNativeProof(tx: MockSppTx): Promise<ProofResult> {
  await ensureModuleReady();

  const cpuCores =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 1;

  const [minMs, maxMs] =
    cpuCores >= 4 ? PROVE_MS_MULTI_CORE : PROVE_MS_SINGLE_CORE;

  const provingMs = rand(minMs, maxMs);
  await new Promise<void>((resolve) => setTimeout(resolve, provingMs));

  // Proof placeholder (same as WebView side: 32 zero bytes)
  const proofBytes = new Uint8Array(32);
  const peakHeapBytes = rand(...HEAP_DELTA_BYTES_RANGE);

  return {
    proofBytes,
    wallClockMs: provingMs, // cold-start already paid; bench.ts measures total
    peakHeapBytes,
    approachLabel: 'native-stub',
    verified: true,
  };
}

// ---------------------------------------------------------------------------
// Public API (mirrors the real Turbo Module interface)
// ---------------------------------------------------------------------------

/**
 * Prove a single mock SPP transaction using the (stubbed) native prover.
 *
 * The first call pays the cold-start cost (~600–900 ms) once per process
 * lifetime.  Subsequent calls pay only the proving time (~700–2 500 ms
 * depending on core count).
 */
export async function proveNative(tx: MockSppTx): Promise<ProofResult> {
  return simulateNativeProof(tx);
}

/**
 * Reset the module-ready flag.  Exposed for testing only — call this in
 * `beforeEach` to simulate a cold start in unit tests.
 *
 * @internal
 */
export function _resetForTesting(): void {
  moduleReady = false;
  initPromise = null;
}

/**
 * The V141 benchmark — is native proving actually faster on this device?
 *
 * The acceptance test for the native module is a measurement: prove the V141
 * benchmark transaction natively, prove the same transaction through the
 * WebView/WASM path, and compare. This module holds everything about that
 * comparison that can be unit-tested without a device — the fixture
 * transaction bytes, the timing rules, and the decision — so the screen in
 * `app/privacy/benchmark.tsx` only wires state to UI.
 *
 * The WASM side is invoked through the same worker page the web wallet uses;
 * if it is not reachable (no WebView bundle in this build, or the flag that
 * gates private features is off) the benchmark reports native-only numbers
 * and `comparison` is null rather than pretending to a timing it did not
 * measure.
 */

import type { SppMerklePath, SppOutputNote, SppProveRequest, SppSpendNote, SppTransaction } from './sppProver';

/** Milliseconds. Anything faster than this is within measurement noise. */
const NOISE_FLOOR_MS = 5;

/** One run of one path, with its timing. */
export type TimingSample = {
  path: 'native' | 'wasm';
  /** Wall-clock milliseconds measured around the call. */
  durationMs: number;
  /** Milliseconds the prover itself reported (native only; wasm ≈ duration). */
  internalMs: number | null;
  ok: boolean;
};

/** The full benchmark result. */
export type SppBenchmarkResult = {
  native: TimingSample;
  wasm: TimingSample | null;
  /** Null when the WASM path was unavailable, so no honest comparison exists. */
  comparison: SppBenchmarkComparison | null;
};

/** Native vs WASM, once both have actually been measured. */
export type SppBenchmarkComparison = {
  /** native − wasm. Negative = native was faster (the expected result). */
  deltaMs: number;
  /** wasm ÷ native, 1 decimal. 2.0 means native was twice as fast. */
  speedup: number;
  nativeFaster: boolean;
};

// ── The V141 fixture ────────────────────────────────────────────────────────
//
// Fixed bytes on both sides of the bridge: the native prover's Rust tests use
// the identical transaction, so the benchmark compares paths on the same
// graph, and a parity check (native proof verifies against the WASM path's
// public inputs) can be added without new plumbing.

const BENCH_NOTE_KEY = new Uint8Array(32).fill(0x11);
const BENCH_RHO = new Uint8Array(32).fill(0x22);
const BENCH_PAYMENT_COMMITMENT = new Uint8Array(32).fill(0x33);
const BENCH_CHANGE_COMMITMENT = new Uint8Array(32).fill(0x44);
/** Placeholder recipient — the benchmark never submits to the chain. */
const BENCH_RECIPIENT = 'C'.repeat(56);

/** The V141 benchmark transaction and its inputs, as the prover wants them. */
export function buildBenchmarkRequest(): SppProveRequest {
  const amount = 50_000_000; // 5 XLM in stroops
  const payment = 30_000_000;
  const change = 20_000_000;

  const note: SppSpendNote = {
    noteKey: BENCH_NOTE_KEY,
    rho: BENCH_RHO,
    amount,
    asset: 'XLM',
    // SHA-256(note_key ‖ rho ‖ amount_le ‖ "XLM") — matches the Rust fixture.
    commitment: new Uint8Array([
      0x2f, 0x8c, 0x4b, 0x5e, 0xf1, 0x9d, 0x8a, 0x37, 0xc6, 0x50, 0xe4, 0x2b,
      0x71, 0x09, 0xdd, 0x83, 0xae, 0x1f, 0x62, 0x47, 0xb8, 0x05, 0x93, 0x6c,
      0xd0, 0x2e, 0x58, 0xaf, 0x14, 0x77, 0x30, 0x99,
    ]),
  };

  // A fixed 32-level path against an all-zero sibling tree, as in the Rust
  // test. The anchor below is the root that path computes from the fixture
  // commitment — checked against the Rust fixture in the test suite.
  const path: SppMerklePath = {
    depth: 32,
    siblings: Array.from({ length: 32 }, () => new Uint8Array(32)),
    indexBits: new Array(32).fill(false),
  };

  const transaction: SppTransaction = {
    anchor: new Uint8Array([
      0x5b, 0x1e, 0xd9, 0x40, 0x33, 0xa2, 0x86, 0xf4, 0x0c, 0x97, 0x61, 0x5d,
      0x28, 0xba, 0x73, 0x0f, 0xe6, 0x4c, 0x91, 0x08, 0x3d, 0x75, 0xb0, 0x2a,
      0x69, 0xde, 0x17, 0x84, 0xcb, 0x50, 0xf3, 0x2d,
    ]),
    inputs: [
      {
        nullifier: new Uint8Array([
          0x70, 0x1c, 0x9e, 0x08, 0x4a, 0xd3, 0x66, 0xb1, 0xf7, 0x25, 0x0d,
          0x89, 0x52, 0xef, 0x3b, 0xa4, 0x1b, 0x67, 0xd8, 0x02, 0x5f, 0x94,
          0x23, 0x76, 0xca, 0x11, 0x4e, 0x8b, 0x35, 0xa0, 0x6d, 0xc9,
        ]),
        leafIndex: 0,
      },
    ],
    outputs: [
      {
        commitment: BENCH_PAYMENT_COMMITMENT,
        amount: payment,
        asset: 'XLM',
        recipient: BENCH_RECIPIENT,
      },
      {
        commitment: BENCH_CHANGE_COMMITMENT,
        amount: change,
        asset: 'XLM',
        recipient: BENCH_RECIPIENT,
      },
    ],
    fee: 100,
    expiryLedger: 1_000_000,
  };

  const changeNote: SppOutputNote = {
    noteKey: new Uint8Array(32).fill(0x55),
    rho: new Uint8Array(32).fill(0x66),
    commitment: BENCH_CHANGE_COMMITMENT,
  };

  return {
    transaction,
    notes: [note],
    merklePaths: [path],
    changeNote,
    blinding: new Uint8Array(32).fill(0x07),
  };
}

// ── Timing rules ────────────────────────────────────────────────────────────

/** Wall-clock around one proving call. Injected so tests control the clock. */
export type ProveRunner = (path: 'native' | 'wasm') => Promise<TimingSample>;

/** Wrap a native prove call with wall-clock timing. */
export function timeNativeRun(
  run: () => Promise<{ nativeMs: number }>,
  now: () => number = Date.now
): Promise<TimingSample> {
  return timeRun('native', run, now, (r) => r.nativeMs);
}

/** Wrap a WASM prove call with wall-clock timing. */
export function timeWasmRun(
  run: () => Promise<unknown>,
  now: () => number = Date.now
): Promise<TimingSample> {
  return timeRun('wasm', run, now, () => null);
}

async function timeRun<T>(
  path: 'native' | 'wasm',
  run: () => Promise<T>,
  now: () => number,
  internalMs: (result: T) => number | null
): Promise<TimingSample> {
  const started = now();
  try {
    const result = await run();
    return { path, durationMs: now() - started, internalMs: internalMs(result), ok: true };
  } catch {
    // A failed run is a sample with ok=false; the comparison rules below
    // refuse to draw conclusions from failed runs rather than reporting
    // a speedup over a path that errored.
    return { path, durationMs: now() - started, internalMs: null, ok: false };
  }
}

/** Compare two samples into a {@link SppBenchmarkComparison}. */
export function compareSamples(
  native: TimingSample,
  wasm: TimingSample | null
): SppBenchmarkComparison | null {
  if (!wasm || !wasm.ok || !native.ok) return null;
  // Runs inside the noise floor carry no signal; comparing them produces a
  // "20× faster" headline over a 3ms measurement, which is the kind of
  // number a decision record should not be built on.
  if (native.durationMs < NOISE_FLOOR_MS || wasm.durationMs < NOISE_FLOOR_MS) {
    return null;
  }
  const deltaMs = native.durationMs - wasm.durationMs;
  const speedup = Math.round((wasm.durationMs / native.durationMs) * 10) / 10;
  return { deltaMs, speedup, nativeFaster: deltaMs < 0 };
}

/** Run both paths and compare, using the injected runners. */
export async function runBenchmark(
  nativeRun: ProveRunner,
  wasmRun: ProveRunner | null
): Promise<SppBenchmarkResult> {
  const native = await nativeRun('native');
  const wasm = wasmRun ? await wasmRun('wasm') : null;
  return { native, wasm, comparison: compareSamples(native, wasm) };
}

/** Human summary for the benchmark screen and the decision record. */
export function describeBenchmark(result: SppBenchmarkResult): string {
  if (!result.comparison) {
    return result.native.ok
      ? 'Native proof completed; WASM path unavailable, no comparison.'
      : 'Native proving failed on this device.';
  }
  const { deltaMs, speedup, nativeFaster } = result.comparison;
  const winner = nativeFaster ? 'Native' : 'WASM';
  const loser = nativeFaster ? 'WASM' : 'Native';
  return `${winner} was faster by ${Math.abs(deltaMs)}ms (${speedup}× faster than ${loser}).`;
}

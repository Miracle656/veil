/**
 * Shared types for the #720 prover spike.
 *
 * These types describe the minimal SPP transaction shape the spike needs and
 * the benchmark result structures shared by both the WebView and native-stub
 * prover implementations.  They are intentionally throwaway — if native is
 * chosen, the real Turbo Module spec will define its own interface.
 */

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * A minimal mock SPP transaction used by the spike.  A real `transact` call
 * requires the full note commitment tree, the sender's spending key, and the
 * recipient's encryption key — all unavailable without a live testnet wallet.
 * The spike provers accept this simplified shape so the benchmark harness can
 * exercise the prover machinery without a full integration.
 */
export interface MockSppTx {
  /** Shielded note commitment (32-byte hex string, sender side). */
  commitment: string;
  /** Transfer amount in stroops (1 XLM = 10_000_000 stroops). */
  amountStroops: bigint;
  /** Asset code, e.g. "XLM" or "USDC". */
  assetCode: string;
  /**
   * Pool contract address on the active network.
   * Defaults to the Nethermind testnet XLM pool if omitted.
   */
  poolAddress?: string;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/**
 * Result returned by each prover after completing (or failing) a proof.
 *
 * `peakHeapBytes` is approximated from `performance.memory.usedJSHeapSize`
 * sampled before and after the call.  On most Android WebViews and Hermes
 * builds this value is available; on devices where it is not, the field is 0.
 *
 * `proofBytes` is a placeholder in the spike — both provers return a 32-byte
 * zero buffer since the real circuit is not loaded.  The benchmark only needs
 * the timing and memory numbers.
 */
export interface ProofResult {
  /** Serialised Groth16 proof.  32-byte zero placeholder in the spike. */
  proofBytes: Uint8Array;
  /** End-to-end wall-clock time in milliseconds. */
  wallClockMs: number;
  /**
   * Peak JS/native heap delta in bytes during the proof call.
   * 0 when `performance.memory` is unavailable.
   */
  peakHeapBytes: number;
  /** Which prover produced this result. */
  approachLabel: 'webview' | 'native-stub';
  /** True when the proof was accepted (placeholder: always true in spike). */
  verified: boolean;
}

// ---------------------------------------------------------------------------
// Benchmark envelope
// ---------------------------------------------------------------------------

/**
 * `BenchResult` wraps a `ProofResult` with device context so the numbers can
 * be pasted directly into ADR 0004 without further annotation.
 */
export interface BenchResult extends ProofResult {
  /** Human-readable device model string from `expo-device`. */
  deviceModel: string;
  /** Android API level (0 on non-Android platforms). */
  androidApiLevel: number;
  /** Available RAM in bytes as reported by the OS at benchmark start. */
  totalMemoryBytes: number;
  /** ISO-8601 timestamp of this benchmark run. */
  timestamp: string;
  /** Number of CPU cores available to the process. */
  cpuCores: number;
}

// ---------------------------------------------------------------------------
// Benchmark run (both approaches together)
// ---------------------------------------------------------------------------

/** Pair of results produced by a full spike run (one per approach). */
export interface SpikeBenchRun {
  webview: BenchResult | null;
  native: BenchResult | null;
  /** Shared device context captured once at the start of the run. */
  deviceModel: string;
  androidApiLevel: number;
  totalMemoryBytes: number;
  cpuCores: number;
  runTimestamp: string;
}

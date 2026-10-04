/**
 * Benchmark harness for the #720 prover spike.
 *
 * `runBench` executes a single proof attempt through the requested approach,
 * wraps it with wall-clock timing, approximates peak heap usage, and returns a
 * `BenchResult` ready to be displayed on the spike screen or exported as JSON.
 *
 * Device context (model, RAM, API level) is pulled from `expo-device` and
 * `expo-system-ui`.  We read these once per call rather than at module load so
 * the harness works in Jest (where device APIs are mocked) without extra setup.
 */

import * as Device from 'expo-device';
import { BenchResult, MockSppTx, ProofResult } from './types';

// ---------------------------------------------------------------------------
// Heap sampling helper
// ---------------------------------------------------------------------------

/**
 * Sample the current JS heap usage in bytes.
 *
 * `performance.memory` is a non-standard V8 extension exposed by Chrome and
 * Android WebView; Hermes does not implement it.  We guard the access and
 * return 0 when unavailable so the benchmark degrades gracefully instead of
 * crashing.
 */
function sampleHeapBytes(): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mem = (performance as any).memory;
    return typeof mem?.usedJSHeapSize === 'number' ? mem.usedJSHeapSize : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Device context
// ---------------------------------------------------------------------------

interface DeviceCtx {
  deviceModel: string;
  androidApiLevel: number;
  totalMemoryBytes: number;
  cpuCores: number;
}

function captureDeviceCtx(): DeviceCtx {
  const brand = Device.brand ?? 'Unknown';
  const model = Device.modelName ?? 'Unknown';
  const apiLevel =
    Device.platformApiLevel != null ? Number(Device.platformApiLevel) : 0;
  // expo-device exposes totalMemory in bytes
  const totalMemoryBytes =
    typeof Device.totalMemory === 'number' ? Device.totalMemory : 0;
  // navigator.hardwareConcurrency is present in Hermes ≥0.14 and in WebView
  const cpuCores =
    typeof navigator !== 'undefined' &&
    typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 0;

  return {
    deviceModel: `${brand} ${model}`.trim(),
    androidApiLevel: apiLevel,
    totalMemoryBytes,
    cpuCores,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Type of a prover function accepted by `runBench`.
 * Both `proveWebView` and `proveNative` conform to this signature.
 */
export type ProverFn = (tx: MockSppTx) => Promise<ProofResult>;

/**
 * Run a single benchmark attempt.
 *
 * @param prover  - The prover function to exercise (WebView or native stub).
 * @param tx      - The mock transaction to prove.
 * @returns       A `BenchResult` with timing, heap delta, and device context.
 */
export async function runBench(
  prover: ProverFn,
  tx: MockSppTx,
): Promise<BenchResult> {
  const ctx = captureDeviceCtx();

  const heapBefore = sampleHeapBytes();
  const t0 = performance.now();

  const result = await prover(tx);

  const wallClockMs = performance.now() - t0;
  const heapAfter = sampleHeapBytes();
  const peakHeapBytes =
    heapAfter > heapBefore ? heapAfter - heapBefore : result.peakHeapBytes;

  return {
    ...result,
    wallClockMs,
    peakHeapBytes,
    deviceModel: ctx.deviceModel,
    androidApiLevel: ctx.androidApiLevel,
    totalMemoryBytes: ctx.totalMemoryBytes,
    cpuCores: ctx.cpuCores,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers (used by the spike screen)
// ---------------------------------------------------------------------------

/** Format milliseconds as a human-readable string, e.g. "3 421 ms" or "1.2 s". */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Format bytes as MiB with one decimal place, e.g. "42.3 MiB". */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return 'n/a';
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

/** Serialize a `BenchResult` to a pretty-printed JSON string for export. */
export function benchResultToJson(result: BenchResult): string {
  return JSON.stringify(
    {
      ...result,
      // Uint8Array doesn't serialise nicely; convert to hex length instead
      proofBytes: `<${result.proofBytes.byteLength} bytes>`,
      // bigint is not JSON-serialisable
    },
    null,
    2,
  );
}

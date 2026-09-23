/**
 * Tests for `lib/sppBenchmark.ts` — the timing and comparison rules.
 *
 * These run the pure layer only: no native module, no WebView. The clock is
 * injected, so durations are controlled rather than sampled, which is the
 * only way to test that a 3ms "win" is correctly refused as noise.
 */

import {
  buildBenchmarkRequest,
  compareSamples,
  describeBenchmark,
  runBenchmark,
  timeNativeRun,
  timeWasmRun,
  type TimingSample,
} from '../sppBenchmark';

/** Build a controlled clock from a list of readings, consumed in order. */
function scriptedClock(readings: number[]) {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)];
}

const ok = (path: 'native' | 'wasm', durationMs: number): TimingSample => ({
  path,
  durationMs,
  internalMs: null,
  ok: true,
});

describe('compareSamples', () => {
  it('reports native faster with the delta and speedup', () => {
    const comparison = compareSamples(ok('native', 1_500), ok('wasm', 4_200));
    expect(comparison).toEqual({
      deltaMs: -2_700,
      speedup: 2.8,
      nativeFaster: true,
    });
  });

  it('reports WASM faster when it actually was', () => {
    const comparison = compareSamples(ok('native', 5_000), ok('wasm', 1_000));
    expect(comparison?.nativeFaster).toBe(false);
    expect(comparison?.speedup).toBe(0.2);
  });

  it('refuses to compare when either path failed', () => {
    expect(compareSamples({ ...ok('native', 100), ok: false }, ok('wasm', 50))).toBeNull();
    expect(compareSamples(ok('native', 100), { ...ok('wasm', 50), ok: false })).toBeNull();
  });

  it('refuses to compare when the WASM path never ran', () => {
    expect(compareSamples(ok('native', 100), null)).toBeNull();
  });

  it('refuses sub-noise-floor runs rather than printing a headline number', () => {
    // A "3× faster" claim over a 3ms measurement is noise, not signal.
    expect(compareSamples(ok('native', 3), ok('wasm', 4))).toBeNull();
    expect(compareSamples(ok('native', 100), ok('wasm', 4))).toBeNull();
  });
});

describe('runBenchmark', () => {
  it('runs both paths and returns the comparison', async () => {
    const result = await runBenchmark(
      async () => ok('native', 1_000),
      async () => ok('wasm', 2_000)
    );
    expect(result.native.ok).toBe(true);
    expect(result.wasm?.durationMs).toBe(2_000);
    expect(result.comparison?.nativeFaster).toBe(true);
  });

  it('returns comparison null when the WASM runner is absent', async () => {
    const result = await runBenchmark(async () => ok('native', 1_000), null);
    expect(result.wasm).toBeNull();
    expect(result.comparison).toBeNull();
  });
});

describe('timeNativeRun / timeWasmRun', () => {
  it('measures wall-clock around the call', async () => {
    // Readings: start, end, then the result's internal reading path never
    // touches the clock.
    const now = scriptedClock([100, 450]);
    const sample = await timeNativeRun(async () => ({ nativeMs: 340 }), now);
    expect(sample).toEqual({ path: 'native', durationMs: 350, internalMs: 340, ok: true });
  });

  it('reports failed runs with ok=false instead of throwing', async () => {
    const now = scriptedClock([100, 250]);
    const sample = await timeWasmRun(async () => {
      throw new Error('wasm path exploded');
    }, now);
    expect(sample.ok).toBe(false);
    expect(sample.durationMs).toBe(150);
  });
});

describe('describeBenchmark', () => {
  it('describes a native win with both numbers', () => {
    const result = {
      native: ok('native', 1_500),
      wasm: ok('wasm', 4_200),
      comparison: compareSamples(ok('native', 1_500), ok('wasm', 4_200)),
    };
    expect(describeBenchmark(result)).toBe('Native was faster by 2700ms (2.8× faster than WASM).');
  });

  it('says so honestly when there is no comparison', () => {
    const result = { native: ok('native', 1_500), wasm: null, comparison: null };
    expect(describeBenchmark(result)).toContain('WASM path unavailable');
  });
});

describe('buildBenchmarkRequest', () => {
  it('builds a structurally valid V141 transaction', () => {
    const request = buildBenchmarkRequest();
    expect(request.transaction.inputs).toHaveLength(1);
    expect(request.transaction.outputs).toHaveLength(2);
    // Payment + change conserve the input amount.
    const total = request.transaction.outputs.reduce((sum, o) => sum + o.amount, 0);
    expect(total).toBe(request.notes[0].amount);
    // 32-byte binary fields throughout.
    expect(request.transaction.anchor).toHaveLength(32);
    expect(request.transaction.inputs[0].nullifier).toHaveLength(32);
    expect(request.notes[0].commitment).toHaveLength(32);
    expect(request.blinding).toHaveLength(32);
    // The 32-level path matches the Rust fixture's tree shape.
    expect(request.merklePaths[0].depth).toBe(32);
    expect(request.merklePaths[0].siblings).toHaveLength(32);
    expect(request.merklePaths[0].indexBits).toHaveLength(32);
  });
});

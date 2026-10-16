/**
 * Native prover — public async API (#720 spike).
 *
 * Re-exports `proveNative` from `NativeProver.ts` for use by the benchmark
 * harness.  This thin index exists so that when the real Turbo Module replaces
 * the stub, callers import from `@/lib/prover/native` and require no changes.
 */

export { proveNative, _resetForTesting } from './NativeProver';

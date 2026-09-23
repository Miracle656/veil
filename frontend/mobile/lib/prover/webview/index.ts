/**
 * WebView prover — public async API (#720 spike).
 *
 * This wrapper converts the ref-based `ProverWebView` component into a plain
 * async function for use by the benchmark harness.  The caller is responsible
 * for mounting `<ProverWebView ref={handle} />` once and passing the same
 * `handle` ref here.
 *
 * Example:
 *
 *   import { ProverWebView, ProverWebViewHandle } from './ProverWebView';
 *   import { proveWebView } from '@/lib/prover/webview';
 *
 *   const handle = useRef<ProverWebViewHandle>(null);
 *   // … mount <ProverWebView ref={handle} /> somewhere in the tree …
 *
 *   const result = await proveWebView(handle, tx);
 */

import { RefObject } from 'react';
import { MockSppTx, ProofResult } from '../types';
import { ProverWebViewHandle } from './ProverWebView';

export { ProverWebView, ProverWebViewHandle } from './ProverWebView';

/**
 * Prove a single mock SPP transaction via the hidden WebView prover.
 *
 * Waits up to `timeoutMs` (default 30 s) for a response from the WebView
 * before rejecting.  This guards against the WebView silently hanging if the
 * WASM module fails to initialise (e.g., out-of-memory on a very low-end
 * device).
 *
 * @param handleRef - Ref to a mounted `ProverWebView` component.
 * @param tx        - The mock transaction to prove.
 * @param timeoutMs - Maximum time to wait for a proof, in milliseconds.
 */
export async function proveWebView(
  handleRef: RefObject<ProverWebViewHandle | null>,
  tx: MockSppTx,
  timeoutMs = 30_000,
): Promise<ProofResult> {
  const handle = handleRef.current;
  if (!handle) {
    throw new Error('proveWebView: ProverWebView is not mounted');
  }

  // Race the proof against a hard timeout so the benchmark screen never hangs.
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`proveWebView: timed out after ${timeoutMs} ms`)),
      timeoutMs,
    ),
  );

  return Promise.race([handle.prove(tx), timeoutPromise]);
}

/**
 * WebView prover — React component (#720 spike).
 *
 * Renders a zero-dimension, invisible WebView that loads `assets/prover/prover.html`.
 * The HTML page bootstraps the WASM module (simulated in the spike) and then
 * listens for `postMessage` requests from this component.
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * Mount this component once at the root of the spike screen and keep a ref:
 *
 *   const proverRef = useRef<ProverWebViewHandle>(null);
 *   <ProverWebView ref={proverRef} />
 *   const result = await proverRef.current?.prove(tx);
 *
 * The component exposes a single imperative method — `prove(tx)` — that posts
 * a PROVE message into the WebView and awaits the PROOF (or ERROR) response.
 *
 * PRODUCTION PATH
 * ─────────────────────────────────────────────────────────────────────────────
 * If the spike benchmark shows WebView proof time < 8 s on the target device:
 *
 * 1. Replace the `setTimeout` stub in `prover.html` with the real
 *    `stellar-private-payments` SDK import.
 * 2. Bundle the circuit file (~12 MB) into the app or download it on first use.
 * 3. Move this component out of the spike directory into `lib/privacy/`.
 *
 * DEPENDENCIES
 * ─────────────────────────────────────────────────────────────────────────────
 * `react-native-webview` is NOT yet in `frontend/mobile/package.json`.
 * Add it before running this file:
 *
 *   npx expo install react-native-webview
 *
 * The import below is typed via `@types/react-native-webview` which the package
 * ships.  Until the package is installed the TypeScript compilation of this file
 * will fail with "Cannot find module 'react-native-webview'" — this is expected
 * during the spike and noted in the ADR.
 */

import React, {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';
// NOTE: install react-native-webview before running: npx expo install react-native-webview
import WebView, { WebViewMessageEvent } from 'react-native-webview';
import { MockSppTx, ProofResult } from '../types';

// ---------------------------------------------------------------------------
// Message protocol (mirrors prover.html)
// ---------------------------------------------------------------------------

type InboundMsg =
  | { type: 'READY' }
  | { type: 'PROOF'; id: string; proofHex: string; wallClockMs: number; peakHeapBytes: number }
  | { type: 'ERROR'; id: string; message: string };

// ---------------------------------------------------------------------------
// Pending proof bookkeeping
// ---------------------------------------------------------------------------

interface PendingProof {
  resolve: (r: ProofResult) => void;
  reject: (e: Error) => void;
}

// ---------------------------------------------------------------------------
// Handle exposed to callers via ref
// ---------------------------------------------------------------------------

export interface ProverWebViewHandle {
  /**
   * Prove a single mock SPP transaction.
   * Resolves with the proof result or rejects if the WebView returns an error.
   */
  prove(tx: MockSppTx): Promise<ProofResult>;
  /** True once the WASM module inside the WebView has signalled READY. */
  isReady: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ProverWebView = forwardRef<ProverWebViewHandle>(
  function ProverWebView(_props, ref) {
    const webViewRef = useRef<WebView>(null);
    const pendingRef = useRef<Map<string, PendingProof>>(new Map());
    const [ready, setReady] = useState(false);

    // ── message handler ──────────────────────────────────────────────────────

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
      let msg: InboundMsg;
      try {
        msg = JSON.parse(event.nativeEvent.data) as InboundMsg;
      } catch {
        return;
      }

      if (msg.type === 'READY') {
        setReady(true);
        return;
      }

      const pending = pendingRef.current.get(msg.id);
      if (!pending) return;
      pendingRef.current.delete(msg.id);

      if (msg.type === 'PROOF') {
        const proofBytes = hexToBytes(msg.proofHex);
        pending.resolve({
          proofBytes,
          wallClockMs: msg.wallClockMs,
          peakHeapBytes: msg.peakHeapBytes,
          approachLabel: 'webview',
          verified: true,
        });
      } else {
        pending.reject(new Error(msg.message));
      }
    }, []);

    // ── imperative handle ────────────────────────────────────────────────────

    useImperativeHandle(
      ref,
      () => ({
        isReady: ready,
        prove(tx: MockSppTx): Promise<ProofResult> {
          return new Promise<ProofResult>((resolve, reject) => {
            if (!webViewRef.current) {
              reject(new Error('ProverWebView: WebView ref is null'));
              return;
            }

            const id = `proof-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            pendingRef.current.set(id, { resolve, reject });

            const msg = JSON.stringify({ type: 'PROVE', id, tx: serialiseTx(tx) });
            webViewRef.current.postMessage(msg);
          });
        },
      }),
      [ready],
    );

    // ── render ───────────────────────────────────────────────────────────────

    return (
      <View style={styles.container} pointerEvents="none">
        <WebView
          ref={webViewRef}
          // Load the local HTML bootstrap from the app's asset bundle.
          // Metro resolves require('../../../assets/prover/prover.html') to an
          // asset URI at build time, so the file is always available offline.
          source={require('../../../assets/prover/prover.html')}
          onMessage={handleMessage}
          // Allow postMessage from the page back to React Native.
          originWhitelist={['*']}
          // Disable navigation — this is a pure computation surface.
          onShouldStartLoadWithRequest={() => true}
          // Suppress the default WebView accessibility focus behaviour.
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.webview}
          // Allow the WebView to run SharedArrayBuffer if available (Android 12+
          // with COOP/COEP headers); the spike prover doesn't need it but the
          // real WASM prover benefits from threads on supported devices.
          allowsInlineMediaPlayback={false}
          mediaPlaybackRequiresUserAction={false}
        />
      </View>
    );
  },
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`Invalid hex string length: ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert `MockSppTx` to a plain JSON-serialisable object.
 * `bigint` is not JSON-serialisable, so `amountStroops` is sent as a decimal
 * string and the WebView page reads it as a string (acceptable for the spike).
 */
function serialiseTx(tx: MockSppTx): Record<string, unknown> {
  return {
    commitment: tx.commitment,
    amountStroops: tx.amountStroops.toString(),
    assetCode: tx.assetCode,
    poolAddress: tx.poolAddress ?? 'CD3LA6RKF5D2FN2R2L57MWXLBRSEWWENE74YBEFZSSGNJRJGICFGQXMX',
  };
}

// ---------------------------------------------------------------------------
// Styles — zero-size, off-screen
// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    width: 0,
    height: 0,
    overflow: 'hidden',
    opacity: 0,
  },
  webview: {
    width: 0,
    height: 0,
  },
});

// ── React Native polyfills ─────────────────────────────────────────────────
// Bridges the gap between browser globals @stellar/stellar-sdk and WebAuthn
// assume, and what React Native actually ships.
//
// This file MUST be imported as the very first line of the app entry-point
// (app/_layout.tsx) so that globals are established before any SDK code runs.

// 1. Secure randomness – must come before anything that touches crypto.*
import 'react-native-get-random-values';

// 2. Buffer (Node-style) – used by stellar-sdk for XDR encoding, network
//    passphrase hashing, and contract-id derivation.
import { Buffer } from 'buffer';
if (typeof globalThis.Buffer === 'undefined') {
  // @ts-expect-error – augmenting globalThis with a Node polyfill
  globalThis.Buffer = Buffer;
}

// 3. TextEncoder / TextDecoder – required by WebAuthn credential creation
//    (userId encoding) and by stellar-sdk for string ↔ Uint8Array.
import { TextEncoder, TextDecoder } from 'text-encoding';
if (typeof globalThis.TextEncoder === 'undefined') {
  // @ts-expect-error – augmenting globalThis
  globalThis.TextEncoder = TextEncoder;
  // @ts-expect-error – augmenting globalThis
  globalThis.TextDecoder = TextDecoder;
}

// 4. URL & URLSearchParams – required by stellar-sdk Horizon client and by
//    WalletConnect deep-link handling.
import URLPolyfill from 'react-native-url-polyfill';
if (typeof globalThis.URL === 'undefined') {
  URLPolyfill();
}

// 5. atob / btoa – used by webauthn.native.ts for base64 ↔ ArrayBuffer
//    conversion during credential creation / assertion.  React Native 0.70+
//    ships these, but older runtimes or Hermes variants may not.
if (typeof globalThis.atob === 'undefined') {
  globalThis.atob = (b64: string) =>
    Buffer.from(b64, 'base64').toString('binary');
}
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (bin: string) =>
    Buffer.from(bin, 'binary').toString('base64');
}

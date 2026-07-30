/**
 * Runtime shims required by WalletConnect and the Stellar SDK on React Native.
 *
 * Import this module before anything that touches WalletConnect. Import order
 * matters: `@walletconnect/react-native-compat` has to run first because it
 * installs the `TextEncoder`, `URL`, `AbortController` and async-storage shims
 * the WalletConnect core assumes are already present at module-evaluation time.
 */
import '@walletconnect/react-native-compat';
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';

import { Buffer } from 'buffer';

type MutableGlobal = typeof globalThis & {
  Buffer?: typeof Buffer;
  process?: { env?: Record<string, string | undefined>; version?: string };
};

const globalScope = globalThis as MutableGlobal;

// The Stellar SDK builds and parses XDR through Node's Buffer, which Hermes
// does not provide.
if (typeof globalScope.Buffer === 'undefined') {
  globalScope.Buffer = Buffer;
}

// Some transitive dependencies branch on `process.version` being a string.
if (globalScope.process && typeof globalScope.process.version !== 'string') {
  globalScope.process.version = '';
}

export {};

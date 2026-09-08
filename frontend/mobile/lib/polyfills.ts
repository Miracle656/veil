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
  AbortSignal?: typeof AbortSignal;
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

/**
 * `AbortSignal.timeout(ms)` — standard since 2022, absent in Hermes.
 *
 * Seven call sites use it: the activity feed and the whole SEP-24
 * deposit/withdraw flow. Every one typechecked, passed review and passed CI,
 * because jest runs on Node where the method has existed for years — a device
 * was the only place it could fail, and it did, as soon as the feed had a
 * wraith URL to fetch from.
 *
 * Shimmed once here rather than rewritten at each call site, so code written
 * against the standard keeps working and an eighth use cannot reintroduce it.
 */
const signalCtor = globalScope.AbortSignal as unknown as
  | { timeout?: (ms: number) => AbortSignal }
  | undefined;

if (signalCtor && typeof signalCtor.timeout !== 'function') {
  signalCtor.timeout = (ms: number): AbortSignal => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    // Clear on abort so a request that finishes early does not hold a timer for
    // the rest of the window. Nothing reports that the fetch resolved, so this
    // is the only hook available.
    controller.signal.addEventListener?.('abort', () => clearTimeout(timer));
    return controller.signal;
  };
}

export {};

/**
 * Web build of the runtime shims — the counterpart to `./polyfills.ts`.
 *
 * Metro resolves this `.web.ts` variant on the web target and `polyfills.ts` on
 * native, so the two never mix. On react-native-web the browser already provides
 * `crypto.getRandomValues`, `URL`, `TextEncoder` and `AbortController`, so the
 * React-Native polyfills the native file imports are unnecessary here — and
 * `@walletconnect/react-native-compat` actively *breaks* the web bundle: it
 * reaches for a native `Application` module that does not exist on web and throws
 * at module-evaluation time, before the first screen paints. Omitting these
 * imports lets the app boot on web (useful for previewing UI in a browser);
 * WalletConnect's React-Native transport isn't used on web anyway.
 *
 * Only Buffer (the Stellar SDK builds and parses XDR through it) and a string
 * `process.version` still need shimming, so those are kept identical to the
 * native file.
 */
import { Buffer } from 'buffer';

type MutableGlobal = typeof globalThis & {
  Buffer?: typeof Buffer;
  process?: { env?: Record<string, string | undefined>; version?: string };
};

const globalScope = globalThis as MutableGlobal;

if (typeof globalScope.Buffer === 'undefined') {
  globalScope.Buffer = Buffer;
}

if (globalScope.process && typeof globalScope.process.version !== 'string') {
  globalScope.process.version = '';
}

export {};

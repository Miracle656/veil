// jsdom ships no `crypto.subtle`, and the WebAuthn suites import ECDSA P-256
// keys through it. Node's own WebCrypto is exactly the implementation these
// tests need, so hand jsdom the real thing rather than a stub.
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
  });
}

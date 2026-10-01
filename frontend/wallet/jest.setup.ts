// jest.setup.ts — polyfills for the jsdom test environment
//
// jsdom does not ship TextEncoder/TextDecoder. Node's implementations (from
// 'util') must be installed as-is: @exodus/bytes probes `String(TextEncoder)`
// for '[native code]' to select its native code paths and calls
// TextDecoder.decode() with Uint16Array input (UTF-16 code units), so wrapper
// shims silently corrupt base32/strkey output. The one cross-realm hazard —
// Node's encode() returning a Node-realm Uint8Array, which fails
// `instanceof Uint8Array` in the jsdom realm (stellar-sdk 17's BytesValue and
// uint8array-extras depend on it) — is fixed by rewrapping encode()'s result
// on the prototype, keeping the class itself native.
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'TextEncoder', {
  value: TextEncoder,
  writable: true,
  configurable: true,
})
Object.defineProperty(globalThis, 'TextDecoder', {
  value: TextDecoder,
  writable: true,
  configurable: true,
})

const nativeEncode = TextEncoder.prototype.encode
TextEncoder.prototype.encode = function (source = '') {
  return Uint8Array.from(nativeEncode.call(this, source))
}

// jsdom does not expose crypto.subtle — polyfill with Node's webcrypto implementation.
import { webcrypto } from 'crypto'

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    writable: true,
    configurable: true,
  })
}

// jest.setup.ts — polyfills for the jsdom test environment
// TextEncoder / TextDecoder are used by @stellar/stellar-sdk but are not
// provided by older versions of jsdom bundled with jest-environment-jsdom.
import { TextEncoder, TextDecoder } from 'util'
import { webcrypto } from 'crypto'

Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder, writable: true })
Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder, writable: true })

// jsdom does not expose crypto.subtle — polyfill with Node's webcrypto implementation.
if (!globalThis.crypto || !globalThis.crypto.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        writable: true,
        configurable: true,
    })
}

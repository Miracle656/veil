// jest.setup.ts — polyfills for the jsdom test environment
// TextEncoder / TextDecoder are used by @stellar/stellar-sdk but are not
// provided by older versions of jsdom bundled with jest-environment-jsdom.
import { TextDecoder } from 'util'
import { webcrypto } from 'crypto'

// Node's TextEncoder returns a Uint8Array from Node's realm, while code under
// jsdom compares it with the jsdom realm's `Uint8Array` (`instanceof`). SDK 17's
// XDR layer does exactly that, so encode into this realm's Uint8Array instead.
class RealmTextEncoder {
    encode(input = ''): Uint8Array {
        return new Uint8Array(Buffer.from(input, 'utf8'))
    }
    encodeInto(input: string, destination: Uint8Array): { read: number; written: number } {
        const bytes = new Uint8Array(Buffer.from(input, 'utf8'))
        const written = Math.min(bytes.length, destination.length)
        destination.set(bytes.subarray(0, written))
        return { read: input.length, written }
    }
}

Object.defineProperty(globalThis, 'TextEncoder', { value: RealmTextEncoder, writable: true })
Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder, writable: true })

// jsdom does not expose crypto.subtle — polyfill with Node's webcrypto implementation.
if (!globalThis.crypto || !globalThis.crypto.subtle) {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        writable: true,
        configurable: true,
    })
}

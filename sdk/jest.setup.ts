// jest.setup.ts — polyfills for the jsdom test environment
// TextEncoder / TextDecoder are used by @stellar/stellar-sdk but are not
// provided by older versions of jsdom bundled with jest-environment-jsdom.
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'TextEncoder', { value: TextEncoder, writable: true })
Object.defineProperty(globalThis, 'TextDecoder', { value: TextDecoder, writable: true })

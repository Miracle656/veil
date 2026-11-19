/**
 * Jest runs in jsdom, whose globals (Uint8Array, TextEncoder output) come from a
 * different realm than Node's Buffer and `util`'s TextEncoder. SDK 17 validates
 * byte arrays with `instanceof Uint8Array`, so a Buffer produced by Node looks
 * like a plain object to it. Point the global at Node's actual Uint8Array so
 * every Buffer, TextEncoder result and SDK value shares one realm.
 */
const NodeUint8Array = Object.getPrototypeOf(Buffer.prototype).constructor

globalThis.Uint8Array = NodeUint8Array
if (typeof window !== 'undefined') {
  window.Uint8Array = NodeUint8Array
}

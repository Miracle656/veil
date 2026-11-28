module.exports = {
  isUint8Array: (v) => v instanceof Uint8Array,
  concatUint8Arrays: (arrays) => Buffer.concat(arrays),
  toUint8Array: (v) => Uint8Array.from(v),
  areUint8ArraysEqual: (a, b) => Buffer.compare(a, b) === 0,
}

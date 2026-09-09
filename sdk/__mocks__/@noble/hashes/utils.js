/**
 * CJS wrapper for @noble/hashes/utils.js (ESM-only), alongside the sha2 one.
 *
 * These are byte-plumbing helpers and argument assertions rather than crypto —
 * hex/utf8 conversion, buffer views, endianness — so implementing them here
 * risks nothing that a hashing shim would. The assertions are kept strict on
 * purpose: they are what catch a wrong-typed or wrong-length argument in the
 * signing path, and a permissive version of them would quietly accept input the
 * real library rejects.
 *
 * Only what @stellar/stellar-sdk reaches for is implemented. Anything else
 * throws by name rather than returning undefined, so a future import fails
 * where it is used instead of somewhere further along.
 */

const crypto = require('crypto');

const isBytes = (a) => a instanceof Uint8Array || (ArrayBuffer.isView(a) && a.constructor.name === 'Uint8Array');

function abytes(b, ...lengths) {
  if (!isBytes(b)) throw new Error('Uint8Array expected');
  if (lengths.length > 0 && !lengths.includes(b.length)) {
    throw new Error(`Uint8Array expected of length ${lengths}, got length=${b.length}`);
  }
  return b;
}

function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`positive integer expected, got ${n}`);
}

function abool(b) {
  if (typeof b !== 'boolean') throw new Error(`boolean expected, not ${b}`);
}

function ahash(h) {
  if (typeof h !== 'function' || typeof h.create !== 'function') {
    throw new Error('Hash should be wrapped by utils.createHasher');
  }
  anumber(h.outputLen);
  anumber(h.blockLen);
}

function aexists(instance, checkFinished = true) {
  if (instance.destroyed) throw new Error('Hash instance has been destroyed');
  if (checkFinished && instance.finished) throw new Error('Hash#digest() has already been called');
}

function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) throw new Error(`digestInto() expects output buffer of length at least ${min}`);
}

const u8 = (arr) => new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
const u32 = (arr) =>
  new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));

const createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);

const clean = (...arrays) => {
  for (const arr of arrays) arr.fill(0);
};

const copyBytes = (bytes) => Uint8Array.from(bytes);

const rotr = (word, shift) => (word << (32 - shift)) | (word >>> shift);
const rotl = (word, shift) => ((word << shift) | (word >>> (32 - shift))) >>> 0;

const isLE = new Uint8Array(new Uint32Array([0x11223344]).buffer)[0] === 0x44;

const byteSwap = (word) =>
  ((word << 24) & 0xff000000) |
  ((word << 8) & 0x00ff0000) |
  ((word >>> 8) & 0x0000ff00) |
  ((word >>> 24) & 0x000000ff);

const swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n);

function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) arr[i] = byteSwap(arr[i]);
  return arr;
}

const swap32IfBE = isLE ? (u) => u : byteSwap32;

const HEX = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function bytesToHex(bytes) {
  abytes(bytes);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += HEX[bytes[i]];
  return hex;
}

function hexToBytes(hex) {
  if (typeof hex !== 'string') throw new Error('hex string expected, got ' + typeof hex);
  const hl = hex.length;
  if (hl % 2) throw new Error('hex string expected, got unpadded hex of length ' + hl);
  const array = new Uint8Array(hl / 2);
  for (let ai = 0, hi = 0; ai < array.length; ai++, hi += 2) {
    const byte = Number.parseInt(hex.slice(hi, hi + 2), 16);
    if (Number.isNaN(byte)) throw new Error('hex string expected, got non-hex character');
    array[ai] = byte;
  }
  return array;
}

const nextTick = async () => {};

function utf8ToBytes(str) {
  if (typeof str !== 'string') throw new Error('string expected');
  return new Uint8Array(new TextEncoder().encode(str));
}

const kdfInputToBytes = (data) => (typeof data === 'string' ? utf8ToBytes(data) : copyBytes(abytes(data)));

function concatBytes(...arrays) {
  let sum = 0;
  for (const a of arrays) {
    abytes(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    res.set(arrays[i], pad);
    pad += arrays[i].length;
  }
  return res;
}

function checkOpts(defaults, opts) {
  if (opts !== undefined && typeof opts !== 'object') throw new Error('options should be object or undefined');
  return Object.assign(defaults, opts);
}

function validateObject(object, fields) {
  if (object == null || typeof object !== 'object') throw new Error('expected valid options object');
  return object;
}

function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(kdfInputToBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}

const randomBytes = (bytesLength = 32) => new Uint8Array(crypto.randomBytes(bytesLength));

const oidNist = (suffix) => ({ suffix });

/** Anything not implemented fails by name at its import site, not later. */
const notImplemented = (name) => () => {
  throw new Error(`@noble/hashes/utils shim: ${name}() is not implemented`);
};

module.exports = {
  isBytes,
  anumber,
  abool,
  abytes,
  copyBytes,
  ahash,
  aexists,
  aoutput,
  u8,
  u32,
  clean,
  createView,
  rotr,
  rotl,
  isLE,
  byteSwap,
  swap8IfBE,
  byteSwap32,
  swap32IfBE,
  bytesToHex,
  hexToBytes,
  nextTick,
  utf8ToBytes,
  kdfInputToBytes,
  concatBytes,
  validateObject,
  checkOpts,
  createHasher,
  randomBytes,
  oidNist,
  notImplemented,
};

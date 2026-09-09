/**
 * Mock for uint8array-extras (ESM-only) that uses native Node.js APIs.
 *
 * When @stellar/stellar-sdk@17's CJS build requires() this ESM-only package,
 * Jest/Babel transforms it into a separate module realm. The Uint8Array
 * created by one realm fails `instanceof Uint8Array` in another. This mock
 * uses duck-typing to detect Uint8Array across realms, and always returns
 * native Uint8Array instances so the SDK's own checks work.
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Duck-typed check that works across realms / Babel-transformed modules.
function isU8A(v) {
  return v != null && typeof v === 'object' && typeof v.length === 'number'
    && typeof v.byteLength === 'number' && typeof v.BYTES_PER_ELEMENT === 'number';
}

function toNativeU8A(v) {
  if (v instanceof Uint8Array) return v;
  if (isU8A(v)) return new Uint8Array(v);
  return null;
}

function assertString(value) {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected \`string\`, got \`${typeof value}\``);
  }
}

function stringToUint8Array(string) {
  // Gracefully handle Uint8Array or Uint8Array-like objects that fail instanceof
  const native = toNativeU8A(string);
  if (native) return native;
  assertString(string);
  return encoder.encode(string);
}

function uint8ArrayToString(array, encoding = 'utf8') {
  const native = toNativeU8A(array);
  if (!native) throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof array}\``);
  if (encoding === 'hex') {
    return Array.from(native).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  if (encoding === 'base64') {
    return Buffer.from(native).toString('base64');
  }
  return decoder.decode(native);
}

function concatUint8Arrays(arrays, totalLength) {
  if (totalLength === undefined) {
    totalLength = arrays.reduce((sum, arr) => sum + (arr.length || arr.byteLength), 0);
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    const native = toNativeU8A(arr);
    if (!native) throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof arr}\``);
    result.set(native, offset);
    offset += native.length;
  }
  return result;
}

function areUint8ArraysEqual(a, b) {
  const na = toNativeU8A(a), nb = toNativeU8A(b);
  if (!na || !nb) return false;
  if (na.length !== nb.length) return false;
  for (let i = 0; i < na.length; i++) {
    if (na[i] !== nb[i]) return false;
  }
  return true;
}

function compareUint8Arrays(a, b) {
  const na = toNativeU8A(a), nb = toNativeU8A(b);
  if (!na || !nb) throw new TypeError('Expected Uint8Array');
  const len = Math.min(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    if (na[i] < nb[i]) return -1;
    if (na[i] > nb[i]) return 1;
  }
  return na.length - nb.length;
}

function toUint8Array(value) {
  const native = toNativeU8A(value);
  if (native) return native;
  if (typeof value === 'string') return encoder.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`Cannot convert ${typeof value} to Uint8Array`);
}

function uint8ArrayToBase64(array, { urlSafe = false } = {}) {
  const native = toNativeU8A(array);
  if (!native) throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof array}\``);
  let b64 = Buffer.from(native).toString('base64');
  if (urlSafe) {
    b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return b64;
}

function base64ToUint8Array(base64String) {
  assertString(base64String);
  const b64 = base64String.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '==='.slice(b64.length % 4 || 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

function stringToBase64(string, { urlSafe = false } = {}) {
  return uint8ArrayToBase64(stringToUint8Array(string), { urlSafe });
}

function base64ToString(base64String) {
  return uint8ArrayToString(base64ToUint8Array(base64String));
}

function uint8ArrayToHex(array) {
  const native = toNativeU8A(array);
  if (!native) throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof array}\``);
  return Array.from(native).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToUint8Array(hexString) {
  assertString(hexString);
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    bytes[i / 2] = parseInt(hexString.substr(i, 2), 16);
  }
  return bytes;
}

function indexOf(array, value) {
  const native = toNativeU8A(array);
  if (!native) throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof array}\``);
  for (let i = 0; i < native.length; i++) {
    if (native[i] === value) return i;
  }
  return -1;
}

function includes(array, value) {
  return indexOf(array, value) !== -1;
}

function getUintBE(view) {
  const native = toNativeU8A(view);
  if (!native) throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof view}\``);
  let result = 0;
  for (let i = 0; i < native.length; i++) {
    result = (result << 8) | native[i];
  }
  return result;
}

function isUint8Array(value) {
  return isU8A(value);
}

function assertUint8Array(value) {
  if (!toNativeU8A(value)) {
    throw new TypeError(`Expected \`Uint8Array\`, got \`${typeof value}\``);
  }
}

function assertUint8ArrayOrArrayBuffer(value) {
  if (!toNativeU8A(value) && !(value instanceof ArrayBuffer)) {
    throw new TypeError(`Expected \`Uint8Array\` or \`ArrayBuffer\`, got \`${typeof value}\``);
  }
}

module.exports = {
  isUint8Array,
  assertUint8Array,
  assertUint8ArrayOrArrayBuffer,
  toUint8Array,
  concatUint8Arrays,
  areUint8ArraysEqual,
  compareUint8Arrays,
  uint8ArrayToString,
  stringToUint8Array,
  uint8ArrayToBase64,
  base64ToUint8Array,
  stringToBase64,
  base64ToString,
  uint8ArrayToHex,
  hexToUint8Array,
  getUintBE,
  indexOf,
  includes,
};

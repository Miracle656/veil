/**
 * CJS wrapper for @exodus/bytes/base32.js (ESM-only).
 * Provides toBase32 and fromBase32 with RFC 4648 base32 encoding.
 */
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function toBase32(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < input.length; i++) {
    value = (value << 8) | input[i];
    bits += 8;
    while (bits >= 5) {
      output += CHARSET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CHARSET[(value << (5 - bits)) & 31];
  }
  return output;
}

function fromBase32(str, opts) {
  const strict = opts?.strict !== false;
  const padding = opts?.padding;
  const input = str.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output = [];

  for (let i = 0; i < input.length; i++) {
    const idx = CHARSET.indexOf(input[i]);
    if (idx === -1) {
      if (strict) throw new TypeError('Invalid base32 character: ' + str[i]);
      continue;
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return new Uint8Array(output);
}

module.exports = { toBase32, fromBase32, encode: toBase32, decode: fromBase32 };

import { Buffer } from 'buffer';

/**
 * WebAuthn encoding helpers.
 *
 * `react-native-passkeys` speaks the JSON WebAuthn dialect — every binary field
 * arrives base64url-encoded — while the Soroban wallet contract wants raw bytes
 * and a 64-byte `r ‖ s` signature. Ported from `sdk/src/utils.ts`; kept in the
 * mobile app so it has no dependency on the browser SDK build.
 */

export function base64UrlToUint8Array(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return new Uint8Array(Buffer.from(padded, 'base64'));
}

export function uint8ArrayToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const array = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) throw new Error('Invalid hex string');
    array[i / 2] = byte;
  }
  return array;
}

// SECP256R1 (P-256) curve order n. Soroban's secp256r1_verify host function
// rejects signatures where s > n/2 ("non-low-S form") to prevent malleability.
// WebAuthn authenticators don't always return low-S, so we must normalise.
const SECP256R1_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const SECP256R1_HALF_N = SECP256R1_N >> 1n;

/** If s > n/2, replace it with (n - s). Returns 32-byte big-endian. */
function normalizeLowS(sBytes: Uint8Array): Uint8Array {
  let s = 0n;
  for (const byte of sBytes) s = (s << 8n) | BigInt(byte);
  if (s > SECP256R1_HALF_N) s = SECP256R1_N - s;

  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(s & 0xffn);
    s >>= 8n;
  }
  return out;
}

/**
 * Normalise a DER integer component to exactly 32 bytes.
 *
 * DER prefixes a 0x00 byte to mark a positive value whose high bit is set; strip
 * that, and left-pad with zeros when the value is shorter than 32 bytes.
 */
function padOrTrim32(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 32 && bytes[start] === 0) start += 1;

  const trimmed = bytes.slice(start);
  if (trimmed.length > 32) throw new Error('Integer component too large for P-256');

  const padded = new Uint8Array(32);
  padded.set(trimmed, 32 - trimmed.length);
  return padded;
}

/**
 * Convert an ASN.1 DER-encoded P-256 ECDSA signature to raw 64-byte (r ‖ s)
 * form, normalising s to low form so Soroban's `secp256r1_verify` accepts it.
 *
 * DER structure: `30 <totalLen> 02 <rLen> <r> 02 <sLen> <s>`.
 */
export function derToRawSignature(derSig: Uint8Array): Uint8Array {
  const der = derSig;

  if (der[0] !== 0x30) throw new Error('DER: expected SEQUENCE (0x30)');
  // der[1] is the total length — skip it.
  let offset = 2;

  if (der[offset] !== 0x02) throw new Error('DER: expected INTEGER tag for r');
  offset += 1;
  const rLen = der[offset];
  offset += 1;
  const rRaw = der.slice(offset, offset + rLen);
  offset += rLen;

  if (der[offset] !== 0x02) throw new Error('DER: expected INTEGER tag for s');
  offset += 1;
  const sLen = der[offset];
  offset += 1;
  const sRaw = der.slice(offset, offset + sLen);

  const raw = new Uint8Array(64);
  raw.set(padOrTrim32(rRaw), 0);
  raw.set(normalizeLowS(padOrTrim32(sRaw)), 32);
  return raw;
}

import {
  base64UrlToUint8Array,
  derToRawSignature,
  hexToUint8Array,
  uint8ArrayToBase64Url,
} from '../webauthn';

// SECP256R1 (P-256) curve order.
const SECP256R1_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function bigIntTo32Bytes(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let remaining = value;
  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** Encode an integer the way DER does, with a 0x00 prefix when the high bit is set. */
function derInteger(bytes: Uint8Array): number[] {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = Array.from(bytes.slice(start));
  const body = trimmed[0] & 0x80 ? [0x00, ...trimmed] : trimmed;
  return [0x02, body.length, ...body];
}

function buildDerSignature(r: Uint8Array, s: Uint8Array): Uint8Array {
  const body = [...derInteger(r), ...derInteger(s)];
  return new Uint8Array([0x30, body.length, ...body]);
}

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base64UrlToUint8Array(uint8ArrayToBase64Url(bytes))).toEqual(bytes);
  });

  it('emits url-safe output with no padding', () => {
    // 0xFB 0xFF 0xBF is "+/+/" in standard base64.
    const encoded = uint8ArrayToBase64Url(new Uint8Array([0xfb, 0xff, 0xbf]));
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64UrlToUint8Array(encoded)).toEqual(new Uint8Array([0xfb, 0xff, 0xbf]));
  });

  it('decodes input that already lacks padding', () => {
    expect(base64UrlToUint8Array('AQID')).toEqual(new Uint8Array([1, 2, 3]));
    expect(base64UrlToUint8Array('AQI')).toEqual(new Uint8Array([1, 2]));
  });

  it('handles the empty string', () => {
    expect(uint8ArrayToBase64Url(new Uint8Array())).toBe('');
    expect(base64UrlToUint8Array('')).toEqual(new Uint8Array());
  });
});

describe('hexToUint8Array', () => {
  it('decodes a hex public key', () => {
    expect(hexToUint8Array('04ff00')).toEqual(new Uint8Array([0x04, 0xff, 0x00]));
  });

  it('rejects malformed input', () => {
    expect(() => hexToUint8Array('abc')).toThrow('Invalid hex string');
    expect(() => hexToUint8Array('zz')).toThrow('Invalid hex string');
  });
});

describe('derToRawSignature', () => {
  it('produces 64 raw bytes from a DER signature', () => {
    const r = bigIntTo32Bytes(0x1234n);
    const s = bigIntTo32Bytes(0x5678n);

    const raw = derToRawSignature(buildDerSignature(r, s));

    expect(raw).toHaveLength(64);
    expect(raw.slice(0, 32)).toEqual(r);
    expect(raw.slice(32)).toEqual(s);
  });

  it('left-pads short integer components to 32 bytes', () => {
    // A DER integer carries no leading zeros, so a small r arrives short.
    const der = new Uint8Array([0x30, 0x08, 0x02, 0x01, 0x07, 0x02, 0x03, 0x01, 0x02, 0x03]);

    const raw = derToRawSignature(der);

    expect(raw.slice(0, 32)).toEqual(bigIntTo32Bytes(0x07n));
    expect(raw.slice(32)).toEqual(bigIntTo32Bytes(0x010203n));
  });

  it('strips the DER sign byte on components with the high bit set', () => {
    const r = bigIntTo32Bytes(SECP256R1_N >> 2n); // high bit set, needs 0x00 prefix
    const s = bigIntTo32Bytes(0x01n);

    const raw = derToRawSignature(buildDerSignature(r, s));

    expect(raw.slice(0, 32)).toEqual(r);
  });

  it('normalises a high-S signature to low-S for secp256r1_verify', () => {
    const halfN = SECP256R1_N >> 1n;
    const highS = halfN + 1000n;
    const raw = derToRawSignature(
      buildDerSignature(bigIntTo32Bytes(0x1234n), bigIntTo32Bytes(highS))
    );

    const normalized = bytesToBigInt(raw.slice(32));
    expect(normalized).toBe(SECP256R1_N - highS);
    expect(normalized <= halfN).toBe(true);
  });

  it('leaves an already-low S untouched', () => {
    const lowS = (SECP256R1_N >> 1n) - 1000n;
    const raw = derToRawSignature(
      buildDerSignature(bigIntTo32Bytes(0x1234n), bigIntTo32Bytes(lowS))
    );

    expect(bytesToBigInt(raw.slice(32))).toBe(lowS);
  });

  it('rejects input that is not a DER ECDSA signature', () => {
    expect(() => derToRawSignature(new Uint8Array([0x31, 0x00]))).toThrow(/SEQUENCE/);
    expect(() => derToRawSignature(new Uint8Array([0x30, 0x02, 0x03, 0x00]))).toThrow(
      /INTEGER tag for r/
    );
    expect(() =>
      derToRawSignature(new Uint8Array([0x30, 0x05, 0x02, 0x01, 0x07, 0x03, 0x00]))
    ).toThrow(/INTEGER tag for s/);
  });
});

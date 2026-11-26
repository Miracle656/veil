/**
 * Tests for `derToRawSignature` (sdk/src/utils.ts) — the DER → raw P-256
 * signature parsing on the WebAuthn/passkey signing path.
 *
 * When a passkey signs, the authenticator returns an ASN.1 DER-encoded
 * ECDSA signature; Soroban's `secp256r1_verify` expects raw `r ‖ s`
 * (32 bytes each) with `s` in low form. `derToRawSignature` performs that
 * conversion and is exercised here against fixed test vectors.
 *
 * Vector provenance: each vector was constructed from a fixed (r, s) pair
 * using the DER encoding rules (SEQUENCE of two INTEGERs, minimal-length
 * big-endian, a leading 0x00 byte iff the top bit is set) and cross-checked
 * with an independent BigInt DER decoder — the expected outputs below are
 * NOT produced by the function under test. The high-S vector's expected
 * output is `n − s` (P-256 curve order minus s), matching the parser's
 * documented low-S normalisation.
 */

import { derToRawSignature } from '../utils';

function hexToArrayBuffer(hex: string): ArrayBuffer {
    const buf = new ArrayBuffer(hex.length / 2);
    const view = new Uint8Array(buf);
    for (let i = 0; i < view.length; i++) {
        view[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return buf;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

interface SignatureVector {
    name: string;
    /** DER-encoded signature (hex). */
    der: string;
    /** Expected raw r component (32 bytes, hex). */
    r: string;
    /** Expected raw s component (32 bytes, hex), after low-S normalisation. */
    s: string;
}

const VALID_VECTORS: SignatureVector[] = [
    {
        // Ordinary case: both components a full 32 bytes, s already low.
        name: 'parses a full-length signature with low-S',
        der:
            '30440220' +
            '2a3b4c5d6e7f8091122334455667788990aabbccddeeff001122334455667788' +
            '0220' +
            '1f2e3d4c5b6a79880102030405060708090a0b0c0d0e0f101112131415161718',
        r: '2a3b4c5d6e7f8091122334455667788990aabbccddeeff001122334455667788',
        s: '1f2e3d4c5b6a79880102030405060708090a0b0c0d0e0f101112131415161718',
    },
    {
        // r has its top bit set, so DER carries a 0x00 sign pad byte
        // (INTEGER length 33); the pad must be stripped from the output.
        name: 'strips the DER sign pad byte from a high-bit r',
        der:
            '30450221' +
            '00c5a3f09182736455a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718' +
            '0220' +
            '0badf00d1234567890abcdef1234567890abcdef1234567890abcdef12345678',
        r: 'c5a3f09182736455a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
        s: '0badf00d1234567890abcdef1234567890abcdef1234567890abcdef12345678',
    },
    {
        // s is a 31-byte value whose top byte (0xd4) forces a 0x00 pad in
        // DER (INTEGER length 32), but the value is far below n/2, so it
        // must pass through unchanged (left-padded with the zero byte).
        name: 'keeps a padded but low s unchanged',
        der:
            '30440220' +
            '5a6b7c8d9eafb0c1d2e3f40516273849506a7b8c9daebf001122334455667788' +
            '0220' +
            '00d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2',
        r: '5a6b7c8d9eafb0c1d2e3f40516273849506a7b8c9daebf001122334455667788',
        s: '00d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2',
    },
    {
        // r is a 20-byte value (DER INTEGER length 20); the raw output
        // must left-pad it to 32 bytes.
        name: 'left-pads a short r component to 32 bytes',
        der:
            '30380214' +
            '1234567890abcdef1234567890abcdef12345678' +
            '0220' +
            '23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01',
        r: '0000000000000000000000001234567890abcdef1234567890abcdef12345678',
        s: '23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01',
    },
    {
        // Minimal signature: r = 1, s = 2, each a single DER byte.
        name: 'parses a minimal-length signature (r = 1, s = 2)',
        der: '3006020101020102',
        r: '0000000000000000000000000000000000000000000000000000000000000001',
        s: '0000000000000000000000000000000000000000000000000000000000000002',
    },
    {
        // s > n/2 (high-S form, as some authenticators return): the output
        // s must be normalised to n − s so Soroban accepts the signature.
        // Encoded s:  e7b7c9f3…4d5e6f70
        // Expected s: 1848360b…f04b5e1  (= n − s)
        name: 'normalises a high-S signature to low-S (n − s)',
        der:
            '30450220' +
            '6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e' +
            '0221' +
            '00e7b7c9f3a1d5e8b2046f8a9c1d3e5f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
        r: '6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e',
        s: '1848360b5e2a174efb907563e2c1a08f3b5456f8e140b68cea9f9f86af04b5e1',
    },
];

describe('derToRawSignature', () => {
    describe('valid DER signatures', () => {
        for (const vector of VALID_VECTORS) {
            it(vector.name, () => {
                const raw = derToRawSignature(hexToArrayBuffer(vector.der));

                expect(raw).toBeInstanceOf(Uint8Array);
                expect(raw).toHaveLength(64);
                // r occupies the first 32 bytes, s the last 32 bytes.
                expect(bytesToHex(raw.slice(0, 32))).toBe(vector.r);
                expect(bytesToHex(raw.slice(32))).toBe(vector.s);
                expect(bytesToHex(raw)).toBe(vector.r + vector.s);
            });
        }
    });

    describe('malformed DER input', () => {
        it('throws on a wrong SEQUENCE tag', () => {
            // Same shape as a valid signature but starting with 0x31 (SET).
            const der =
                '31440220' +
                '2a3b4c5d6e7f8091122334455667788990aabbccddeeff001122334455667788' +
                '0220' +
                '1f2e3d4c5b6a79880102030405060708090a0b0c0d0e0f101112131415161718';
            expect(() => derToRawSignature(hexToArrayBuffer(der))).toThrow(
                'DER: expected SEQUENCE (0x30)'
            );
        });

        it('throws on empty input', () => {
            expect(() => derToRawSignature(new ArrayBuffer(0))).toThrow(
                'DER: expected SEQUENCE (0x30)'
            );
        });

        it('throws on garbage bytes', () => {
            expect(() =>
                derToRawSignature(hexToArrayBuffer('deadbeefcafe'))
            ).toThrow('DER: expected SEQUENCE (0x30)');
        });

        it('throws when the r INTEGER tag is wrong', () => {
            // 30 06 03 01 01 02 01 02 — r tagged 0x03 instead of 0x02.
            expect(() =>
                derToRawSignature(hexToArrayBuffer('3006030101020102'))
            ).toThrow('DER: expected INTEGER tag for r');
        });

        it('throws when the s INTEGER tag is wrong', () => {
            // 30 07 02 01 01 03 01 02 — s tagged 0x03 instead of 0x02.
            expect(() =>
                derToRawSignature(hexToArrayBuffer('3007020101030102'))
            ).toThrow('DER: expected INTEGER tag for s');
        });

        it('throws when input is truncated before the s INTEGER tag', () => {
            // 30 03 02 01 01 — a complete r INTEGER and nothing after it.
            expect(() =>
                derToRawSignature(hexToArrayBuffer('3003020101'))
            ).toThrow('DER: expected INTEGER tag for s');
        });

        it('throws when a component exceeds 32 bytes', () => {
            // r is a 34-byte INTEGER of 0xff bytes: even after sign-pad
            // handling it cannot fit a P-256 component.
            const der = '3027' + '0222' + 'ff'.repeat(34) + '020101';
            expect(() => derToRawSignature(hexToArrayBuffer(der))).toThrow(
                'Integer component too large for P-256'
            );
        });
    });
});

/**
 * Conformance tests for the `@noble/ed25519` Jest shim.
 *
 * `@stellar/stellar-sdk@17` pulls in ESM-only dependencies that Jest cannot
 * load, so `sdk/__mocks__/@noble/ed25519.js` stands in for the real library
 * during tests, reimplementing it over `node:crypto`.
 *
 * That substitution is only safe if the stand-in *behaves* like what it
 * replaces, and a shim is uniquely bad at telling you when it does not: it
 * never throws, so a wrong implementation shows up as tests that pass for the
 * wrong reason.
 *
 * That is not hypothetical here. The shim shipped with an invalid Ed25519 SPKI
 * DER prefix — the PKCS8 tail `04 22 04` where SPKI needs `03 21 00`. Node's
 * `createPublicKey` rejected the malformed DER, `verify()`'s bare
 * `catch { return false }` swallowed the throw, and **every** Ed25519
 * verification in the suite returned false. Signature-rejection tests still
 * passed — they were asserting `false` and getting `false` for the wrong
 * reason — while any test relying on a valid signature verifying would have
 * been quietly broken.
 *
 * So these compare the shim against Node's own Ed25519 rather than against
 * itself. If the shim is replaced, or the real library is restored, they still
 * describe the contract that matters.
 */

import * as crypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const shim = require('../../__mocks__/@noble/ed25519.js') as {
    getPublicKey(privateKey: Uint8Array): Uint8Array;
    getPublicKeyAsync(privateKey: Uint8Array): Promise<Uint8Array>;
    sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
    verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
};

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Build a node KeyObject pair from raw 32-byte Ed25519 seed material. */
function nodeKeys(seed: Buffer) {
    const privateKey = crypto.createPrivateKey({
        key: Buffer.concat([PKCS8_PREFIX, seed]),
        format: 'der',
        type: 'pkcs8',
    });
    const publicKey = crypto.createPublicKey(privateKey);
    return { privateKey, publicKey };
}

const SEED = Buffer.alloc(32, 7);
const MESSAGE = Buffer.from('veil invisible wallet');

describe('@noble/ed25519 shim conformance', () => {
    it('derives the same public key Node derives', () => {
        const { publicKey } = nodeKeys(SEED);
        const expected = publicKey.export({ type: 'spki', format: 'der' }).subarray(12);

        expect(Buffer.from(shim.getPublicKey(SEED))).toEqual(Buffer.from(expected));
    });

    it('verifies a signature that Node produced', () => {
        // Cross-checks the shim's verify against a signature it did not make,
        // which is the direction that catches a broken key-decoding path.
        const { privateKey } = nodeKeys(SEED);
        const nodeSig = crypto.sign(null, MESSAGE, privateKey);

        expect(shim.verify(nodeSig, MESSAGE, shim.getPublicKey(SEED))).toBe(true);
    });

    it('produces a signature that Node verifies', () => {
        const { publicKey } = nodeKeys(SEED);
        const shimSig = shim.sign(MESSAGE, SEED);

        expect(crypto.verify(null, MESSAGE, publicKey, Buffer.from(shimSig))).toBe(true);
    });

    it('accepts a valid signature — the case the broken SPKI prefix silently failed', () => {
        // The regression that motivated this file. With the malformed prefix
        // this returned false, and nothing in the suite noticed.
        const publicKey = shim.getPublicKey(SEED);
        const signature = shim.sign(MESSAGE, SEED);

        expect(shim.verify(signature, MESSAGE, publicKey)).toBe(true);
    });

    it('rejects a tampered signature', () => {
        const publicKey = shim.getPublicKey(SEED);
        const signature = Buffer.from(shim.sign(MESSAGE, SEED));
        signature[0] ^= 0x01;

        expect(shim.verify(signature, MESSAGE, publicKey)).toBe(false);
    });

    it('rejects a signature over a different message', () => {
        const publicKey = shim.getPublicKey(SEED);
        const signature = shim.sign(MESSAGE, SEED);

        expect(shim.verify(signature, Buffer.from('different message'), publicKey)).toBe(false);
    });

    it('rejects a signature from a different key', () => {
        const otherSeed = Buffer.alloc(32, 9);
        const signature = shim.sign(MESSAGE, otherSeed);

        expect(shim.verify(signature, MESSAGE, shim.getPublicKey(SEED))).toBe(false);
    });

    it('distinguishes valid from invalid at all — not merely returning false', () => {
        // The assertion the original bug would have failed. Every test above
        // that expects `false` would have passed against a verify() that
        // always returns false; this one cannot.
        const publicKey = shim.getPublicKey(SEED);
        const good = shim.sign(MESSAGE, SEED);
        const bad = Buffer.from(good);
        bad[0] ^= 0x01;

        expect(shim.verify(good, MESSAGE, publicKey)).not.toBe(
            shim.verify(bad, MESSAGE, publicKey),
        );
    });

    it('exposes the async variant the real library provides', async () => {
        await expect(shim.getPublicKeyAsync(SEED)).resolves.toEqual(shim.getPublicKey(SEED));
    });
});

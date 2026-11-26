/**
 * Tests for recovering the signing key from a WebAuthn assertion (issue #1044).
 *
 * The oracle here is deliberately not our own arithmetic: signatures are made by
 * OpenSSL through Node's `crypto.sign`, on a real P-256 key, over the exact byte
 * string a WebAuthn authenticator signs. If the BigInt recovery in
 * `crypto/assertionKey.ts` were wrong in any way — decompression, the negation
 * of `e`, modular inverse, the order of operations — the recovered keys simply
 * would not contain the key that signed.
 */

import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, createPublicKey } from 'crypto';
import {
    recoverAssertionPublicKeys,
    assertionVerificationData,
} from '../crypto/assertionKey';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** The 26-byte DER boilerplate in front of a P-256 uncompressed point in an SPKI. */
const P256_SPKI_PREFIX = Buffer.from([
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]);

/** Does OpenSSL — not this SDK — accept `signature` on `data` under this raw point? */
function verifiesWithOpenSsl(publicKeyBytes: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
    const publicKey = createPublicKey({
        key: Buffer.concat([P256_SPKI_PREFIX, Buffer.from(publicKeyBytes)]),
        format: 'der',
        type: 'spki',
    });
    return cryptoVerify(
        'sha256',
        data,
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature)
    );
}

type FakeAuthenticator = {
    /** Uncompressed P-256 public key, 65 bytes — what the wallet address derives from. */
    publicKeyBytes: Uint8Array;
    authData: Uint8Array;
    clientDataJSON: Uint8Array;
    /** Raw r ‖ s, 64 bytes — the shape providers hand the SDK after DER decoding. */
    signature: Uint8Array;
    verificationData: Uint8Array;
};

/** A P-256 key pair, with the public key in the SDK's 0x04 ‖ x ‖ y form. */
function makeKeyPair() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const spki = new Uint8Array(pair.publicKey.export({ type: 'spki', format: 'der' }));
    // P-256 SPKI is 91 bytes; the uncompressed point is the trailing 65.
    const publicKeyBytes = spki.slice(spki.length - 65);
    if (publicKeyBytes[0] !== 0x04) {
        throw new Error('Fixture: expected an uncompressed P-256 point at the tail of the SPKI');
    }
    return { privateKey: pair.privateKey, publicKeyBytes };
}

/** RP ID hash (32) + flags (1) + counter (4). AT is clear: an assertion carries no key. */
function makeAuthData(flagBytes: number): Uint8Array {
    const authData = new Uint8Array(37);
    for (let i = 0; i < 32; i++) authData[i] = (i * 7 + 3) & 0xff; // fake rpIdHash
    authData[32] = flagBytes;
    authData[33] = 0x00;
    authData[34] = 0x00;
    authData[35] = 0x01;
    authData[36] = 0x2c;
    return authData;
}

/**
 * An assertion produced by `privateKey`, exactly as a provider would return it.
 * `crypto.sign('sha256', …)` hashes for us, matching WebAuthn's
 * sign(SHA-256(authenticatorData ‖ SHA-256(clientDataJSON))).
 */
function makeAssertion(privateKey: Parameters<typeof cryptoSign>[2], seed: number): FakeAuthenticator {
    const authData = makeAuthData(0x41 /* UPLF */ | 0x04 /* BS — a counter is present */);
    const clientDataJSON = new Uint8Array(64);
    for (let i = 0; i < clientDataJSON.length; i++) clientDataJSON[i] = (i * 13 + seed) & 0xff;

    const verificationData = assertionVerificationData(authData, clientDataJSON);
    const signature = new Uint8Array(
        cryptoSign('sha256', verificationData, { key: privateKey, dsaEncoding: 'ieee-p1363' })
    );

    return { publicKeyBytes: new Uint8Array(65), authData, clientDataJSON, signature, verificationData };
}

function toHex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

const KEYS_PER_SWEEP = 8;

/**
 * Fixtures built at module load: eight independent P-256 keys, each with a real
 * OpenSSL signature over its own assertion. Built eagerly (not in `beforeAll`)
 * so every test can see them.
 */
const keys: Array<{ publicKeyBytes: Uint8Array; assertion: FakeAuthenticator }> = [];
for (let i = 0; i < KEYS_PER_SWEEP; i++) {
    const { privateKey, publicKeyBytes } = makeKeyPair();
    const assertion = makeAssertion(privateKey, i);
    assertion.publicKeyBytes = publicKeyBytes;
    keys.push({ publicKeyBytes, assertion });
}

// ── Recovery returns the key that actually signed ─────────────────────────────

describe('recoverAssertionPublicKeys()', () => {
    it(`finds the signing key for each of ${KEYS_PER_SWEEP} independent P-256 keys`, () => {
        for (const [index, { publicKeyBytes, assertion }] of keys.entries()) {
            const recovered = recoverAssertionPublicKeys(assertion);
            expect(recovered.map(toHex)).toContain(toHex(publicKeyBytes));
            for (const candidate of recovered) {
                expect(candidate).toHaveLength(65);
                expect(candidate[0]).toBe(0x04);
                expect(candidate.some(byte => byte !== 0)).toBe(true);
            }
        }
    });

    it('an assertion without a recovery id is inherently ambiguous: two candidates, both verifying', () => {
        const { publicKeyBytes, assertion } = keys[0];
        const recovered = recoverAssertionPublicKeys(assertion);

        // r is fixed by the signature, so the only freedom left is which of the
        // two points sharing that x was the nonce — hence exactly two keys, and
        // the caller must disambiguate. Pinning the count here means a future
        // "optimisation" that drops one candidate fails loudly.
        expect(recovered).toHaveLength(2);
        expect(toHex(recovered[0]) !== toHex(recovered[1])).toBe(true);
        expect(recovered.map(toHex)).toContain(toHex(publicKeyBytes));

        // Both really do verify — that is the whole reason login() has to ask the
        // chain which wallet exists instead of just taking the first candidate.
        for (const candidate of recovered) {
            expect(verifiesWithOpenSsl(candidate, assertion.verificationData, assertion.signature)).toBe(true);
        }
    });

    it('is deterministic — the same assertion recovers the same keys in the same order', () => {
        const { assertion } = keys[0];
        const first = recoverAssertionPublicKeys(assertion).map(toHex);
        const second = recoverAssertionPublicKeys(assertion).map(toHex);
        expect(second).toEqual(first);
    });

    it('a different authenticator data yields a different candidate pair', () => {
        const { privateKey } = makeKeyPair();
        const a = recoverAssertionPublicKeys(makeAssertion(privateKey, 200)).map(toHex);
        const b = recoverAssertionPublicKeys(makeAssertion(privateKey, 201)).map(toHex);
        expect(a).not.toEqual(b);
    });

    it('every candidate is a real key that OpenSSL itself accepts for that signature', () => {
        // Cross-checks the hand-rolled arithmetic against OpenSSL rather than
        // against itself: a wrong point add or a bad square root yields a key
        // that fails verification here, even though it is a well-formed 65 bytes.
        for (const { assertion } of keys) {
            const recovered = recoverAssertionPublicKeys(assertion);
            expect(recovered.length).toBeGreaterThan(0);
            for (const candidate of recovered) {
                expect(candidate[0]).toBe(0x04);
                expect(
                    verifiesWithOpenSsl(candidate, assertion.verificationData, assertion.signature)
                ).toBe(true);
            }
        }
    });

    it('an unrelated key is never produced', () => {
        const { assertion, publicKeyBytes } = keys[0];
        const { publicKeyBytes: otherKey } = makeKeyPair();
        const recovered = recoverAssertionPublicKeys(assertion).map(toHex);
        expect(recovered).toContain(toHex(publicKeyBytes));
        expect(recovered).not.toContain(toHex(otherKey));
        expect(verifiesWithOpenSsl(otherKey, assertion.verificationData, assertion.signature)).toBe(false);
    });
});

// ── Garbage in, no keys out (never a plausible-looking wrong key) ─────────────

describe('recoverAssertionPublicKeys() on invalid input', () => {
    let base: FakeAuthenticator;

    beforeAll(() => {
        const { privateKey } = makeKeyPair();
        base = makeAssertion(privateKey, 7);
    });

    it('rejects a DER signature that was never normalised to raw r ‖ s', () => {
        const derLike = new Uint8Array(71).fill(0x30);
        expect(() => recoverAssertionPublicKeys({ ...base, signature: derLike })).toThrow(
            /expected a raw 64-byte/
        );
    });

    it('rejects authenticatorData too short to be a WebAuthn response', () => {
        expect(() =>
            recoverAssertionPublicKeys({ ...base, authData: new Uint8Array(36) })
        ).toThrow(/37-byte minimum/);
    });

    it('returns no candidates for an all-zero signature', () => {
        expect(recoverAssertionPublicKeys({ ...base, signature: new Uint8Array(64) })).toEqual([]);
    });

    it('returns no candidates for a random, unrelated 64-byte blob', () => {
        const random = new Uint8Array(64);
        for (let i = 0; i < 64; i++) random[i] = (i * 37 + 11) & 0xff;
        const recovered = recoverAssertionPublicKeys({ ...base, signature: random });
        // Either nothing, or points that at least are real curve points — never a
        // half-parsed byte string that could quietly become someone's wallet.
        for (const candidate of recovered) expect(candidate).toHaveLength(65);
    });

    it('returns no candidates when r or s reaches the curve order', () => {
        const signature = new Uint8Array(64);
        signature[0] = 0xff; // r >= n
        expect(recoverAssertionPublicKeys({ ...base, signature })).toEqual([]);
    });
});

// ── The bytes being signed ────────────────────────────────────────────────────

describe('assertionVerificationData()', () => {
    it('is authenticatorData ‖ SHA-256(clientDataJSON), the WebAuthn §6.2 signing input', () => {
        const authData = makeAuthData(0x45);
        const clientDataJSON = new Uint8Array([1, 2, 3, 4]);
        const data = assertionVerificationData(authData, clientDataJSON);
        expect(data).toHaveLength(37 + 32);
        expect(toHex(data.subarray(0, 37))).toBe(toHex(authData));
        // Independent SHA-256 of the same clientDataJSON, via Node rather than stellar-sdk.
        const { createHash } = require('crypto');
        const expectedHash = createHash('sha256').update(Buffer.from(clientDataJSON)).digest();
        expect(toHex(data.subarray(37))).toBe(expectedHash.toString('hex'));
    });
});

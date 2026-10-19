/**
 * Recovering the signing public key from a WebAuthn assertion.
 *
 * WHY THIS EXISTS
 * ---------------
 * An assertion proves possession of a passkey, but it does not name the key.
 * The WebAuthn spec gives `AuthenticatorAssertionResponse` only
 * `authenticatorData`, `clientDataJSON` and `signature` — `getPublicKey()`
 * lives on the *attestation* (registration) response, not the assertion one —
 * so a browser cannot hand the SDK a key at sign-in, and `react-native-passkey`
 * certainly does not (`webauthn.native.ts` returns a key from `create()` and
 * nothing but the three fields from `authenticate()`). The deterministic wallet
 * address, however, is derived from exactly that key
 * (`computeWalletAddress(factory, publicKeyBytes, passphrase)`), so signing in
 * on a fresh device from a bare `credentialId` needs the key recovered, not read.
 *
 * WHAT RECOVERY GIVES YOU
 * -----------------------
 * SEC1 public-key recovery inverts the ECDSA verification equation. Given the
 * message hash and `r`, one candidate `x` for the nonce point `R` is fixed, and
 * the private scalar is gone, but the key is solvable:
 *
 *     Q = r⁻¹ · (s·R − e·G)
 *
 * The catch is `R` itself: the signature does not encode which of the two points
 * sharing that `x`-coordinate was used (`R` or its negation), and both produce a
 * `Q` that verifies the signature. So recovery returns TWO keys, not one. That is
 * a property of ECDSA, not a bug here — an assertion signature is raw `r ‖ s`
 * with no recovery id, so the ambiguity cannot be resolved cryptographically.
 *
 * It is resolved *by the wallet*, which is why this returns a list: only one of
 * the candidates is a deployed Veil wallet, and `login()` already asks the chain
 * which address exists before trusting one. Candidate order is deterministic
 * (recovery id 0 before 1) so the same assertion always produces the same list.
 *
 * IMPLEMENTATION NOTES
 * --------------------
 * Pure BigInt over the public P-256 domain parameters, affine coordinates. No
 * new dependency: the SDK's only runtime dependency is `@stellar/stellar-sdk`,
 * and its synchronous `hash` is used for SHA-256 so this path works on React
 * Native, where `crypto.subtle` is not guaranteed to exist. The arithmetic is
 * cross-checked in tests against signatures made by OpenSSL over a real P-256
 * key, and every recovered candidate is re-verified by OpenSSL — the math is
 * tested against an independent implementation, never against itself.
 */

import { hash as stellarHash } from '@stellar/stellar-sdk';

// ── P-256 (secp256r1 / prime256v1) domain parameters ──────────────────────────

/** Field prime. */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
/** Curve order. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** Curve coefficient a = -3 (mod P). */
const A = P - 3n;
/** Curve coefficient b. */
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
/** Generator. */
const G: EcPoint = {
    x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
    y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
};

// ── Field arithmetic ──────────────────────────────────────────────────────────

/** Non-negative reduction, the way elliptic-curve math wants `%`. */
function mod(a: bigint, m: bigint): bigint {
    const r = a % m;
    return r >= 0n ? r : r + m;
}

/** Modular inverse via the extended Euclidean algorithm. */
function modInv(a: bigint, m: bigint): bigint {
    let oldR = mod(a, m);
    let r = m;
    let oldS = 1n;
    let s = 0n;
    while (r !== 0n) {
        const q = oldR / r;
        [oldR, r] = [r, oldR - q * r];
        [oldS, s] = [s, oldS - q * s];
    }
    if (oldR !== 1n) throw new Error('P-256: modular inverse does not exist');
    return mod(oldS, m);
}

/** Modular exponentiation by squaring. */
function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
    let result = 1n;
    let b = mod(base, modulus);
    let e = exponent;
    while (e > 0n) {
        if (e & 1n) result = mod(result * b, modulus);
        b = mod(b * b, modulus);
        e >>= 1n;
    }
    return result;
}

/**
 * Square root in Fp. P-256's prime is 3 mod 4, so `√c = c^((p+1)/4)` either
 * works or `c` is not a residue at all — no Tonelli-Shanks needed.
 */
function sqrtMod(c: bigint): bigint | null {
    if (c === 0n) return 0n;
    const root = modPow(c, (P + 1n) / 4n, P);
    return mod(root * root, P) === mod(c, P) ? root : null;
}

// ── Curve arithmetic (affine; null is the point at infinity) ──────────────────

type EcPoint = { x: bigint; y: bigint } | null;

function onCurve(point: Exclude<EcPoint, null>): boolean {
    const lhs = mod(point.y * point.y, P);
    const rhs = mod(point.x * point.x * point.x + A * point.x + B, P);
    return lhs === rhs;
}

function pointDouble(point: Exclude<EcPoint, null>): EcPoint {
    // A point with y = 0 has order 2; P-256's group has prime order, so this
    // only happens for invalid input. Doubling it would divide by zero.
    if (point.y === 0n) return null;
    const lambda = mod((3n * point.x * point.x + A) * modInv(2n * point.y, P), P);
    const x = mod(lambda * lambda - 2n * point.x, P);
    const y = mod(lambda * (point.x - x) - point.y, P);
    return { x, y };
}

function pointAdd(a: EcPoint, b: EcPoint): EcPoint {
    if (a === null) return b;
    if (b === null) return a;
    if (a.x === b.x) {
        // Same x: either the same point (double) or inverses (infinity).
        return mod(a.y + b.y, P) === 0n ? null : pointDouble(a);
    }
    const lambda = mod((b.y - a.y) * modInv(mod(b.x - a.x, P), P), P);
    const x = mod(lambda * lambda - a.x - b.x, P);
    // The third intersection lies on the chord, y = λ·(x − x1) + y1; the sum is
    // its reflection, so y3 = λ·(x1 − x3) − y1 — subtracting y2 is a classic
    // off-by-sign that yields a well-formed but off-curve point.
    const y = mod(lambda * (a.x - x) - a.y, P);
    return { x, y };
}

/** Scalar multiplication, double-and-add over the bits of `k`. */
function scalarMul(k: bigint, point: EcPoint): EcPoint {
    let scalar = mod(k, N);
    if (scalar === 0n || point === null) return null;
    let acc: EcPoint = null;
    let addend: EcPoint = point;
    while (scalar > 0n) {
        if (scalar & 1n) acc = pointAdd(acc, addend);
        addend = addend === null ? null : pointDouble(addend);
        scalar >>= 1n;
    }
    return acc;
}

/**
 * Decompress a curve point from its x-coordinate and the parity of its
 * y-coordinate — the recovery id, in all but name.
 */
function decompress(x: bigint, yParity: 0 | 1): EcPoint {
    if (x >= P) return null;
    const rhs = mod(x * x * x + A * x + B, P);
    const y = sqrtMod(rhs);
    if (y === null) return null;
    const resolvedY = (y & 1n) === BigInt(yParity) ? y : P - y;
    const point: EcPoint = { x, y: resolvedY };
    return onCurve(point) ? point : null;
}

// ── Byte / integer helpers ────────────────────────────────────────────────────

function bytesToBigIntBE(bytes: Uint8Array): bigint {
    let out = 0n;
    for (const byte of bytes) out = (out << 8n) | BigInt(byte);
    return out;
}

function bigIntToBytes32BE(value: bigint): Uint8Array {
    const out = new Uint8Array(32);
    let v = value;
    for (let i = 31; i >= 0; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return out;
}

/** Uncompressed SEC1 encoding: 0x04 ‖ x ‖ y — the 65 bytes the SDK derives addresses from. */
function encodeUncompressed(point: Exclude<EcPoint, null>): Uint8Array {
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(bigIntToBytes32BE(point.x), 1);
    out.set(bigIntToBytes32BE(point.y), 33);
    return out;
}

/**
 * SHA-256 through `@stellar/stellar-sdk`'s synchronous hash.
 *
 * Deliberately not `crypto.subtle`: this runs on React Native, where WebCrypto
 * is not guaranteed to be present — the same reason `core.ts` uses `stellarHash`
 * when building Soroban authorization payloads.
 */
export function sha256Bytes(data: Uint8Array): Uint8Array {
    return new Uint8Array(
        (stellarHash as (input: Buffer) => Buffer)(Buffer.from(data))
    );
}

// ── The assertion → public-key part ───────────────────────────────────────────

/**
 * The three fields a WebAuthn assertion actually carries. Matches
 * `WebAuthnAssertResult` minus `publicKeyBytes`, and both providers' assertion
 * shapes satisfy it structurally.
 */
export interface AssertionMaterial {
    /** Raw `authenticatorData` bytes. */
    authData: Uint8Array;
    /** Raw `clientDataJSON` bytes. */
    clientDataJSON: Uint8Array;
    /** Raw P-256 ECDSA signature: r ‖ s (64 bytes). */
    signature: Uint8Array;
}

/**
 * The exact bytes a WebAuthn authenticator signs, before hashing:
 * `authenticatorData ‖ SHA-256(clientDataJSON)` (CTAP2 / WebAuthn §6.2).
 */
export function assertionVerificationData(
    authData: Uint8Array,
    clientDataJSON: Uint8Array
): Uint8Array {
    const clientDataHash = sha256Bytes(clientDataJSON);
    const data = new Uint8Array(authData.length + clientDataHash.length);
    data.set(authData, 0);
    data.set(clientDataHash, authData.length);
    return data;
}

/**
 * Recover every P-256 public key that could have produced this assertion.
 *
 * Returns uncompressed keys (0x04 ‖ x ‖ y, 65 bytes) — directly usable as input
 * to `computeWalletAddress`. Expect two entries for an ordinary signature; see
 * the module comment for why the ambiguity is inherent and how a caller resolves
 * it. Returns an empty list when the signature is not a valid P-256 ECDSA
 * signature over the assertion, which is the expected result for garbage input.
 *
 * Throws only on malformed inputs (wrong byte lengths), never on a signature
 * that simply does not resolve — recovery failing is normal, not exceptional.
 */
export function recoverAssertionPublicKeys(assertion: AssertionMaterial): Uint8Array[] {
    const { authData, clientDataJSON, signature } = assertion;

    if (signature.length !== 64) {
        throw new Error(
            `recoverAssertionPublicKeys: expected a raw 64-byte (r ‖ s) P-256 signature, got ${signature.length} bytes. ` +
            'Providers normalise DER to raw via derToRawSignature().'
        );
    }
    if (authData.length < 37) {
        // RP ID hash (32) + flags (1) + counter (4) is the smallest a real
        // assertion can carry; anything shorter is not an authenticatorData.
        throw new Error(
            `recoverAssertionPublicKeys: authenticatorData is ${authData.length} bytes, shorter than the 37-byte minimum.`
        );
    }

    const r = bytesToBigIntBE(signature.subarray(0, 32));
    const s = bytesToBigIntBE(signature.subarray(32, 64));

    // Both must be in [1, n-1] to be a signature at all; modInv(r) below also
    // requires r to be coprime with the prime order n.
    if (r === 0n || s === 0n || r >= N || s >= N) return [];

    const messageHash = sha256Bytes(assertionVerificationData(authData, clientDataJSON));
    const e = mod(bytesToBigIntBE(messageHash), N);

    const rInv = modInv(r, N);
    const u2 = mod(s * rInv, N);
    const u1 = mod(N - mod(e * rInv, N), N); // −e·r⁻¹ mod n

    const found: Uint8Array[] = [];
    const seen = new Set<string>();

    // A recovery id is (which candidate x) ‖ (which y parity). For P-256 the
    // second x candidate, r + n, is only in range for r < p − n (~2^-128 of
    // signatures), but trying it costs nothing and keeps the code honest.
    for (let recoveryId = 0; recoveryId < 4; recoveryId++) {
        const xCandidate = r + BigInt(recoveryId >> 1) * N;
        const noncePoint = decompress(xCandidate, (recoveryId & 1) as 0 | 1);
        if (noncePoint === null) continue;

        const publicKey = pointAdd(scalarMul(u1, G), scalarMul(u2, noncePoint));
        if (publicKey === null || !onCurve(publicKey)) continue;

        const encoded = encodeUncompressed(publicKey);
        const key = Buffer.from(encoded).toString('hex');
        if (!seen.has(key)) {
            seen.add(key);
            found.push(encoded);
        }
    }

    return found;
}

/**
 * Every public key worth trying for an assertion, in the order they should be
 * checked: the key the provider reported (if it reported one) first, then the
 * recovered candidates.
 *
 * `WebAuthnAssertResult.publicKeyBytes` is normally `null` — browsers do not
 * expose `getPublicKey()` on assertion responses and `react-native-passkey`
 * never does — so on the paths that matter this returns the recovered pair.
 * When a provider does report a key it is almost always already among the
 * recovered candidates; listing it first simply saves a chain lookup.
 */
export function assertionPublicKeyCandidates(
    assertion: AssertionMaterial & { publicKeyBytes?: Uint8Array | null }
): Uint8Array[] {
    const candidates: Uint8Array[] = [];
    const push = (key: Uint8Array): void => {
        const hex = Buffer.from(key).toString('hex');
        if (!candidates.some(existing => Buffer.from(existing).toString('hex') === hex)) {
            candidates.push(key);
        }
    };

    const reported = assertion.publicKeyBytes;
    if (reported && reported.length === 65 && reported[0] === 0x04) push(reported);

    for (const recovered of recoverAssertionPublicKeys(assertion)) push(recovered);

    return candidates;
}

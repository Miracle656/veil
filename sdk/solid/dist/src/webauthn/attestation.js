/**
 * WebAuthn attestation verification at registration.
 *
 * Verifying the attestation statement returned by `navigator.credentials.create()`
 * lets a relying party enforce authenticator provenance and policy — for example,
 * requiring a hardware authenticator or rejecting a known-weak AAGUID.
 *
 * This module supports the two most common attestation formats:
 *
 *   - **`none`**   — no statement; nothing to verify cryptographically, but the
 *                    AAGUID and credential public key are still parsed so a policy
 *                    can inspect them.
 *   - **`packed`** — the FIDO2 default. Two sub-cases:
 *       - *self attestation* (no `x5c`): the statement is signed by the
 *         credential's own private key. Fully verified here against the public
 *         key embedded in `authData`.
 *       - *basic/full attestation* (`x5c` present): signed by an attestation
 *         certificate. The signature is verified against the leaf certificate's
 *         public key.
 *
 * ── Trade-offs (deliberately out of scope) ───────────────────────────────────
 * For `x5c` (basic) attestation this module verifies the statement signature
 * against the **leaf certificate**, but does NOT walk the certificate chain to a
 * trusted FIDO Metadata Service (MDS) root. Full chain-to-root validation
 * requires shipping and maintaining a root store, which is an application-level
 * policy decision. Callers who need it should perform chain validation inside
 * their {@link AttestationPolicy} using the parsed certificates. Treating a
 * self-signed `packed` statement as proof of provenance is also weaker than a
 * full chain — the policy hook is where you encode how much you trust each case.
 */
// ── Errors ──────────────────────────────────────────────────────────────────
/** Thrown when the attestation object cannot be parsed or its signature is invalid. */
export class AttestationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AttestationError';
    }
}
/** Thrown when a caller-supplied {@link AttestationPolicy} rejects the credential. */
export class AttestationPolicyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AttestationPolicyError';
    }
}
// ── Minimal CBOR decoder (attestation subset) ──────────────────────────────────
//
// Supports the CBOR major types that appear in a WebAuthn attestationObject and
// COSE key: unsigned/negative ints, byte/text strings, arrays, maps, and the
// false/true/null simple values. Indefinite-length items and floats are not used
// by WebAuthn and are intentionally unsupported.
function toUint8(input) {
    return input instanceof Uint8Array ? input : new Uint8Array(input);
}
function decodeCbor(bytes, start = 0) {
    let offset = start;
    function readLength(info) {
        if (info < 24)
            return info;
        if (info === 24)
            return bytes[offset++];
        if (info === 25) {
            const v = (bytes[offset] << 8) | bytes[offset + 1];
            offset += 2;
            return v;
        }
        if (info === 26) {
            const v = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
            offset += 4;
            return v;
        }
        if (info === 27) {
            // 8-byte length; WebAuthn values fit comfortably in a JS number.
            let v = 0;
            for (let i = 0; i < 8; i++)
                v = v * 256 + bytes[offset + i];
            offset += 8;
            return v;
        }
        throw new AttestationError('CBOR: unsupported length encoding');
    }
    function decodeItem() {
        const initial = bytes[offset++];
        const major = initial >> 5;
        const info = initial & 0x1f;
        switch (major) {
            case 0: return readLength(info); // unsigned int
            case 1: return -1 - readLength(info); // negative int
            case 2: { // byte string
                const len = readLength(info);
                const v = bytes.slice(offset, offset + len);
                offset += len;
                return v;
            }
            case 3: { // text string
                const len = readLength(info);
                const v = new TextDecoder().decode(bytes.slice(offset, offset + len));
                offset += len;
                return v;
            }
            case 4: { // array
                const len = readLength(info);
                const arr = [];
                for (let i = 0; i < len; i++)
                    arr.push(decodeItem());
                return arr;
            }
            case 5: { // map
                const len = readLength(info);
                const m = new Map();
                for (let i = 0; i < len; i++) {
                    const k = decodeItem();
                    m.set(k, decodeItem());
                }
                return m;
            }
            case 7:
                if (info === 20)
                    return false;
                if (info === 21)
                    return true;
                if (info === 22)
                    return null;
                if (info === 23)
                    return undefined;
                throw new AttestationError('CBOR: unsupported simple value');
            default:
                throw new AttestationError(`CBOR: unsupported major type ${major}`);
        }
    }
    const value = decodeItem();
    return { value, bytesRead: offset - start };
}
const AT_FLAG = 0x40; // attested credential data present
/** Reconstruct the uncompressed P-256 point from a COSE EC2 key map. */
function coseToUncompressedP256(cose) {
    if (cose.get(1) !== 2)
        return undefined; // kty must be EC2 (2)
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
        return undefined;
    }
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(x, 1);
    out.set(y, 33);
    return out;
}
function parseAuthData(authData) {
    if (authData.length < 37)
        throw new AttestationError('authData too short (< 37 bytes)');
    const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
    const rpIdHash = authData.slice(0, 32);
    const flags = view.getUint8(32);
    const signCount = view.getUint32(33, false);
    let aaguid = new Uint8Array(16);
    let credentialId = new Uint8Array(0);
    let publicKey;
    if (flags & AT_FLAG) {
        if (authData.length < 55)
            throw new AttestationError('authData missing attested credential data');
        aaguid = authData.slice(37, 53);
        const credIdLen = view.getUint16(53, false);
        const credIdStart = 55;
        const credIdEnd = credIdStart + credIdLen;
        if (authData.length < credIdEnd)
            throw new AttestationError('authData credentialId length out of range');
        credentialId = authData.slice(credIdStart, credIdEnd);
        // The COSE public key is CBOR immediately following the credential ID.
        const { value } = decodeCbor(authData, credIdEnd);
        if (value instanceof Map)
            publicKey = coseToUncompressedP256(value);
    }
    return { rpIdHash, flags, signCount, aaguid, credentialId, publicKey };
}
// ── DER helpers (ECDSA signature + X.509 SPKI extraction) ───────────────────────
/** Convert a DER-encoded ECDSA signature to raw r‖s (64 bytes), no low-S normalisation. */
function derEcdsaToRaw(der) {
    if (der[0] !== 0x30)
        throw new AttestationError('DER: expected SEQUENCE');
    let offset = 2;
    // Handle a long-form length byte on the outer SEQUENCE.
    if (der[1] & 0x80)
        offset = 2 + (der[1] & 0x7f);
    if (der[offset] !== 0x02)
        throw new AttestationError('DER: expected INTEGER (r)');
    const rLen = der[offset + 1];
    const r = der.slice(offset + 2, offset + 2 + rLen);
    offset = offset + 2 + rLen;
    if (der[offset] !== 0x02)
        throw new AttestationError('DER: expected INTEGER (s)');
    const sLen = der[offset + 1];
    const s = der.slice(offset + 2, offset + 2 + sLen);
    const pad32 = (b) => {
        let i = 0;
        while (i < b.length - 32 && b[i] === 0)
            i++; // strip leading sign byte(s)
        const trimmed = b.slice(i);
        const out = new Uint8Array(32);
        out.set(trimmed, 32 - trimmed.length);
        return out;
    };
    const raw = new Uint8Array(64);
    raw.set(pad32(r), 0);
    raw.set(pad32(s), 32);
    return raw;
}
/** Read one DER TLV at `off`, returning its content/end byte offsets. */
function readTLV(buf, off) {
    const tag = buf[off];
    let lenByte = buf[off + 1];
    let contentStart = off + 2;
    let length;
    if (lenByte & 0x80) {
        const numBytes = lenByte & 0x7f;
        length = 0;
        for (let i = 0; i < numBytes; i++)
            length = (length << 8) | buf[off + 2 + i];
        contentStart = off + 2 + numBytes;
    }
    else {
        length = lenByte;
    }
    const contentEnd = contentStart + length;
    return { tag, contentStart, contentEnd, end: contentEnd };
}
/**
 * Extract the SubjectPublicKeyInfo (SPKI) DER from an X.509 certificate so it can
 * be imported via `crypto.subtle.importKey('spki', ...)`.
 *
 * Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
 * tbsCertificate ::= SEQUENCE { [0] version?, serialNumber, signature, issuer,
 *                               validity, subject, subjectPublicKeyInfo, ... }
 */
function extractSpkiFromCert(cert) {
    const certSeq = readTLV(cert, 0);
    if (certSeq.tag !== 0x30)
        throw new AttestationError('x5c: certificate is not a SEQUENCE');
    const tbs = readTLV(cert, certSeq.contentStart);
    if (tbs.tag !== 0x30)
        throw new AttestationError('x5c: tbsCertificate is not a SEQUENCE');
    let cursor = tbs.contentStart;
    // Optional explicit [0] version tag.
    let first = readTLV(cert, cursor);
    if (first.tag === 0xa0)
        cursor = first.end; // skip version
    // Skip serialNumber, signature, issuer, validity, subject (5 elements).
    for (let i = 0; i < 5; i++)
        cursor = readTLV(cert, cursor).end;
    const spki = readTLV(cert, cursor);
    if (spki.tag !== 0x30)
        throw new AttestationError('x5c: could not locate SubjectPublicKeyInfo');
    return cert.slice(cursor, spki.end);
}
// ── Signature verification ─────────────────────────────────────────────────────
async function sha256(data) {
    const buf = await crypto.subtle.digest('SHA-256', data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return new Uint8Array(buf);
}
/** Verify a packed-format ECDSA P-256 signature over (authData ‖ clientDataHash). */
async function verifyPackedSignature(spkiOrRawKey, keyFormat, authData, clientDataHash, sigDer) {
    const signedData = new Uint8Array(authData.length + clientDataHash.length);
    signedData.set(authData, 0);
    signedData.set(clientDataHash, authData.length);
    const key = await crypto.subtle.importKey(keyFormat, spkiOrRawKey.buffer.slice(spkiOrRawKey.byteOffset, spkiOrRawKey.byteOffset + spkiOrRawKey.byteLength), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const rawSig = derEcdsaToRaw(sigDer);
    return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, rawSig.buffer.slice(rawSig.byteOffset, rawSig.byteOffset + rawSig.byteLength), signedData.buffer.slice(signedData.byteOffset, signedData.byteOffset + signedData.byteLength));
}
// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Parse and (where possible) verify a WebAuthn attestation statement, then apply
 * an optional policy.
 *
 * @throws {AttestationError}        if the object can't be parsed, or a packed
 *                                   signature is invalid and `requireValidSignature`.
 * @throws {AttestationPolicyError}  if the policy returns `false` or throws.
 */
export async function verifyAttestation(opts) {
    const requireValidSignature = opts.requireValidSignature ?? true;
    const attBytes = toUint8(opts.attestationObject);
    const clientDataBytes = toUint8(opts.clientDataJSON);
    const { value: decoded } = decodeCbor(attBytes);
    if (!(decoded instanceof Map))
        throw new AttestationError('attestationObject is not a CBOR map');
    const fmt = decoded.get('fmt');
    const attStmt = decoded.get('attStmt');
    const authDataRaw = decoded.get('authData');
    if (typeof fmt !== 'string')
        throw new AttestationError('attestationObject missing fmt');
    if (!(authDataRaw instanceof Uint8Array))
        throw new AttestationError('attestationObject missing authData');
    const parsed = parseAuthData(authDataRaw);
    const info = {
        fmt,
        aaguid: Array.from(parsed.aaguid).map(b => b.toString(16).padStart(2, '0')).join(''),
        aaguidBytes: parsed.aaguid,
        credentialId: parsed.credentialId,
        publicKey: parsed.publicKey,
        signCount: parsed.signCount,
        verified: false,
        attestationType: 'unsupported',
    };
    if (fmt === 'none') {
        info.attestationType = 'none';
        info.verified = false; // nothing to verify; provenance is unattested
    }
    else if (fmt === 'packed' && attStmt instanceof Map) {
        const sig = attStmt.get('sig');
        const x5c = attStmt.get('x5c');
        if (!(sig instanceof Uint8Array))
            throw new AttestationError('packed attStmt missing sig');
        const clientDataHash = await sha256(clientDataBytes);
        if (Array.isArray(x5c) && x5c.length > 0 && x5c[0] instanceof Uint8Array) {
            // Basic / full attestation — verify against the leaf certificate.
            info.attestationType = 'basic';
            info.leafCert = x5c[0];
            const spki = extractSpkiFromCert(x5c[0]);
            info.verified = await verifyPackedSignature(spki, 'spki', authDataRaw, clientDataHash, sig);
        }
        else if (parsed.publicKey) {
            // Self attestation — verify against the credential's own public key.
            info.attestationType = 'self';
            info.verified = await verifyPackedSignature(parsed.publicKey, 'raw', authDataRaw, clientDataHash, sig);
        }
        else {
            throw new AttestationError('packed attestation has neither x5c nor a usable credential key');
        }
        if (!info.verified && requireValidSignature) {
            throw new AttestationError(`packed attestation signature failed to verify (${info.attestationType})`);
        }
    }
    else {
        // Unsupported format (e.g. "tpm", "android-key", "apple"). Parse-only.
        info.attestationType = 'unsupported';
        info.verified = false;
    }
    if (opts.policy) {
        const verdict = await opts.policy(info);
        if (verdict === false) {
            throw new AttestationPolicyError(`Attestation rejected by policy (fmt=${info.fmt}, aaguid=${info.aaguid || 'none'}, verified=${info.verified})`);
        }
    }
    return info;
}

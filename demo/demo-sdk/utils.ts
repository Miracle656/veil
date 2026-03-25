import { StrKey, xdr, hash as stellarHash } from 'stellar-sdk';

// ── Buffer helpers ────────────────────────────────────────────────────────────

export function bufferToHex(input: Uint8Array | ArrayBuffer): string {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

export function hexToUint8Array(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
    const array = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        array[i / 2] = parseInt(hex.substring(i, i + 2), 16);
    }
    return array;
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

/** Compute SHA-256 using the Web Crypto API. */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
    // .slice() on ArrayBufferLike returns a plain ArrayBuffer, satisfying SubtleCrypto's types
    const buf = await crypto.subtle.digest(
        'SHA-256',
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    );
    return new Uint8Array(buf);
}

/**
 * Convert an ASN.1 DER-encoded P-256 ECDSA signature to raw 64-byte (r ‖ s) format.
 *
 * WebAuthn returns DER; the contract expects raw r ‖ s (32 bytes each).
 *
 * DER structure:  30 <totalLen>  02 <rLen> <r>  02 <sLen> <s>
 */
export function derToRawSignature(derSig: ArrayBuffer): Uint8Array {
    const der = new Uint8Array(derSig);

    if (der[0] !== 0x30) throw new Error('DER: expected SEQUENCE (0x30)');
    // der[1] is total length — skip it
    let offset = 2;

    if (der[offset] !== 0x02) throw new Error('DER: expected INTEGER tag for r');
    offset++;
    const rLen = der[offset++];
    const rRaw = der.slice(offset, offset + rLen);
    offset += rLen;

    if (der[offset] !== 0x02) throw new Error('DER: expected INTEGER tag for s');
    offset++;
    const sLen = der[offset++];
    const sRaw = der.slice(offset, offset + sLen);

    const raw = new Uint8Array(64);
    raw.set(padOrTrim32(rRaw), 0);
    raw.set(padOrTrim32(sRaw), 32);
    return raw;
}

/**
 * Normalise a DER integer component to exactly 32 bytes.
 * DER uses a leading 0x00 to denote positive sign when the high bit is set;
 * we strip that and left-pad with zeros if the value is shorter than 32 bytes.
 */
function padOrTrim32(bytes: Uint8Array): Uint8Array {
    // Strip leading 0x00 sign byte(s)
    let start = 0;
    while (start < bytes.length - 32 && bytes[start] === 0) start++;
    const trimmed = bytes.slice(start);
    if (trimmed.length > 32) throw new Error('Integer component too large for P-256');
    const padded = new Uint8Array(32);
    padded.set(trimmed, 32 - trimmed.length);
    return padded;
}

/**
 * Extract the uncompressed P-256 public key (65 bytes: 0x04 ‖ x ‖ y) from a
 * WebAuthn attestation response.
 *
 * Uses `AuthenticatorAttestationResponse.getPublicKey()` (Chrome 95+, Firefox 93+)
 * combined with SubtleCrypto to avoid manual CBOR/SPKI parsing.
 */
export async function extractP256PublicKey(
    response: AuthenticatorAttestationResponse
): Promise<Uint8Array> {
    const spkiBuffer = response.getPublicKey();
    if (!spkiBuffer) {
        throw new Error(
            'getPublicKey() returned null — authenticator may not support SPKI export, ' +
            'or the browser is too old (requires Chrome 95+ / Firefox 93+)'
        );
    }

    // Import as ECDSA P-256 so SubtleCrypto validates the format
    const cryptoKey = await crypto.subtle.importKey(
        'spki',
        spkiBuffer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,       // extractable
        ['verify']
    );

    // Export as 'raw' = uncompressed point: 0x04 ‖ x (32 B) ‖ y (32 B) = 65 bytes
    const rawBuffer = await crypto.subtle.exportKey('raw', cryptoKey);
    return new Uint8Array(rawBuffer);
}

/**
 * Compute the message hash that a WebAuthn ES256 authenticator actually signs:
 *   SHA256(authenticatorData ‖ SHA256(clientDataJSON))
 *
 * This is what the contract's verify_webauthn() verifies against.
 */
export async function computeWebAuthnMessageHash(
    authData: ArrayBuffer,
    clientDataJSON: ArrayBuffer
): Promise<Uint8Array> {
    const clientDataHash = await sha256(new Uint8Array(clientDataJSON));

    const authBytes = new Uint8Array(authData);
    const message = new Uint8Array(authBytes.length + 32);
    message.set(authBytes, 0);
    message.set(clientDataHash, authBytes.length);

    return sha256(message);
}

// ── WebAuthn data parsers ─────────────────────────────────────────────────────

/**
 * Parse WebAuthn authenticatorData binary structure.
 *
 * Layout: rpIdHash (32 B) | flags (1 B) | signCount (4 B) | [attestedCredData] | [extensions]
 */
export function parseAuthData(authData: ArrayBuffer): {
    rpIdHash: Uint8Array;
    flags: { up: boolean; uv: boolean; at: boolean; ed: boolean };
    signCount: number;
} {
    const view = new DataView(authData);
    const bytes = new Uint8Array(authData);
    if (bytes.length < 37) throw new Error('authData too short (expected ≥ 37 bytes)');

    const flagByte = view.getUint8(32);
    return {
        rpIdHash:  bytes.slice(0, 32),
        flags: {
            up: !!(flagByte & 0x01), // User Present
            uv: !!(flagByte & 0x04), // User Verified
            at: !!(flagByte & 0x40), // Attested credential data present
            ed: !!(flagByte & 0x80), // Extension data present
        },
        signCount: view.getUint32(33, false), // big-endian
    };
}

/** Parse the clientDataJSON buffer into a typed object. */
export function parseClientDataJSON(clientDataJSON: ArrayBuffer): {
    type: string;
    challenge: string;
    origin: string;
    crossOrigin?: boolean;
} {
    return JSON.parse(new TextDecoder().decode(clientDataJSON));
}

// ── Encoding helpers ──────────────────────────────────────────────────────────

/**
 * Base64url-encode bytes without padding.
 * Used to match how browsers encode the WebAuthn challenge inside clientDataJSON.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
    // btoa works on binary strings; chunk to avoid call-stack overflow on large inputs
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

/** Encode a BigInt as an 8-byte big-endian buffer (for XDR u64 fields). */
export function encodeU64(num: bigint): Uint8Array {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, num, false);
    return new Uint8Array(buf);
}

// ── Wallet address derivation ─────────────────────────────────────────────────

/**
 * Compute the deterministic Soroban contract address for a user's passkey wallet
 * **without** deploying it.
 *
 * This mirrors the on-chain derivation exactly:
 *
 *   1. salt         = SHA-256(publicKeyBytes)          — factory hashes the 65-byte key to get 32 bytes
 *   2. networkId    = SHA-256(networkPassphrase)
 *   3. preimage     = XDR(ContractID { networkId, factory, salt })
 *   4. contractId   = SHA-256(preimage)
 *   5. address      = StrKey.encodeContract(contractId) → "C..."
 *
 * @param factoryId        The factory contract's Stellar strkey (e.g. "CABC...").
 * @param publicKeyBytes   The user's uncompressed P-256 public key (65 bytes: 0x04 ‖ x ‖ y).
 * @param networkPassphrase Stellar network passphrase. Defaults to testnet.
 * @returns The wallet's Stellar contract address in strkey format ("C...").
 */
export function computeWalletAddress(
    factoryId: string,
    publicKeyBytes: Uint8Array,
    networkPassphrase = 'Test SDF Network ; September 2015'
): string {
    // Step 1: Hash the 65-byte public key → 32-byte salt.
    //   The factory contract calls env.crypto().sha256(&public_key_bytes) for the same reason:
    //   Soroban's deployer salt must be exactly 32 bytes (Uint256).
    const salt = stellarHash(Buffer.from(publicKeyBytes));

    // Step 2: Hash the network passphrase → 32-byte networkId.
    //   Every Stellar network has a unique passphrase, so contract IDs don't collide
    //   between testnet and mainnet even with identical inputs.
    const networkId = stellarHash(Buffer.from(networkPassphrase));

    // Step 3: Decode the factory's strkey → raw 32-byte contract hash.
    const factoryHash = StrKey.decodeContract(factoryId);

    // Step 4: Build the XDR preimage that Soroban hashes to derive contract addresses.
    //   This is the canonical HashIdPreimage::ContractId structure from the Stellar XDR spec.
    //   It encodes: "this contract was deployed by <factory> with <salt> on <network>".
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
        new xdr.HashIdPreimageContractId({
            networkId,
            contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                new xdr.ContractIdPreimageFromAddress({
                    address: xdr.ScAddress.scAddressTypeContract(factoryHash),
                    salt,
                })
            ),
        })
    );

    // Step 5: SHA-256 the serialised XDR → 32-byte contract ID.
    const contractId = stellarHash(preimage.toXDR());

    // Step 6: Encode as a Stellar contract strkey ("C...").
    return StrKey.encodeContract(contractId);
}

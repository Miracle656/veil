export declare function bufferToHex(input: Uint8Array | ArrayBuffer): string;
export declare function hexToUint8Array(hex: string): Uint8Array;
/** Compute SHA-256 using the Web Crypto API. */
export declare function sha256(data: Uint8Array): Promise<Uint8Array>;
/**
 * Convert an ASN.1 DER-encoded P-256 ECDSA signature to raw 64-byte (r ‖ s) format,
 * normalising s to low form so Soroban's secp256r1_verify host function accepts it.
 *
 * WebAuthn returns DER; the contract expects raw r ‖ s (32 bytes each).
 *
 * DER structure:  30 <totalLen>  02 <rLen> <r>  02 <sLen> <s>
 */
export declare function derToRawSignature(derSig: ArrayBuffer): Uint8Array;
/**
 * Extract the uncompressed P-256 public key (65 bytes: 0x04 ‖ x ‖ y) from a
 * WebAuthn attestation response.
 *
 * Uses `AuthenticatorAttestationResponse.getPublicKey()` (Chrome 95+, Firefox 93+)
 * combined with SubtleCrypto to avoid manual CBOR/SPKI parsing.
 */
export declare function extractP256PublicKey(response: AuthenticatorAttestationResponse): Promise<Uint8Array>;
/**
 * Compute the message hash that a WebAuthn ES256 authenticator actually signs:
 *   SHA256(authenticatorData ‖ SHA256(clientDataJSON))
 *
 * This is what the contract's verify_webauthn() verifies against.
 */
export declare function computeWebAuthnMessageHash(authData: ArrayBuffer, clientDataJSON: ArrayBuffer): Promise<Uint8Array>;
/**
 * Parse WebAuthn authenticatorData binary structure.
 *
 * Layout: rpIdHash (32 B) | flags (1 B) | signCount (4 B) | [attestedCredData] | [extensions]
 */
export declare function parseAuthData(authData: ArrayBuffer): {
    rpIdHash: Uint8Array;
    flags: {
        up: boolean;
        uv: boolean;
        at: boolean;
        ed: boolean;
    };
    signCount: number;
};
/** Parse the clientDataJSON buffer into a typed object. */
export declare function parseClientDataJSON(clientDataJSON: ArrayBuffer): {
    type: string;
    challenge: string;
    origin: string;
    crossOrigin?: boolean;
};
/**
 * Base64url-encode bytes without padding.
 * Used to match how browsers encode the WebAuthn challenge inside clientDataJSON.
 */
export declare function base64UrlEncode(bytes: Uint8Array): string;
/** Encode a BigInt as an 8-byte big-endian buffer (for XDR u64 fields). */
export declare function encodeU64(num: bigint): Uint8Array;
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
export declare function computeWalletAddress(factoryId: string, publicKeyBytes: Uint8Array, networkPassphrase?: string): string;

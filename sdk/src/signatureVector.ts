import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

/** The pieces of one WebAuthn assertion the wallet contract verifies. */
export type WebAuthnSignatureParts = {
    /** Uncompressed P-256 public key of the signing passkey (0x04 ‖ x ‖ y). */
    publicKey: Uint8Array;
    authData: Uint8Array;
    clientDataJSON: Uint8Array;
    /** Raw r ‖ s signature, low-S normalised. */
    signature: Uint8Array;
};

/** Element count the wallet contract's `__check_auth` WebAuthn branch requires. */
export const WEBAUTHN_SIGNATURE_VECTOR_LENGTH = 5;

/**
 * Encode a passkey assertion as the credential `__check_auth` accepts:
 *
 *   [0] BytesN<65> public key
 *   [1] Bytes      authenticatorData
 *   [2] Bytes      clientDataJSON
 *   [3] BytesN<64> r ‖ s signature
 *   [4] u64        the wallet's current nonce
 *
 * The contract rejects any other length with `InvalidSignatureFormat` (#2), so
 * the nonce is not optional. The SDK used to send the first four only, which is
 * why no passkey-authorised SDK call — `addSigner` included — could succeed.
 */
export function buildWebAuthnSignatureVector(
    signature: WebAuthnSignatureParts,
    nonce: bigint,
): xdr.ScVal {
    if (signature.publicKey.length !== 65 || signature.publicKey[0] !== 0x04) {
        throw new Error('WebAuthn public key must be a 65-byte uncompressed P-256 point.');
    }
    if (signature.signature.length !== 64) {
        throw new Error('WebAuthn signature must be exactly 64 bytes (r ‖ s).');
    }
    if (nonce < 0n) {
        throw new Error('Wallet nonce cannot be negative.');
    }

    return xdr.ScVal.scvVec([
        nativeToScVal(signature.publicKey,      { type: 'bytes' }),
        nativeToScVal(signature.authData,       { type: 'bytes' }),
        nativeToScVal(signature.clientDataJSON, { type: 'bytes' }),
        nativeToScVal(signature.signature,      { type: 'bytes' }),
        nativeToScVal(nonce,                    { type: 'u64' }),
    ]);
}

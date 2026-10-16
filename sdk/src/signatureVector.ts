import { nativeToScVal, xdr } from '@stellar/stellar-sdk';

import type { WebAuthnSignature } from './core';

/** Encode the exact five-value WebAuthn authorization tuple expected on chain. */
export function buildWebAuthnSignatureVector(
    signature: WebAuthnSignature,
    nonce: bigint,
): xdr.ScVal {
    if (signature.publicKey.length !== 65) {
        throw new Error('WebAuthn public key must be exactly 65 bytes.');
    }
    if (signature.signature.length !== 64) {
        throw new Error('WebAuthn signature must be exactly 64 bytes.');
    }

    return xdr.ScVal.scvVec([
        nativeToScVal(signature.publicKey,      { type: 'bytes' }),
        nativeToScVal(signature.authData,       { type: 'bytes' }),
        nativeToScVal(signature.clientDataJSON, { type: 'bytes' }),
        nativeToScVal(signature.signature,      { type: 'bytes' }),
        nativeToScVal(nonce,                    { type: 'u64' }),
    ]);
}

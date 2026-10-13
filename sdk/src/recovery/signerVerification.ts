import { derToRawSignature, bufferToHex, hexToUint8Array } from '../utils';

export type RegisteredSigner = Uint8Array | string;

export const RECOVERY_SIGNER_CASES = [
    { name: 'registered signer', signers: ['04' + '11'.repeat(64)], candidate: '04' + '11'.repeat(64), accepted: true },
    { name: 'registered signer with different casing', signers: [('04' + '11'.repeat(64)).toUpperCase()], candidate: '04' + '11'.repeat(64), accepted: true },
    { name: 'unregistered signer', signers: ['04' + '11'.repeat(64)], candidate: '04' + '22'.repeat(64), accepted: false },
    { name: 'empty signer set', signers: [], candidate: '04' + '11'.repeat(64), accepted: false },
] as const;

function signerBytes(value: RegisteredSigner): Uint8Array {
    if (value instanceof Uint8Array) return value;
    return hexToUint8Array(value);
}

/** The single rule used by web and mobile recovery: the key must be registered. */
export function isRegisteredSigner(signers: RegisteredSigner[], publicKey: RegisteredSigner): boolean {
    const target = bufferToHex(signerBytes(publicKey)).toLowerCase();
    return signers.some((signer) => bufferToHex(signerBytes(signer)).toLowerCase() === target);
}

export type WebAuthnAssertion = {
    authenticatorData: ArrayBuffer | Uint8Array;
    clientDataJSON: ArrayBuffer | Uint8Array;
    signature: ArrayBuffer | Uint8Array;
};

/** Verify one WebAuthn assertion against the wallet's on-chain signer set. */
export async function matchWebAuthnSigner(
    signers: RegisteredSigner[],
    assertion: WebAuthnAssertion,
): Promise<string | null> {
    const toBytes = (value: ArrayBuffer | Uint8Array) =>
        value instanceof Uint8Array ? value : new Uint8Array(value);
    const authData = toBytes(assertion.authenticatorData);
    const clientDataJSON = toBytes(assertion.clientDataJSON);
    const signature = toBytes(assertion.signature);
    const clientDataHash = new Uint8Array(
        await crypto.subtle.digest(
            'SHA-256',
            clientDataJSON.buffer.slice(
                clientDataJSON.byteOffset,
                clientDataJSON.byteOffset + clientDataJSON.byteLength,
            ) as ArrayBuffer,
        ),
    );
    const message = new Uint8Array(authData.length + clientDataHash.length);
    message.set(authData);
    message.set(clientDataHash, authData.length);
    const rawSignature = derToRawSignature(
        signature.buffer.slice(signature.byteOffset, signature.byteOffset + signature.byteLength) as ArrayBuffer,
    );

    for (const signer of signers) {
        const publicKey = signerBytes(signer);
        try {
            const cryptoKey = await crypto.subtle.importKey(
                'raw',
                publicKey.buffer.slice(publicKey.byteOffset, publicKey.byteOffset + publicKey.byteLength) as ArrayBuffer,
                { name: 'ECDSA', namedCurve: 'P-256' },
                false,
                ['verify'],
            );
            const valid = await crypto.subtle.verify(
                { name: 'ECDSA', hash: { name: 'SHA-256' } },
                cryptoKey,
                rawSignature.buffer as ArrayBuffer,
                message.buffer as ArrayBuffer,
            );
            if (valid) return bufferToHex(publicKey);
        } catch {
            // Ignore malformed or incompatible signer entries and try the next one.
        }
    }
    return null;
}
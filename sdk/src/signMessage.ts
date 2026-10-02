import { bufferToHex, hexToUint8Array } from './utils';
import type { WebAuthnSignature } from './core';

export type SignedMessage = {
    version: 1;
    domain: 'VEIL_SIGNED_MESSAGE_V1';
    messageHash: string;
    credentialId: string;
    signature: string;
    publicKey: string;
    authData: string;
    clientDataJSON: string;
};

const DOMAIN_BYTES = new TextEncoder().encode('VEIL_SIGNED_MESSAGE_V1\n');

async function domainSeparatedHash(message: Uint8Array): Promise<Uint8Array> {
    const payload = new Uint8Array(DOMAIN_BYTES.length + message.length);
    payload.set(DOMAIN_BYTES, 0);
    payload.set(message, DOMAIN_BYTES.length);
    const buf = await crypto.subtle.digest('SHA-256', payload);
    return new Uint8Array(buf);
}

export async function signMessage(
    message: Uint8Array,
    signAuthEntry: (payload: Uint8Array) => Promise<WebAuthnSignature | null>,
    credentialId: string
): Promise<SignedMessage> {
    const hash = await domainSeparatedHash(message);
    const sig = await signAuthEntry(hash);
    if (!sig) throw new Error('signAuthEntry returned null');
    return {
        version: 1,
        domain: 'VEIL_SIGNED_MESSAGE_V1',
        messageHash: bufferToHex(hash),
        credentialId,
        signature: bufferToHex(sig.signature),
        publicKey: bufferToHex(sig.publicKey),
        authData: bufferToHex(sig.authData),
        clientDataJSON: bufferToHex(sig.clientDataJSON),
    };
}

/**
 * Verify an off-chain signed message produced by signMessage().
 *
 * Performs full WebAuthn assertion verification:
 *  1. Re-derives the domain-separated hash and checks it matches signed.messageHash.
 *  2. Parses clientDataJSON and verifies challenge == base64url(hash), preventing
 *     reuse of Soroban auth signatures for message signing and vice versa.
 *  3. Verifies the P-256 ECDSA signature over authData || SHA-256(clientDataJSON).
 *
 * @param expectedCredentialId If provided, signed.credentialId must match exactly.
 *   Without this parameter the credentialId field is informational only. Callers who
 *   need to bind a signature to a known credential MUST pass this.
 *
 * Note: A SignedMessage is valid indefinitely (no nonce or expiry). Callers requiring
 * one-time-use semantics must track consumed messageHash values themselves.
 */
export async function verifyMessage(
    message: Uint8Array,
    signed: SignedMessage,
    expectedCredentialId?: string
): Promise<boolean> {
    try {
        // 1. Re-derive the domain-separated hash and compare
        const hash = await domainSeparatedHash(message);
        if (bufferToHex(hash) !== signed.messageHash) return false;

        // 2. Optional credential ID check
        if (expectedCredentialId !== undefined && signed.credentialId !== expectedCredentialId) {
            return false;
        }

        // 3. Parse clientDataJSON and verify WebAuthn challenge matches our hash.
        //    This prevents Soroban auth payloads from being used as message signatures.
        const clientDataJSONBytes = hexToUint8Array(signed.clientDataJSON);
        let clientData: { type?: string; challenge?: string };
        try {
            clientData = JSON.parse(new TextDecoder().decode(clientDataJSONBytes));
        } catch {
            return false;
        }
        if (clientData.type !== 'webauthn.get') return false;
        if (!clientData.challenge) return false;

        // base64url → bytes
        const b64 = clientData.challenge.replace(/-/g, '+').replace(/_/g, '/');
        const padding = (4 - (b64.length % 4)) % 4;
        const challengeBytes = Uint8Array.from(
            atob(b64 + '='.repeat(padding)),
            c => c.charCodeAt(0)
        );
        if (bufferToHex(challengeBytes) !== bufferToHex(hash)) return false;

        // 4. Reconstruct WebAuthn verification data: authData || SHA-256(clientDataJSON)
        const authDataBytes = hexToUint8Array(signed.authData);
        const clientDataHash = new Uint8Array(
            await crypto.subtle.digest('SHA-256', new Uint8Array(clientDataJSONBytes))
        );
        const verificationData = new Uint8Array(authDataBytes.length + clientDataHash.length);
        verificationData.set(authDataBytes, 0);
        verificationData.set(clientDataHash, authDataBytes.length);

        // 5. Verify P-256 ECDSA signature over verificationData
        const publicKeyBytes = hexToUint8Array(signed.publicKey);
        const signatureBytes = hexToUint8Array(signed.signature);

        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            new Uint8Array(publicKeyBytes),
            { name: 'ECDSA', namedCurve: 'P-256' },
            false,
            ['verify']
        );

        return await crypto.subtle.verify(
            { name: 'ECDSA', hash: { name: 'SHA-256' } },
            cryptoKey,
            new Uint8Array(signatureBytes),
            new Uint8Array(verificationData)
        );
    } catch {
        return false;
    }
}

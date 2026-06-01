/**
 * WebAuthn abstraction layer — browser (web) implementation.
 *
 * Metro automatically resolves this file to webauthn.native.ts when
 * bundling for React Native, so platform-specific logic is kept separate.
 */

import { extractP256PublicKey, derToRawSignature } from './utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WebAuthnCreateResult {
    /** Base64url-encoded credential ID. */
    credentialId: string;
    /** Uncompressed P-256 public key: 0x04 ‖ x ‖ y (65 bytes). */
    publicKeyBytes: Uint8Array;
}

export interface WebAuthnAssertResult {
    /** Raw authenticatorData bytes from the assertion response. */
    authData: Uint8Array;
    /** Raw clientDataJSON bytes. */
    clientDataJSON: Uint8Array;
    /** Raw P-256 ECDSA signature: r ‖ s (64 bytes, low-S normalised). */
    signature: Uint8Array;
}

export interface WebAuthnProvider {
    create(options: {
        challenge: Uint8Array;
        rpId: string;
        rpName: string;
        userId: Uint8Array;
        userName: string;
    }): Promise<WebAuthnCreateResult>;

    authenticate(options: {
        challenge: ArrayBuffer;
        credentialId: string;
        rpId?: string;
    }): Promise<WebAuthnAssertResult>;
}

// ── Browser implementation ────────────────────────────────────────────────────

export const webAuthnProvider: WebAuthnProvider = {
    async create({ challenge, rpId, rpName, userId, userName }) {
        // Slice to ensure a plain ArrayBuffer (Uint8Array.buffer may be SharedArrayBuffer)
        const challengeBuf = challenge.buffer.slice(
            challenge.byteOffset, challenge.byteOffset + challenge.byteLength
        ) as ArrayBuffer;
        const userIdBuf = userId.buffer.slice(
            userId.byteOffset, userId.byteOffset + userId.byteLength
        ) as ArrayBuffer;

        const credential = await navigator.credentials.create({
            publicKey: {
                challenge:  challengeBuf,
                rp: { id: rpId, name: rpName },
                user: { id: userIdBuf, name: userName, displayName: userName },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                timeout: 60_000,
                authenticatorSelection: {
                    residentKey: 'preferred',
                    userVerification: 'required',
                },
            },
        }) as PublicKeyCredential;

        if (!credential) throw new Error('Credential creation failed');

        const response = credential.response as AuthenticatorAttestationResponse;
        const publicKeyBytes = await extractP256PublicKey(response);

        return { credentialId: credential.id, publicKeyBytes };
    },

    async authenticate({ challenge, credentialId, rpId }) {
        const credIdBin = atob(credentialId.replace(/-/g, '+').replace(/_/g, '/'));
        const credId = Uint8Array.from(credIdBin, c => c.charCodeAt(0));

        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{ id: credId, type: 'public-key' }],
                userVerification: 'required',
                ...(rpId ? { rpId } : {}),
            },
        }) as PublicKeyCredential;

        if (!assertion) throw new Error('Authentication was cancelled');

        const response = assertion.response as AuthenticatorAssertionResponse;
        return {
            authData:       new Uint8Array(response.authenticatorData),
            clientDataJSON: new Uint8Array(response.clientDataJSON),
            signature:      derToRawSignature(response.signature),
        };
    },
};
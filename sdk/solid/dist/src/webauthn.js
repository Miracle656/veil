/**
 * WebAuthn abstraction layer — browser (web) implementation.
 *
 * Metro automatically resolves this file to webauthn.native.ts when
 * bundling for React Native, so platform-specific logic is kept separate.
 */
import { extractP256PublicKey, derToRawSignature } from './utils';
// ── Browser implementation ────────────────────────────────────────────────────
export const webAuthnProvider = {
    async create({ challenge, rpId, rpName, userId, userName, authenticatorAttachment }) {
        // Slice to ensure a plain ArrayBuffer (Uint8Array.buffer may be SharedArrayBuffer)
        const challengeBuf = challenge.buffer.slice(challenge.byteOffset, challenge.byteOffset + challenge.byteLength);
        const userIdBuf = userId.buffer.slice(userId.byteOffset, userId.byteOffset + userId.byteLength);
        // A roaming key is portable, so a discoverable (resident) credential is
        // what makes it usable from a second device without re-enrolling.
        const roaming = authenticatorAttachment === 'cross-platform';
        const credential = await navigator.credentials.create({
            publicKey: {
                challenge: challengeBuf,
                rp: { id: rpId, name: rpName },
                user: { id: userIdBuf, name: userName, displayName: userName },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                timeout: 60000,
                authenticatorSelection: {
                    residentKey: roaming ? 'required' : 'preferred',
                    userVerification: 'required',
                    ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
                },
            },
        });
        if (!credential)
            throw new Error('Credential creation failed');
        const response = credential.response;
        const publicKeyBytes = await extractP256PublicKey(response);
        // The platform reports the attachment actually used; fall back to what was
        // requested so a roaming credential is still tagged when unreported.
        const reportedAttachment = credential.authenticatorAttachment ?? authenticatorAttachment;
        const transports = typeof response.getTransports === 'function' ? response.getTransports() : undefined;
        return {
            credentialId: credential.id,
            publicKeyBytes,
            attestationObject: new Uint8Array(response.attestationObject),
            clientDataJSON: new Uint8Array(response.clientDataJSON),
            authenticatorAttachment: reportedAttachment ?? undefined,
            transports: transports && transports.length ? transports : undefined,
        };
    },
    async authenticate({ challenge, credentialId, rpId, transports }) {
        const credIdBin = atob(credentialId.replace(/-/g, '+').replace(/_/g, '/'));
        const credId = Uint8Array.from(credIdBin, c => c.charCodeAt(0));
        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{
                        id: credId,
                        type: 'public-key',
                        ...(transports && transports.length ? { transports: transports } : {}),
                    }],
                userVerification: 'required',
                ...(rpId ? { rpId } : {}),
            },
        });
        if (!assertion)
            throw new Error('Authentication was cancelled');
        const response = assertion.response;
        return {
            authData: new Uint8Array(response.authenticatorData),
            clientDataJSON: new Uint8Array(response.clientDataJSON),
            signature: derToRawSignature(response.signature),
        };
    },
};

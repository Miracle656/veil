/**
 * WebAuthn abstraction layer — browser (web) implementation.
 *
 * Metro automatically resolves this file to webauthn.native.ts when
 * bundling for React Native, so platform-specific logic is kept separate.
 */

import { extractP256PublicKey, derToRawSignature } from './utils';

function b64urlToUint8Array(b64: string): Uint8Array {
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function b64urlToArrayBuffer(b64: string): ArrayBuffer {
    const bytes = b64urlToUint8Array(b64);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Where the authenticator lives.
 *
 * - `platform`       — bound to this device (Touch ID, Windows Hello, a phone passkey).
 * - `cross-platform` — a roaming/portable authenticator such as a YubiKey or other
 *                      FIDO2 security key that can move between machines.
 */
export type AuthenticatorAttachment = 'platform' | 'cross-platform';

export interface WebAuthnCreateResult {
    /** Base64url-encoded credential ID. */
    credentialId: string;
    /** Uncompressed P-256 public key: 0x04 ‖ x ‖ y (65 bytes). */
    publicKeyBytes: Uint8Array;
    /**
     * Raw CBOR attestationObject bytes, when the platform exposes them. Required
     * to verify the attestation statement at registration; may be undefined on
     * platforms that do not surface it.
     */
    attestationObject?: Uint8Array;
    /** Raw clientDataJSON bytes from the registration response, when available. */
    clientDataJSON?: Uint8Array;
    /**
     * Which kind of authenticator produced the credential, as reported by the
     * platform. Used to distinguish a roaming security key (`cross-platform`)
     * from a device-bound platform passkey.
     */
    authenticatorAttachment?: AuthenticatorAttachment;
    /**
     * Transport hints (`usb`, `nfc`, `ble`, `hybrid`, `internal`) describing how
     * the authenticator can be reached. Persisted with a roaming credential so a
     * later assertion on any device can prompt for the right transport.
     */
    transports?: string[];
}

export interface WebAuthnAssertResult {
    /** Raw authenticatorData bytes from the assertion response. */
    authData: Uint8Array;
    /** Raw clientDataJSON bytes. */
    clientDataJSON: Uint8Array;
    /** Raw P-256 ECDSA signature: r ‖ s (64 bytes, low-S normalised). */
    signature: Uint8Array;
    /**
     * Uncompressed P-256 public key (65 bytes: 0x04 ‖ x ‖ y) when the
     * authenticator exposes it via `getPublicKey()` on the assertion response.
     * Platform passkeys (Touch ID, Windows Hello) generally do not expose the
     * key; cross-platform roaming keys (YubiKey, etc.) may. When null, the
     * caller cannot derive the wallet address from the assertion alone.
     */
    publicKeyBytes: Uint8Array | null;
}

export interface WebAuthnProvider {
    create(options: {
        challenge: Uint8Array;
        rpId: string;
        rpName: string;
        userId: Uint8Array;
        userName: string;
        /**
         * Request a specific authenticator type. Pass `cross-platform` to require
         * a roaming FIDO2 security key (YubiKey, etc.). Omitted lets the platform
         * decide (typically a device-bound platform passkey).
         */
        authenticatorAttachment?: AuthenticatorAttachment;
        /**
         * Credential ids already registered for this wallet (e.g. its existing
         * platform passkey and/or portable signer). Forwarded to
         * `excludeCredentials` so an authenticator that already holds one of
         * these refuses the request instead of silently replacing the
         * existing resident credential (same rp.id + user.id).
         */
        excludeCredentials?: { id: string; transports?: string[] }[];
    }): Promise<WebAuthnCreateResult>;

    authenticate(options: {
        challenge: ArrayBuffer;
        credentialId: string;
        rpId?: string;
        /**
         * Transport hints persisted with the credential. Forwarded to
         * `allowCredentials` so a roaming key prompts over the correct transport
         * (USB/NFC/BLE) on whatever device the assertion runs on.
         */
        transports?: string[];
    }): Promise<WebAuthnAssertResult>;
}

// ── Browser implementation ────────────────────────────────────────────────────

export const webAuthnProvider: WebAuthnProvider = {
    async create({ challenge, rpId, rpName, userId, userName, authenticatorAttachment, excludeCredentials }) {
        // Slice to ensure a plain ArrayBuffer (Uint8Array.buffer may be SharedArrayBuffer)
        const challengeBuf = challenge.buffer.slice(
            challenge.byteOffset, challenge.byteOffset + challenge.byteLength
        ) as ArrayBuffer;
        const userIdBuf = userId.buffer.slice(
            userId.byteOffset, userId.byteOffset + userId.byteLength
        ) as ArrayBuffer;

        // A roaming key is portable, so a discoverable (resident) credential is
        // what makes it usable from a second device without re-enrolling.
        const roaming = authenticatorAttachment === 'cross-platform';

        const credential = await navigator.credentials.create({
            publicKey: {
                challenge:  challengeBuf,
                rp: { id: rpId, name: rpName },
                user: { id: userIdBuf, name: userName, displayName: userName },
                pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                timeout: 60_000,
                ...(excludeCredentials && excludeCredentials.length
                    ? {
                        excludeCredentials: excludeCredentials.map(({ id, transports }) => ({
                            id:   b64urlToArrayBuffer(id),
                            type: 'public-key' as const,
                            ...(transports && transports.length ? { transports: transports as AuthenticatorTransport[] } : {}),
                        })),
                    }
                    : {}),
                authenticatorSelection: {
                    residentKey: roaming ? 'required' : 'preferred',
                    userVerification: 'required',
                    ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
                },
                // Enable the PRF extension at enrolment so this credential can
                // later derive the passkey-bound fee-payer seed (ADR 0003).
                // Authenticators without PRF simply ignore this — the credential
                // still works and the wallet falls back to legacy derivation.
                extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
            },
        }) as PublicKeyCredential;

        if (!credential) throw new Error('Credential creation failed');

        const response = credential.response as AuthenticatorAttestationResponse;
        const publicKeyBytes = await extractP256PublicKey(response);

        // The platform reports the attachment actually used; fall back to what was
        // requested so a roaming credential is still tagged when unreported.
        const reportedAttachment =
            (credential.authenticatorAttachment as AuthenticatorAttachment | null) ?? authenticatorAttachment;
        const transports =
            typeof response.getTransports === 'function' ? response.getTransports() : undefined;

        return {
            credentialId: credential.id,
            publicKeyBytes,
            attestationObject: new Uint8Array(response.attestationObject),
            clientDataJSON:    new Uint8Array(response.clientDataJSON),
            authenticatorAttachment: reportedAttachment ?? undefined,
            transports: transports && transports.length ? transports : undefined,
        };
    },

    async authenticate({ challenge, credentialId, rpId, transports }) {
        const credId = b64urlToUint8Array(credentialId);
        const credIdBuf = credId.buffer.slice(
            credId.byteOffset, credId.byteOffset + credId.byteLength
        ) as ArrayBuffer;

        const assertion = await navigator.credentials.get({
            publicKey: {
                challenge,
                allowCredentials: [{
                    id: credIdBuf,
                    type: 'public-key',
                    ...(transports && transports.length ? { transports: transports as AuthenticatorTransport[] } : {}),
                }],
                userVerification: 'required',
                ...(rpId ? { rpId } : {}),
            },
        }) as PublicKeyCredential;

        if (!assertion) throw new Error('Authentication was cancelled');

        const response = assertion.response as AuthenticatorAssertionResponse;
        // Attempt to extract the P-256 public key from the assertion response.
        // Some authenticators expose it via getPublicKey() (SPKI export);
        // others do not.  When available, the SDK can derive the deterministic
        // wallet address from the key alone — critical for cross-device login.
        let publicKeyBytes: Uint8Array | null = null;
        // getPublicKey() is not in the standard TS DOM typings but is supported
        // by Chrome/Edge and some other browsers on assertion responses.
        const resp = response as any;
        if (typeof resp.getPublicKey === 'function') {
            try {
                const spkiBuffer: ArrayBuffer | null = resp.getPublicKey();
                if (spkiBuffer) {
                    const cryptoKey = await crypto.subtle.importKey(
                        'spki', spkiBuffer,
                        { name: 'ECDSA', namedCurve: 'P-256' },
                        true, ['verify']
                    );
                    const rawBuffer = await crypto.subtle.exportKey('raw', cryptoKey);
                    publicKeyBytes = new Uint8Array(rawBuffer);
                }
            } catch {
                // Some platforms do not support SPKI export on assertion
                // responses — this is expected, not an error.
            }
        }

        return {
            authData:       new Uint8Array(response.authenticatorData),
            clientDataJSON: new Uint8Array(response.clientDataJSON),
            signature:      derToRawSignature(response.signature),
            publicKeyBytes,
        };
    },
};

/**
 * WebAuthn abstraction layer — React Native implementation.
 *
 * Metro resolves this file automatically when bundling for iOS/Android,
 * replacing the browser implementation in webauthn.ts.
 *
 * Requires: react-native-passkeys (install separately, see README)
 * Platforms: iOS 16+, Android 13+ (Credential Manager)
 *
 * Why react-native-passkeys and not react-native-passkey (issue #1043): the app
 * previously pinned two libraries over the same platform API — react-native-passkey
 * here (registration) and react-native-passkeys in `frontend/mobile/lib/passkey.ts`
 * (assertion, PRF, discoverable sign-in), each declaring a different
 * `androidx.credentials` version. Gradle quietly resolved one of them and a
 * resolution change is a device-specific failure mode. One library now carries
 * every ceremony the SDK and the app perform, and it is the one the funds-bearing
 * paths already proved on device: assertion with `prf.eval`, discoverable
 * assertion with no `allowCredentials`, and registration with `extensions: { prf: {} }`.
 */

// react-native-passkeys is an optional native peer dependency. It is a NATIVE
// module: absent in the web/Node build, and — critically — absent in Expo Go,
// where a top-level `import` of it throws at module-evaluation time and takes the
// whole app down before the first screen paints. So it is loaded LAZILY through
// `passkeys()` (a cached `require` in a try/catch): the app boots without it, and
// a passkey ceremony throws a clear, actionable error only when actually invoked
// (Expo Go cannot do native passkeys — use a development build). This mirrors the
// gating pattern proven in the zappr app, and the lazy-require already used by
// `frontend/mobile/lib/passkey.ts` for the same module.
type PasskeysNativeModule = {
    create: (request: unknown) => Promise<PasskeysCreateResponse | null>;
    get: (request: unknown) => Promise<PasskeysGetResponse | null>;
};

let cachedPasskeys: PasskeysNativeModule | null | undefined;

function loadPasskeys(): PasskeysNativeModule | null {
    if (cachedPasskeys !== undefined) return cachedPasskeys;
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        cachedPasskeys = require('react-native-passkeys') as PasskeysNativeModule;
    } catch {
        cachedPasskeys = null;
    }
    return cachedPasskeys;
}

/** Whether native passkeys are usable in this build (false in Expo Go / web). */
export function nativePasskeysAvailable(): boolean {
    return loadPasskeys() !== null;
}

function passkeys(): PasskeysNativeModule {
    const m = loadPasskeys();
    if (!m) {
        throw new Error(
            'Native passkeys are unavailable in this build. Expo Go cannot load the ' +
                'react-native-passkeys native module — use a development build to create ' +
                'or sign with a passkey.',
        );
    }
    return m;
}

import type { WebAuthnProvider, WebAuthnCreateResult, WebAuthnAssertResult } from './webauthn';
import { derToRawSignature } from './utils';

/**
 * react-native-passkeys speaks the JSON WebAuthn dialect: every binary field
 * arrives base64url-encoded, and the registration response exposes the SPKI via
 * `getPublicKey()` (see `CreationResponse` in the library's types).
 */
type PasskeysCreateResponse = {
    id: string;
    authenticatorAttachment?: 'platform' | 'cross-platform' | null;
    response: {
        clientDataJSON: string;
        attestationObject?: string;
        transports?: string[];
        getPublicKey(): string | null;
    };
};

type PasskeysGetResponse = {
    response: {
        signature: string;
        authenticatorData: string;
        clientDataJSON: string;
    };
};

// ── Base64url helpers ─────────────────────────────────────────────────────────

function b64urlToUint8Array(b64: string): Uint8Array {
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    const raw = atob(padded);
    return Uint8Array.from(raw, c => c.charCodeAt(0));
}

function uint8ArrayToB64url(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── SPKI → uncompressed P-256 ─────────────────────────────────────────────────

/**
 * Extract the 65-byte uncompressed P-256 point from a DER-encoded SPKI.
 *
 * react-native-passkeys returns the public key as base64url SPKI (91 bytes for
 * P-256).  The uncompressed EC point (0x04 ‖ x ‖ y) starts at offset 26.
 *
 * SPKI structure (P-256, 91 bytes):
 *   30 59              SEQUENCE
 *     30 13            SEQUENCE [AlgorithmIdentifier]
 *       06 07 ...      OID id-ecPublicKey
 *       06 08 ...      OID prime256v1
 *     03 42 00         BIT STRING (66 bytes, 0 unused bits)
 *       04 <x32> <y32> uncompressed EC point  ← offset 26
 */
function spkiToP256Uncompressed(spki: Uint8Array): Uint8Array {
    if (spki.length === 91 && spki[26] === 0x04) {
        return spki.slice(26); // fast path: 65 bytes
    }
    // Fallback: scan for the 0x04 uncompressed-point marker
    for (let i = 0; i <= spki.length - 65; i++) {
        if (spki[i] === 0x04) return spki.slice(i, i + 65);
    }
    throw new Error('Cannot extract P-256 uncompressed key from SPKI bytes');
}

// ── React Native provider ─────────────────────────────────────────────────────

export const webAuthnProvider: WebAuthnProvider = {
    async create({ challenge, rpId, rpName, userId, userName, authenticatorAttachment, excludeCredentials }): Promise<WebAuthnCreateResult> {
        const roaming = authenticatorAttachment === 'cross-platform';

        const result = await passkeys().create({
            challenge: uint8ArrayToB64url(challenge),
            rp:   { id: rpId, name: rpName },
            user: {
                id:          uint8ArrayToB64url(userId),
                name:        userName,
                displayName: userName,
            },
            pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            timeout: 60_000,
            ...(excludeCredentials && excludeCredentials.length
                ? {
                    excludeCredentials: excludeCredentials.map(({ id, transports }) => ({
                        id,
                        type: 'public-key',
                        ...(transports && transports.length ? { transports } : {}),
                    })),
                }
                : {}),
            authenticatorSelection: {
                residentKey:      roaming ? 'required' : 'preferred',
                userVerification: 'required',
                ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
            },
            // Enroll the PRF (hmac-secret) extension at creation. Without this,
            // some authenticators never expose PRF on later assertions — and the
            // PRF output is what deterministically derives the fee-payer key, so
            // it is the difference between a recoverable and a device-bound wallet.
            extensions: { prf: {} },
        });

        if (!result) throw new Error('Passkey creation failed or was cancelled');

        // getPublicKey() returns the DER SubjectPublicKeyInfo as a base64url
        // string, or null when the platform will not surface it.
        const publicKeyB64: string | null = result.response.getPublicKey();
        if (!publicKeyB64) {
            throw new Error(
                'react-native-passkeys did not return a public key in the registration response. ' +
                'Ensure iOS 16+ / Android 13+ is being used.'
            );
        }

        const spkiBytes = b64urlToUint8Array(publicKeyB64);
        const publicKeyBytes = spkiToP256Uncompressed(spkiBytes);

        // The library surfaces the raw attestation when the platform exposes it;
        // pass it through when present so callers can verify it at registration.
        const rawAttestation: string | undefined = result.response.attestationObject || undefined;
        const rawClientData:  string | undefined = result.response.clientDataJSON || undefined;

        const reportedAttachment = result.authenticatorAttachment ?? authenticatorAttachment;
        const transports: string[] | undefined = result.response.transports;

        return {
            credentialId: result.id,
            publicKeyBytes,
            attestationObject: rawAttestation ? b64urlToUint8Array(rawAttestation) : undefined,
            clientDataJSON:    rawClientData  ? b64urlToUint8Array(rawClientData)  : undefined,
            authenticatorAttachment: reportedAttachment ?? undefined,
            transports: transports && transports.length ? transports : undefined,
        };
    },

    async authenticate({ challenge, credentialId, rpId, transports }): Promise<WebAuthnAssertResult> {
        const challengeArr = new Uint8Array(challenge);

        const result = await passkeys().get({
            challenge:         uint8ArrayToB64url(challengeArr),
            allowCredentials:  [{
                id: credentialId,
                type: 'public-key',
                ...(transports && transports.length ? { transports } : {}),
            }],
            userVerification:  'required',
            ...(rpId ? { rpId } : {}),
        });

        if (!result) throw new Error('Passkey authentication failed or was cancelled');

        const derSig = b64urlToUint8Array(result.response.signature);

        // No publicKeyBytes here, and there cannot be one: `react-native-passkey`
        // exposes the key only on the registration response, and WebAuthn assertions
        // do not carry a key at all. That is not a gap — the SDK recovers the signing
        // key from this raw r ‖ s signature plus authData and clientDataJSON
        // (crypto/assertionKey.ts), so login() resolves a wallet on mobile exactly as
        // it does on the web.
        return {
            authData:       b64urlToUint8Array(result.response.authenticatorData),
            clientDataJSON: b64urlToUint8Array(result.response.clientDataJSON),
            signature:      derToRawSignature(derSig.buffer as ArrayBuffer),
            // Platform passkeys do not expose the public key on an assertion
            // response; the caller already holds it from registration.
            publicKeyBytes: null,
        };
    },
};

/**
 * WebAuthn abstraction layer — React Native implementation.
 *
 * Metro resolves this file automatically when bundling for iOS/Android,
 * replacing the browser implementation in webauthn.ts.
 *
 * Requires: react-native-passkey (install separately, see README)
 * Platforms: iOS 16+, Android 13+
 */

// react-native-passkey is an optional native peer dependency. It is a NATIVE
// module: absent in the web/Node build, and — critically — absent in Expo Go,
// where a top-level `import` of it throws at module-evaluation time and takes the
// whole app down before the first screen paints. So it is loaded LAZILY through
// `passkey()` (a cached `require` in a try/catch): the app boots without it, and
// a passkey ceremony throws a clear, actionable error only when actually invoked
// (Expo Go cannot do native passkeys — use a development build). This mirrors the
// gating pattern proven in the zappr app.
type PasskeyNativeModule = {
  create: (request: unknown) => Promise<PasskeyCreateResponse | null>;
  authenticate: (request: unknown) => Promise<PasskeyAuthResponse | null>;
};

let cachedPasskey: PasskeyNativeModule | null | undefined;

function loadPasskey(): PasskeyNativeModule | null {
  if (cachedPasskey !== undefined) return cachedPasskey;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedPasskey = (require('react-native-passkey') as { Passkey: PasskeyNativeModule }).Passkey;
  } catch {
    cachedPasskey = null;
  }
  return cachedPasskey;
}

/** Whether native passkeys are usable in this build (false in Expo Go / web). */
export function nativePasskeysAvailable(): boolean {
  return loadPasskey() !== null;
}

function passkey(): PasskeyNativeModule {
  const m = loadPasskey();
  if (!m) {
    throw new Error(
      'Native passkeys are unavailable in this build. Expo Go cannot load the ' +
        'react-native-passkey native module — use a development build to create ' +
        'or sign with a passkey.',
    );
  }
  return m;
}

import type { WebAuthnProvider, WebAuthnCreateResult, WebAuthnAssertResult } from './webauthn';
import { derToRawSignature } from './utils';

type PasskeyCreateResponse = {
  id: string;
  authenticatorAttachment?: 'platform' | 'cross-platform' | null;
  response: {
    publicKey: string;
    attestationObject?: string;
    clientDataJSON?: string;
    transports?: string[];
  };
};

type PasskeyAuthResponse = {
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
 * Extract the 65-byte uncompressed P-256 public key from a DER-encoded SPKI.
 *
 * react-native-passkey returns the public key as base64url SPKI (91 bytes for
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

        const result = await passkey().create({
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

        const publicKeyB64: string = result.response.publicKey;
        if (!publicKeyB64) {
            throw new Error(
                'react-native-passkey did not return a public key in the registration response. ' +
                'Ensure iOS 16+ / Android 13+ is being used.'
            );
        }

        const spkiBytes = b64urlToUint8Array(publicKeyB64);
        const publicKeyBytes = spkiToP256Uncompressed(spkiBytes);

        // react-native-passkey may expose the raw attestation when configured to;
        // pass it through when present so callers can verify it at registration.
        const rawAttestation: string | undefined = result.response.attestationObject;
        const rawClientData:  string | undefined = result.response.clientDataJSON;

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

        const result = await passkey().authenticate({
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

        return {
            authData:       b64urlToUint8Array(result.response.authenticatorData),
            clientDataJSON: b64urlToUint8Array(result.response.clientDataJSON),
            signature:      derToRawSignature(derSig.buffer as ArrayBuffer),
        };
    },
};
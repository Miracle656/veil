/**
 * WebAuthn abstraction layer — browser (web) implementation.
 *
 * Metro automatically resolves this file to webauthn.native.ts when
 * bundling for React Native, so platform-specific logic is kept separate.
 */
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
export declare const webAuthnProvider: WebAuthnProvider;

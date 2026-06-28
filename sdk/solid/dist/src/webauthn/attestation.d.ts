/**
 * WebAuthn attestation verification at registration.
 *
 * Verifying the attestation statement returned by `navigator.credentials.create()`
 * lets a relying party enforce authenticator provenance and policy — for example,
 * requiring a hardware authenticator or rejecting a known-weak AAGUID.
 *
 * This module supports the two most common attestation formats:
 *
 *   - **`none`**   — no statement; nothing to verify cryptographically, but the
 *                    AAGUID and credential public key are still parsed so a policy
 *                    can inspect them.
 *   - **`packed`** — the FIDO2 default. Two sub-cases:
 *       - *self attestation* (no `x5c`): the statement is signed by the
 *         credential's own private key. Fully verified here against the public
 *         key embedded in `authData`.
 *       - *basic/full attestation* (`x5c` present): signed by an attestation
 *         certificate. The signature is verified against the leaf certificate's
 *         public key.
 *
 * ── Trade-offs (deliberately out of scope) ───────────────────────────────────
 * For `x5c` (basic) attestation this module verifies the statement signature
 * against the **leaf certificate**, but does NOT walk the certificate chain to a
 * trusted FIDO Metadata Service (MDS) root. Full chain-to-root validation
 * requires shipping and maintaining a root store, which is an application-level
 * policy decision. Callers who need it should perform chain validation inside
 * their {@link AttestationPolicy} using the parsed certificates. Treating a
 * self-signed `packed` statement as proof of provenance is also weaker than a
 * full chain — the policy hook is where you encode how much you trust each case.
 */
/** Thrown when the attestation object cannot be parsed or its signature is invalid. */
export declare class AttestationError extends Error {
    constructor(message: string);
}
/** Thrown when a caller-supplied {@link AttestationPolicy} rejects the credential. */
export declare class AttestationPolicyError extends Error {
    constructor(message: string);
}
/** How the attestation statement was (or was not) cryptographically verified. */
export type AttestationType = 'self' | 'basic' | 'none' | 'unsupported';
/** Parsed, optionally-verified attestation details handed to a policy. */
export interface AttestationInfo {
    /** Attestation statement format, e.g. "packed" or "none". */
    fmt: string;
    /** Authenticator AAGUID as a lowercase hex string (32 chars), or "" if absent. */
    aaguid: string;
    /** Raw 16-byte AAGUID. */
    aaguidBytes: Uint8Array;
    /** The newly-created credential ID. */
    credentialId: Uint8Array;
    /** Uncompressed P-256 public key (0x04 ‖ x ‖ y) from authData, if EC2/ES256. */
    publicKey?: Uint8Array;
    /** Authenticator signature counter. */
    signCount: number;
    /** Whether a cryptographic attestation statement was present and verified. */
    verified: boolean;
    /** Verification method used to produce {@link verified}. */
    attestationType: AttestationType;
    /** Raw DER leaf attestation certificate, when the format includes an x5c chain. */
    leafCert?: Uint8Array;
}
/**
 * A policy callback run after parsing/verification. Return `false` (or throw) to
 * reject the registration; return `true`/`undefined` to accept. Use it to gate
 * on {@link AttestationInfo.aaguid}, {@link AttestationInfo.fmt}, or whether the
 * statement {@link AttestationInfo.verified | verified}.
 *
 * @example
 * // Require a verified hardware authenticator from an allow-list of AAGUIDs.
 * const policy: AttestationPolicy = (info) =>
 *   info.verified && ALLOWED_AAGUIDS.has(info.aaguid);
 */
export type AttestationPolicy = (info: AttestationInfo) => boolean | void | Promise<boolean | void>;
export interface VerifyAttestationOptions {
    /** Raw `AuthenticatorAttestationResponse.attestationObject` bytes. */
    attestationObject: Uint8Array | ArrayBuffer;
    /** Raw `AuthenticatorAttestationResponse.clientDataJSON` bytes. */
    clientDataJSON: Uint8Array | ArrayBuffer;
    /** Optional policy hook; rejection throws {@link AttestationPolicyError}. */
    policy?: AttestationPolicy;
    /**
     * When true (default), a `packed` statement whose signature fails to verify
     * throws {@link AttestationError}. Set false to record `verified: false`
     * and defer the decision to the policy instead.
     */
    requireValidSignature?: boolean;
}
/**
 * Parse and (where possible) verify a WebAuthn attestation statement, then apply
 * an optional policy.
 *
 * @throws {AttestationError}        if the object can't be parsed, or a packed
 *                                   signature is invalid and `requireValidSignature`.
 * @throws {AttestationPolicyError}  if the policy returns `false` or throws.
 */
export declare function verifyAttestation(opts: VerifyAttestationOptions): Promise<AttestationInfo>;

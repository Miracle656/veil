import { useState, useEffect } from 'react';
import {
    bufferToHex,
    hexToUint8Array,
    derToRawSignature,
    extractP256PublicKey,
    computeWalletAddress,
} from './utils';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * The four pieces the contract's __check_auth needs to verify a WebAuthn assertion.
 *
 * Pass these as [publicKey, authData, clientDataJSON, signature] in the Soroban
 * auth entry's signature field (Vec<Val> with 4 elements).
 */
export type WebAuthnSignature = {
    /** Uncompressed P-256 public key: 0x04 ‖ x ‖ y (65 bytes) */
    publicKey: Uint8Array;
    /** Raw authenticatorData bytes from the WebAuthn assertion response */
    authData: Uint8Array;
    /** Raw clientDataJSON bytes — contains the challenge (= signaturePayload) base64url-encoded */
    clientDataJSON: Uint8Array;
    /** Raw P-256 ECDSA signature: r ‖ s (64 bytes) */
    signature: Uint8Array;
};

/** Result returned by a successful register() call. */
export type RegisterResult = {
    /** The deterministically computed contract address of the new wallet ("C..."). */
    walletAddress: string;
};

type InvisibleWallet = {
    /** Soroban contract address of the deployed wallet, or null if not yet registered. */
    address: string | null;
    isPending: boolean;
    error: string | null;
    /**
     * Create a new passkey credential and compute the deterministic wallet address.
     * Returns the wallet address so callers can display or pre-fund it immediately.
     * (Phase 3: will also wire to factory contract to deploy on-chain.)
     */
    register: (username: string) => Promise<RegisterResult>;
    /**
     * Sign a Soroban authorization entry using the stored passkey.
     *
     * @param signaturePayload  The 32-byte payload from the Soroban SorobanAuthorizationEntry.
     *                          This is set as the WebAuthn challenge so the contract can verify it.
     */
    signAuthEntry: (signaturePayload: Uint8Array) => Promise<WebAuthnSignature | null>;
    /** Restore an existing wallet session from localStorage. */
    login: () => Promise<void>;
};

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useInvisibleWallet(factoryAddress: string): InvisibleWallet {
    const [address, setAddress] = useState<string | null>(null);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const stored = localStorage.getItem('invisible_wallet_address');
        if (stored) setAddress(stored);
    }, []);

    const register = async (username: string): Promise<RegisterResult> => {
        setIsPending(true);
        setError(null);
        try {
            // Registration challenge is random — it only needs to be unique per session.
            // The signing challenge (in signAuthEntry) is the Soroban signature_payload.
            const challenge = crypto.getRandomValues(new Uint8Array(32));

            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge,
                    rp: { name: 'Invisible Wallet' },
                    user: {
                        id: new TextEncoder().encode(username),
                        name: username,
                        displayName: username,
                    },
                    pubKeyCredParams: [{ type: 'public-key', alg: -7 }], // ES256 = P-256
                    timeout: 60_000,
                    authenticatorSelection: {
                        residentKey: 'preferred',
                        userVerification: 'required',
                    },
                },
            }) as PublicKeyCredential;

            if (!credential) throw new Error('Credential creation failed');

            // Extract the 65-byte uncompressed P-256 public key from the attestation
            const response = credential.response as AuthenticatorAttestationResponse;
            const publicKeyBytes = await extractP256PublicKey(response);
            const publicKeyHex = bufferToHex(publicKeyBytes);

            // Compute the deterministic wallet address from the factory + public key.
            // This matches the address the factory contract will assign on deployment,
            // so the frontend can show it (or pre-fund it) before the tx lands.
            // TODO (Phase 3): also call factoryContract.deploy(publicKeyHex) here.
            const walletAddress = computeWalletAddress(factoryAddress, publicKeyBytes);

            localStorage.setItem('invisible_wallet_address',    walletAddress);
            localStorage.setItem('invisible_wallet_key_id',     credential.id);
            localStorage.setItem('invisible_wallet_public_key', publicKeyHex);
            setAddress(walletAddress);

            return { walletAddress };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err; // re-throw so callers can handle it (e.g. show an error banner)
        } finally {
            setIsPending(false);
        }
    };

    const login = async () => {
        const stored = localStorage.getItem('invisible_wallet_address');
        if (stored) {
            setAddress(stored);
        } else {
            setError('No wallet found. Please register first.');
        }
    };

    const signAuthEntry = async (
        signaturePayload: Uint8Array
    ): Promise<WebAuthnSignature | null> => {
        setIsPending(true);
        setError(null);
        try {
            const keyId       = localStorage.getItem('invisible_wallet_key_id');
            const publicKeyHex = localStorage.getItem('invisible_wallet_public_key');
            if (!keyId)        throw new Error('No key ID found. Please register first.');
            if (!publicKeyHex) throw new Error('No public key found. Please register first.');

            if (signaturePayload.length !== 32) {
                throw new Error('signaturePayload must be exactly 32 bytes');
            }

            // The challenge IS the Soroban signature_payload.
            // The contract verifies that base64url(challenge) appears in clientDataJSON,
            // binding this WebAuthn assertion to this specific transaction authorization.
            // Slice to get a plain ArrayBuffer (satisfies SubtleCrypto / WebAuthn types).
            const challenge = signaturePayload.buffer.slice(
                signaturePayload.byteOffset,
                signaturePayload.byteOffset + signaturePayload.byteLength
            ) as ArrayBuffer;

            // Base64url-decode the credential ID
            const credIdBin = atob(
                keyId.replace(/-/g, '+').replace(/_/g, '/')
            );
            const credId = Uint8Array.from(credIdBin, c => c.charCodeAt(0));

            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge,
                    allowCredentials: [{ id: credId, type: 'public-key' }],
                    userVerification: 'required',
                },
            }) as PublicKeyCredential;

            if (!assertion) throw new Error('Signing was cancelled');

            const response = assertion.response as AuthenticatorAssertionResponse;

            // Convert DER-encoded WebAuthn signature → raw 64-byte P-256 (r ‖ s)
            const rawSignature = derToRawSignature(response.signature);

            const publicKeyBytes = hexToUint8Array(publicKeyHex);

            return {
                publicKey:    publicKeyBytes,
                authData:     new Uint8Array(response.authenticatorData),
                clientDataJSON: new Uint8Array(response.clientDataJSON),
                signature:    rawSignature,
            };

        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
            return null;
        } finally {
            setIsPending(false);
        }
    };

    return { address, isPending, error, register, signAuthEntry, login };
}

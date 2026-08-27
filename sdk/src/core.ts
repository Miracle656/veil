/**
 * Core wallet types, error classes, and framework-agnostic helpers.
 *
 * Extracted from useInvisibleWallet.ts (PR #662) so the React and Vue
 * bindings share the same canonical definitions and cannot drift apart.
 */

import {
    Keypair,
    rpc as SorobanRpc,
    TransactionBuilder,
    BASE_FEE,
} from '@stellar/stellar-sdk';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal key–value storage interface compatible with both localStorage (web)
 * and async stores like AsyncStorage (React Native).
 *
 * Pass a custom adapter via WalletConfig.storage to override the default
 * (localStorage on web, no-op if localStorage is unavailable).
 */
export type StorageAdapter = {
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
    removeItem?(key: string): void | Promise<void>;
};

/**
 * Configuration passed when mounting the wallet.
 * Keeping these at hook level (rather than per-method) lets the caller set them
 * once and have every method — deploy, sign, etc. — share the same network context.
 */
export type WalletConfig = {
    /** The factory contract's Stellar strkey (e.g. "CABC..."). */
    factoryAddress: string;
    /** Stellar Horizon-compatible RPC endpoint (e.g. "https://soroban-testnet.stellar.org"). */
    rpcUrl: string;
    /** Stellar network passphrase. Use Networks.TESTNET or Networks.PUBLIC. */
    networkPassphrase: string;
    /** The WebAuthn relying party ID (e.g. "localhost"). Required for React Native. */
    rpId?: string;
    /** The WebAuthn origin (e.g. "https://veil.app"). Required for React Native. */
    origin?: string;
    /**
     * Optional storage adapter for persisting wallet credentials.
     * Defaults to localStorage on web. Pass AsyncStorage (or a compatible adapter)
     * when running in React Native.
     */
    storage?: StorageAdapter;
    /**
     * When true (default), the hook replays any transactions persisted in the
     * offline outbox automatically whenever the browser fires an `online`
     * event. Set to false to drive replay manually via {@link replayOutbox}.
     * Has no effect outside a DOM environment (e.g. React Native).
     */
    autoReplayOnReconnect?: boolean;
    /**
     * Optional WebAuthn attestation policy, run during register(). When set, the
     * attestation statement returned by the authenticator is parsed and verified,
     * and this hook decides whether to accept the credential (e.g. require a
     * verified hardware authenticator, or gate on AAGUID). Returning false — or
     * throwing — from the policy aborts registration.
     */
    attestationPolicy?: import('./webauthn/attestation').AttestationPolicy;
    /**
     * When an attestationPolicy is set but the platform did not surface the raw
     * attestationObject (so it cannot be verified), abort registration if this is
     * true (default false — proceed without verification).
     */
    requireAttestation?: boolean;
    /**
     * Optional Stellar secret used to sponsor network fees. When set, mutating
     * transactions are submitted as fee-bump envelopes paid by this account.
     */
    sponsorSecret?: string;
    /** Base fee used by the outer fee-bump transaction. Defaults to BASE_FEE. */
    feeBumpBaseFee?: string;
};

/**
 * The four pieces the contract's __check_auth needs to verify a WebAuthn assertion.
 */
export type WebAuthnSignature = {
    /** Uncompressed P-256 public key: 0x04 x y (65 bytes) */
    publicKey: Uint8Array;
    /** Raw authenticatorData bytes from the WebAuthn assertion response */
    authData: Uint8Array;
    /** Raw clientDataJSON bytes */
    clientDataJSON: Uint8Array;
    /** Raw P-256 ECDSA signature: r s (64 bytes) */
    signature: Uint8Array;
};

/** A contract invocation executed by batch() under one wallet authorization. */
export type BatchOperation = {
    /** Target contract address. */
    target: string;
    /** Target contract function name. */
    functionName: string;
    /** Arguments encoded as Soroban ScVals. */
    args?: import('@stellar/stellar-sdk').xdr.ScVal[];
};

/**
 * Where the WebAuthn credential lives.
 *
 * - `platform`       — a device-bound passkey (Touch ID, Windows Hello, …).
 * - `cross-platform` — a roaming/portable FIDO2 security key (YubiKey, etc.)
 *                      that can sign from any device it is plugged into.
 */
export type AuthenticatorAttachment = 'platform' | 'cross-platform';

/** Optional knobs for register(). */
export type RegisterOptions = {
    /**
     * Request a specific authenticator type. Pass `cross-platform` to enrol a
     * roaming FIDO2 security key (YubiKey, etc.) as a portable signer rather
     * than a device-bound platform passkey. Defaults to letting the platform
     * decide.
     */
    authenticatorAttachment?: AuthenticatorAttachment;
};

/**
 * Options for the login() method.
 *
 * On a device with no prior local state, pass a credentialId (base64url) so
 * the SDK can derive the deterministic wallet address from the passkey.
 * Alternatively, pass a walletAddress directly to skip derivation and only
 * verify on-chain existence.
 */
export type LoginOptions = {
    /**
     * Base64url-encoded credential ID of the passkey to authenticate with.
     * When provided (and no local address is stored), the SDK triggers a
     * WebAuthn assertion, extracts the P-256 public key, derives the
     * deterministic wallet address, and verifies it exists on-chain.
     */
    credentialId?: string;
    /**
     * Known wallet contract address ("C..."). When provided, skips
     * credential-based derivation and verifies on-chain existence directly.
     */
    walletAddress?: string;
};

/**
 * A roaming (cross-platform) credential, persisted independently of platform
 * passkeys so it can be identified and used as a portable signer across devices.
 */
export type PortableSigner = {
    /** Base64url-encoded credential ID of the roaming key. */
    credentialId: string;
    /** Hex-encoded uncompressed P-256 public key (65 bytes). */
    publicKey: string;
    /** Always `cross-platform` for a portable signer. */
    authenticatorAttachment: 'cross-platform';
    /** Transport hints (usb/nfc/ble/hybrid) used to prompt for the key. */
    transports: string[];
};

/** Result returned by a successful register() call. */
export type RegisterResult = {
    /** The deterministically computed contract address of the new wallet ("C..."). */
    walletAddress: string;
    /** The uncompressed P-256 public key bytes (65 bytes). */
    publicKeyBytes: Uint8Array;
    /** The authenticator type the credential was created with, when reported. */
    authenticatorAttachment?: AuthenticatorAttachment;
    /**
     * True when the credential is a roaming FIDO2 security key persisted as a
     * portable signer (independent of platform passkeys). Optional so existing
     * callers that don't enrol roaming keys remain source-compatible.
     */
    isPortableSigner?: boolean;
};

/** Result returned by a successful deploy() call. */
export type DeployResult = {
    /** The on-chain contract address of the deployed wallet ("C..."). */
    walletAddress: string;
    /**
     * True if the wallet was already deployed before this call.
     * When true, no transaction was submitted.
     */
    alreadyDeployed: boolean;
};

/** Result returned by a successful addSigner() call. */
export type AddSignerResult = {
    /** The index of the newly added signer in the wallet's signer list. */
    signerIndex: number;
};

/** Result returned by a successful rotateSigner() call. */
export type RotateSignerResult = {
    /** The previous (rotated-out) P-256 public key bytes (65 bytes). */
    oldPublicKeyBytes: Uint8Array;
    /** The newly registered P-256 public key bytes (65 bytes). */
    newPublicKeyBytes: Uint8Array;
    /**
     * The wallet's contract address — unchanged by the rotation. Returned so
     * callers can assert that the address (and therefore balances) is preserved.
     */
    walletAddress: string;
};

/** Result returned by getSigners(). */
export type SignerInfo = {
    /** The index of the signer in the wallet's signer list. */
    index: number;
    /** The hex-encoded P-256 public key of the signer. */
    publicKey: string;
};

/** Result returned by a successful initiateRecovery() call. */
export type InitiateRecoveryResult = {
    /** Unix timestamp (seconds) after which completeRecovery() can be called. */
    unlockTime: number;
};

// ── Errors ────────────────────────────────────────────────────────────────────

/** Thrown when completeRecovery() is called before the timelock has expired. */
export class RecoveryTimelockActive extends Error {
    constructor(public readonly unlockTime: number) {
        super(`Recovery timelock active until ${unlockTime}`);
        this.name = 'RecoveryTimelockActive';
    }
}

/** Thrown when recovery methods are called but no guardian has been set. */
export class NoGuardianSet extends Error {
    constructor() {
        super('No guardian set on this wallet');
        this.name = 'NoGuardianSet';
    }
}

/** Thrown when completeRecovery() is called but no recovery is in progress. */
export class RecoveryNotPending extends Error {
    constructor() {
        super('No recovery is currently pending');
        this.name = 'RecoveryNotPending';
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const POLL_INTERVAL_MS  = 1_000;
export const POLL_MAX_ATTEMPTS = 30;

/** Storage key holding the roaming (cross-platform) credential as a portable signer. */
export const PORTABLE_SIGNER_KEY = 'invisible_wallet_portable_signer';

/**
 * Poll server.getTransaction(hash) until the transaction leaves NOT_FOUND,
 * then return the final result. Throws if it fails or we exceed the attempt limit.
 */
export async function waitForTransaction(
    server: SorobanRpc.Server,
    hash: string
): Promise<SorobanRpc.Api.GetTransactionResponse> {
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        const result = await server.getTransaction(hash);
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
            return result;
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Transaction ${hash} not confirmed after ${POLL_MAX_ATTEMPTS} attempts`);
}

export function resolveSponsorKeypair(config: WalletConfig): Keypair | null {
    return config.sponsorSecret ? Keypair.fromSecret(config.sponsorSecret) : null;
}

export function signForSubmission(
    tx: any,
    signerKeypair: Keypair,
    config: WalletConfig,
    extraInnerSigners: Keypair[] = []
) {
    tx.sign(signerKeypair);
    for (const extraSigner of extraInnerSigners) {
        if (extraSigner.publicKey() !== signerKeypair.publicKey()) {
            tx.sign(extraSigner);
        }
    }

    const sponsor = resolveSponsorKeypair(config);
    if (!sponsor) return tx;

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        sponsor.publicKey(),
        config.feeBumpBaseFee ?? BASE_FEE,
        tx,
        config.networkPassphrase
    );
    feeBump.sign(sponsor);
    return feeBump;
}

/** Build a storage adapter from the config, defaulting to localStorage on web. */
export function resolveStorage(storage?: StorageAdapter): StorageAdapter {
    if (storage) return storage;
    if (typeof localStorage !== 'undefined') {
        return {
            getItem:    (k) => localStorage.getItem(k),
            setItem:    (k, v) => localStorage.setItem(k, v),
            removeItem: (k) => localStorage.removeItem(k),
        };
    }
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

/** Read and parse the persisted portable-signer record, or null if none/invalid. */
export async function readPortableSigner(store: StorageAdapter): Promise<PortableSigner | null> {
    const raw = await store.getItem(PORTABLE_SIGNER_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as PortableSigner;
        if (parsed && parsed.authenticatorAttachment === 'cross-platform' && parsed.credentialId) {
            return { ...parsed, transports: parsed.transports ?? [] };
        }
        return null;
    } catch {
        return null;
    }
}

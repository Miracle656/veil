import { Keypair } from '@stellar/stellar-sdk';
import { TransactionOutbox, type ReplayOptions, type ReplayResult } from './outbox';
import { type AttestationPolicy } from './webauthn/attestation';
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
 * Configuration passed when mounting the hook.
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
     *
     * @example
     * // React Native with @react-native-async-storage/async-storage:
     * import AsyncStorage from '@react-native-async-storage/async-storage';
     * const config = { ..., storage: AsyncStorage };
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
     *
     * @example
     * const config = { ..., attestationPolicy: (info) =>
     *   info.verified && ALLOWED_AAGUIDS.has(info.aaguid) };
     */
    attestationPolicy?: AttestationPolicy;
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
     * roaming FIDO2 security key as a portable signer rather than a device-bound
     * platform passkey. Defaults to letting the platform decide.
     */
    authenticatorAttachment?: AuthenticatorAttachment;
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
/** Thrown when completeRecovery() is called before the timelock has expired. */
export declare class RecoveryTimelockActive extends Error {
    readonly unlockTime: number;
    constructor(unlockTime: number);
}
/** Thrown when recovery methods are called but no guardian has been set. */
export declare class NoGuardianSet extends Error {
    constructor();
}
/** Thrown when completeRecovery() is called but no recovery is in progress. */
export declare class RecoveryNotPending extends Error {
    constructor();
}
export type InvisibleWallet = {
    /** Soroban contract address of the deployed wallet, or null if not yet registered. */
    address: string | null;
    /** True if the wallet contract has been confirmed to exist on-chain. */
    isDeployed: boolean;
    isPending: boolean;
    error: string | null;
    /**
     * Create a new WebAuthn credential and compute the deterministic wallet address.
     *
     * Pass `{ authenticatorAttachment: 'cross-platform' }` to enrol a roaming
     * FIDO2 security key (YubiKey, etc.) as a portable signer that can sign from
     * any device the key is plugged into. The roaming credential is persisted
     * independently of platform passkeys — see {@link getPortableSigner}.
     */
    register: (username?: string, options?: RegisterOptions) => Promise<RegisterResult>;
    /**
     * Deploy the user's wallet contract on-chain via the factory.
     *
     * Reads the P-256 public key stored by a prior register() call and submits
     * a Soroban transaction to the factory contract. If the wallet is already
     * deployed, returns the existing address without submitting a new transaction.
     *
     * @param signerKeypair  A traditional Stellar Keypair used as the transaction
     *                       fee source. Separate from the passkey — pays fees only,
     *                       does not control the wallet.
     * @param publicKeyBytes Optional override for the P-256 public key. Defaults to
     *                       the key stored in storage by register().
     * @returns The deployed wallet's contract address and whether it was already live.
     */
    deploy: (signerKeypair: Keypair | string, publicKeyBytes?: Uint8Array) => Promise<DeployResult>;
    /**
     * Sign a Soroban authorization entry using the stored passkey.
     *
     * @param signaturePayload  The 32-byte payload from the Soroban SorobanAuthorizationEntry.
     */
    signAuthEntry: (signaturePayload: Uint8Array) => Promise<WebAuthnSignature | null>;
    /** Derive the counterfactual wallet address for a given P-256 public key before deployment. */
    deriveCounterfactualAddress: (publicKeyBytes: Uint8Array) => import('./counterfactual').CounterfactualAddress;
    /**
     * Return the roaming FIDO2 credential persisted as a portable signer, or null
     * if the active credential is a device-bound platform passkey. Stored under a
     * dedicated key so it is identified independently of platform passkeys.
     */
    getPortableSigner: () => Promise<PortableSigner | null>;
    /**
     * Restore an existing wallet session from storage.
     * Verifies that the wallet contract actually exists on-chain before setting the address.
     */
    login: () => Promise<{
        walletAddress: string;
    } | null>;
    /**
     * Read the wallet contract's current nonce without submitting a transaction.
     * Uses `server.simulateTransaction` to invoke `get_nonce` in read-only mode.
     *
     * @returns The current nonce as a bigint.
     */
    getNonce: () => Promise<bigint>;
    /**
     * Register an additional P-256 public key as a valid signer on the wallet contract.
     * Follows the simulate → build → sign → submit → poll pattern.
     *
     * @param signerKeypair    The Stellar Keypair used as the transaction fee source.
     * @param newPublicKeyBytes The uncompressed P-256 public key (65 bytes) to add.
     * @returns The index of the newly added signer.
     */
    addSigner: (signerKeypair: Keypair, newPublicKeyBytes: Uint8Array) => Promise<AddSignerResult>;
    /**
     * Remove a signer from the wallet contract by index.
     * Follows the simulate → build → sign → submit → poll pattern.
     *
     * @param signerKeypair The Stellar Keypair used as the transaction fee source.
     * @param signerIndex   The index of the signer to remove.
     */
    removeSigner: (signerKeypair: Keypair, signerIndex: number) => Promise<void>;
    /**
     * Fetch the list of all registered signers from the wallet contract.
     *
     * @returns Array of SignerInfo objects containing index and hex public key.
     */
    getSigners: () => Promise<SignerInfo[]>;
    /**
     * Set a guardian address that can initiate key recovery for this wallet.
     * Requires WebAuthn authentication — builds an auth entry, signs it with the
     * stored passkey, and submits the transaction.
     *
     * @param signerKeypair   Stellar Keypair used as the transaction fee source.
     * @param guardianAddress Stellar address (G...) of the guardian account.
     */
    setGuardian: (signerKeypair: Keypair, guardianAddress: string) => Promise<void>;
    /**
     * Initiate guardian-based key recovery. Replaces the wallet's signer after
     * a timelock expires. Signed using the guardian's regular Stellar keypair.
     *
     * @param guardianKeypair  The guardian's Stellar Keypair.
     * @param newPublicKeyBytes Uncompressed P-256 public key (65 bytes) of the new signer.
     * @returns The unix timestamp after which completeRecovery() can be called.
     * @throws {NoGuardianSet} If no guardian has been configured.
     */
    initiateRecovery: (guardianKeypair: Keypair, newPublicKeyBytes: Uint8Array) => Promise<InitiateRecoveryResult>;
    /**
     * Complete a pending guardian recovery after the timelock has expired.
     * This is a permissionless call — any Stellar keypair can submit it.
     *
     * @param payerKeypair Any Stellar Keypair to pay the transaction fee.
     * @throws {RecoveryTimelockActive} If the timelock has not yet expired.
     * @throws {RecoveryNotPending}     If no recovery is in progress.
     */
    completeRecovery: (payerKeypair: Keypair) => Promise<void>;
    /**
     * Set a spending limit for a specific token and spender.
     * Requires WebAuthn authentication.
     *
     * @param signerKeypair Stellar Keypair used as the transaction fee source.
     * @param spender       Stellar address of the spender.
     * @param token         Stellar address of the token contract.
     * @param amount        Maximum amount the spender is allowed to spend.
     * @param expiry        Optional Unix timestamp (seconds) when the allowance expires.
     */
    approve: (signerKeypair: Keypair, spender: string, token: string, amount: number, expiry?: number) => Promise<void>;
    /**
     * Get the current on-chain balance of this wallet from a token contract.
     * @param token Optional token contract address. Defaults to native XLM.
     */
    getBalance: (token?: string) => Promise<{
        address: string;
        amount: bigint;
        assetCode: string;
    }>;
    /**
     * Send a payment from this wallet contract using a fee payer.
     * @param signerKeypair Stellar Keypair or secret used to pay transaction fees.
     * @param to Recipient address.
     * @param amount Amount in contract units (stroops for native XLM).
     * @param token Optional token contract address. Defaults to native XLM.
     * @param memo Optional transaction memo.
     */
    sendPayment: (signerKeypair: Keypair | string, to: string, amount: number | bigint, token?: string, memo?: string) => Promise<{
        transactionHash: string;
        status: 'PENDING' | 'SUCCESS' | 'FAILED';
    }>;
    /**
     * Get the current allowance for a spender and token.
     *
     * @param spender       Stellar address of the spender.
     * @param token         Stellar address of the token contract.
     * @returns Object with amount and expiry, or null if no allowance exists.
     */
    getAllowance: (spender: string, token: string) => Promise<{
        amount: number;
        expiry: number | undefined;
    } | null>;
    /**
     * The durable offline transaction outbox. Record a signed transaction here
     * (via {@link TransactionOutbox.enqueue}) before submitting it so it can be
     * replayed if the network call is lost. Persists through the configured
     * StorageAdapter, so queued transactions survive a reload.
     */
    outbox: TransactionOutbox;
    /**
     * Replay any transactions still queued in the offline outbox against the
     * network. Safe to call repeatedly — already-confirmed transactions are
     * deduped by hash and never resubmitted (at-most-once).
     *
     * @returns A summary of which queued transactions confirmed, failed, were
     *          already on-chain, or remain pending.
     */
    replayOutbox: (opts?: ReplayOptions) => Promise<ReplayResult>;
    /**
     * Encrypt local app data (cached metadata, backup blobs, …) with a symmetric
     * key derived from the user's passkey via the WebAuthn PRF extension.
     *
     * The first call runs an interactive PRF assertion (the same passkey gesture
     * as signing) and caches the derived key for the session. The key is stable
     * across sessions for the same credential, so ciphertext written in one
     * session decrypts in the next. When PRF is unsupported, falls back to a
     * random key persisted in the configured storage adapter — see
     * {@link encryptionMode}.
     *
     * @param plaintext UTF-8 string or raw bytes to encrypt.
     * @returns Base64 ciphertext (iv ‖ ciphertext), unreadable without the passkey.
     */
    encryptLocal: (plaintext: string | Uint8Array) => Promise<string>;
    /**
     * Decrypt a payload previously produced by {@link encryptLocal}.
     * @returns The decoded UTF-8 plaintext.
     */
    decryptLocal: (payload: string) => Promise<string>;
    /**
     * Resolve which key-derivation path local encryption uses for the current
     * credential: 'prf' (passkey-bound) or 'fallback' (local random key, not
     * bound to the passkey). Useful to warn users on the weaker fallback path.
     */
    encryptionMode: () => Promise<'prf' | 'fallback'>;
};
export declare function useInvisibleWallet(config: WalletConfig): InvisibleWallet;

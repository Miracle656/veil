/**
 * Framework-agnostic wallet core.
 *
 * Every piece of wallet behaviour — passkey registration, contract deployment,
 * Soroban authorization signing, payments, multi-signer and guardian recovery —
 * lives here as a plain class with no framework imports. The React hook
 * (`useInvisibleWallet`) and the Vue composable (`invisible-wallet-sdk/vue`)
 * are thin reactive wrappers over this one implementation, so the two adapters
 * stay in lockstep by construction rather than by discipline.
 *
 * State changes are published through {@link InvisibleWalletCore.subscribe},
 * which is shaped for React's `useSyncExternalStore` and just as usable from a
 * Vue `ref` or any other observer.
 */

import {
    Account,
    Asset,
    Contract,
    Keypair,
    rpc as SorobanRpc,
    Horizon,
    TransactionBuilder,
    BASE_FEE,
    xdr,
    nativeToScVal,
    scValToNative,
    Networks,
    hash as stellarHash,
} from '@stellar/stellar-sdk';

const HorizonServer = Horizon.Server;
import {
    bufferToHex,
    hexToUint8Array,
    computeWalletAddress,
} from './utils';
import { webAuthnProvider } from './webauthn';
import { TransactionOutbox, type ReplayOptions, type ReplayResult } from './outbox';
import { verifyAttestation, AttestationError, type AttestationPolicy } from './webauthn/attestation';
import { createLocalCipher, type LocalCipher } from './crypto/prf';
import {
    deriveCounterfactualAddress as _deriveCounterfactualAddress,
    type CounterfactualAddress,
} from './counterfactual';

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
 * Configuration passed when creating a wallet.
 * Keeping these at wallet level (rather than per-method) lets the caller set them
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
     * Read once, when the wallet is created: a later config update keeps the
     * adapter the wallet already owns, so its offline outbox stays intact.
     *
     * @example
     * // React Native with @react-native-async-storage/async-storage:
     * import AsyncStorage from '@react-native-async-storage/async-storage';
     * const config = { ..., storage: AsyncStorage };
     */
    storage?: StorageAdapter;
    /**
     * When true (default), transactions persisted in the offline outbox are
     * replayed automatically whenever the browser fires an `online` event.
     * Set to false to drive replay manually via {@link InvisibleWalletActions.replayOutbox}.
     * Has no effect outside a DOM environment (e.g. React Native).
     */
    autoReplayOnReconnect?: boolean;
    /**
     * Optional WebAuthn attestation policy, run during register(). When set, the
     * attestation statement returned by the authenticator is parsed and verified,
     * and this policy decides whether to accept the credential (e.g. require a
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

// ── Recovery Errors ───────────────────────────────────────────────────────────

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

// ── Public surface ────────────────────────────────────────────────────────────

/**
 * The observable half of a wallet: everything an adapter mirrors into its own
 * reactive primitives (React state, Vue refs, a store, …).
 */
export type WalletState = {
    /** Soroban contract address of the deployed wallet, or null if not yet registered. */
    address: string | null;
    /** True if the wallet contract has been confirmed to exist on-chain. */
    isDeployed: boolean;
    /** True while any wallet operation is in flight. */
    isPending: boolean;
    /** Message of the most recent failure, or null. */
    error: string | null;
};

/**
 * The callable half of a wallet. Adapters spread this beside their own reactive
 * state, so a method added to the core reaches React and Vue at the same time.
 */
export type InvisibleWalletActions = {
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
    deriveCounterfactualAddress: (publicKeyBytes: Uint8Array) => CounterfactualAddress;
    /**
     * Return the roaming FIDO2 credential persisted as a portable signer, or null
     * if the active credential is a device-bound platform passkey. Stored under a
     * dedicated key so it is identified independently of platform passkeys.
     */
    getPortableSigner: () => Promise<PortableSigner | null>;
    /**
     * Restore an existing wallet session, or discover one from a passkey.
     *
     * On a device with stored state the previous behaviour is preserved: the
     * address is read from local storage and verified on-chain.
     *
     * When no address is stored (fresh device / cleared data), callers can
     * pass `{ credentialId }` so the SDK derives the deterministic wallet
     * address from the passkey public key, or `{ walletAddress }` to verify
     * a known address directly.
     *
     * @param options  Optional credential ID or wallet address for cross-device login.
     */
    login: (options?: LoginOptions) => Promise<{ walletAddress: string } | null>;
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
     * Rotate the wallet's passkey signer without redeploying — the device-loss
     * recovery flow. Registers a brand-new WebAuthn credential, then calls the
     * contract's `rotate_signer(old_key, new_key)` entrypoint, authorizing the
     * swap with the **current** passkey (an interactive assertion). The wallet
     * address and balances are preserved; afterwards the new credential becomes
     * the active signer in storage.
     *
     * Two user gestures are involved: creating the new credential, and signing
     * the rotation with the existing one.
     *
     * @param signerKeypair Stellar Keypair used as the transaction fee source.
     *                      Separate from the passkey — pays fees only.
     * @param username      Optional display name for the new credential.
     * @param options       Optional WebAuthn options for the new credential
     *                      (e.g. `authenticatorAttachment`).
     * @returns The old/new public keys and the unchanged wallet address.
     */
    rotateSigner: (signerKeypair: Keypair, username?: string, options?: RegisterOptions) => Promise<RotateSignerResult>;
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
    getBalance: (token?: string) => Promise<{ address: string; amount: bigint; assetCode: string }>;
    /**
     * Send a payment from this wallet contract using a fee payer.
     * @param signerKeypair Stellar Keypair or secret used to pay transaction fees.
     * @param to Recipient address.
     * @param amount Amount in contract units (stroops for native XLM).
     * @param token Optional token contract address. Defaults to native XLM.
     * @param memo Optional transaction memo.
     */
    sendPayment: (
        signerKeypair: Keypair | string,
        to: string,
        amount: number | bigint,
        token?: string,
        memo?: string,
    ) => Promise<{ transactionHash: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }>;
    /**
     * Get the current allowance for a spender and token.
     *
     * @param spender       Stellar address of the spender.
     * @param token         Stellar address of the token contract.
     * @returns Object with amount and expiry, or null if no allowance exists.
     */
    getAllowance: (spender: string, token: string) => Promise<{ amount: number; expiry: number | undefined } | null>;
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

/** The full wallet surface returned by the React hook and the Vue composable. */
export type InvisibleWallet = WalletState & InvisibleWalletActions;

/** Notified with the new state whenever any of the four fields changes. */
export type WalletStateListener = (state: WalletState) => void;

// ── Helpers ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 1_000;
const POLL_MAX_ATTEMPTS = 30;

/** Storage key holding the roaming (cross-platform) credential as a portable signer. */
const PORTABLE_SIGNER_KEY = 'invisible_wallet_portable_signer';

/** Storage key holding this wallet's persisted WebAuthn user.id (hex-encoded). */
const USER_ID_KEY = 'invisible_wallet_user_id';

/**
 * Poll server.getTransaction(hash) until the transaction leaves NOT_FOUND,
 * then return the final result. Throws if it fails or we exceed the attempt limit.
 */
async function waitForTransaction(
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

function resolveSponsorKeypair(config: WalletConfig): Keypair | null {
    return config.sponsorSecret ? Keypair.fromSecret(config.sponsorSecret) : null;
}

function signForSubmission(
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
function resolveStorage(storage?: StorageAdapter): StorageAdapter {
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
async function readPortableSigner(store: StorageAdapter): Promise<PortableSigner | null> {
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

/**
 * Resolve this wallet's WebAuthn user.id, generating and persisting a random
 * one on first use. Kept independent of any caller-supplied display name so
 * two different people who happen to choose the same username never collide
 * on the same authenticator.
 */
async function resolveUserId(store: StorageAdapter): Promise<Uint8Array> {
    const existing = await store.getItem(USER_ID_KEY);
    if (existing) return hexToUint8Array(existing);
    const fresh = crypto.getRandomValues(new Uint8Array(16));
    await store.setItem(USER_ID_KEY, bufferToHex(fresh));
    return fresh;
}

/**
 * Credential ids already known for this wallet (its platform passkey and/or
 * portable signer), to pass as excludeCredentials on the next registration so
 * an authenticator that already holds one of them refuses the request rather
 * than silently replacing the existing resident credential.
 */
async function collectKnownCredentials(
    store: StorageAdapter
): Promise<{ id: string; transports?: string[] }[]> {
    const known = new Map<string, string[] | undefined>();
    const keyId = await store.getItem('invisible_wallet_key_id');
    if (keyId) known.set(keyId, undefined);
    const portable = await readPortableSigner(store);
    if (portable) known.set(portable.credentialId, portable.transports);
    return Array.from(known, ([id, transports]) => ({ id, transports }));
}

// ── Core ──────────────────────────────────────────────────────────────────────

/**
 * A passkey wallet, independent of any UI framework.
 *
 * Methods are bound instance fields, so they survive being destructured or
 * handed to a template as callbacks. Use {@link actions} to spread the whole
 * callable surface into an adapter's return value.
 */
export class InvisibleWalletCore {
    /** Every wallet action, pre-bound, for adapters to spread beside their state. */
    readonly actions: InvisibleWalletActions;

    private config: WalletConfig;
    private readonly store: StorageAdapter;
    private readonly outbox: TransactionOutbox;
    private readonly listeners = new Set<WalletStateListener>();

    /**
     * The PRF-derived cipher, cached so the interactive assertion runs at most
     * once per session.
     */
    private cipher: LocalCipher | null = null;

    private state: WalletState = {
        address:    null,
        isDeployed: false,
        isPending:  false,
        error:      null,
    };

    constructor(config: WalletConfig) {
        this.config = config;
        this.store  = resolveStorage(config.storage);
        this.outbox = new TransactionOutbox(this.store);

        this.actions = {
            register:                    this.register,
            deploy:                      this.deploy,
            signAuthEntry:               this.signAuthEntry,
            deriveCounterfactualAddress: this.deriveCounterfactualAddress,
            getPortableSigner:           this.getPortableSigner,
            login:                       this.login,
            getNonce:                    this.getNonce,
            addSigner:                   this.addSigner,
            removeSigner:                this.removeSigner,
            rotateSigner:                this.rotateSigner,
            getSigners:                  this.getSigners,
            setGuardian:                 this.setGuardian,
            initiateRecovery:            this.initiateRecovery,
            completeRecovery:            this.completeRecovery,
            approve:                     this.approve,
            getAllowance:                this.getAllowance,
            getBalance:                  this.getBalance,
            sendPayment:                 this.sendPayment,
            outbox:                      this.outbox,
            replayOutbox:                this.replayOutbox,
            encryptLocal:                this.encryptLocal,
            decryptLocal:                this.decryptLocal,
            encryptionMode:              this.encryptionMode,
        };
    }

    // ── State ─────────────────────────────────────────────────────────────────

    /**
     * The current state. Referentially stable until something actually changes,
     * which is what React's `useSyncExternalStore` requires of a snapshot.
     */
    getState = (): WalletState => this.state;

    /** Observe state changes. Returns the unsubscribe function. */
    subscribe = (listener: WalletStateListener): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };

    /**
     * Adopt a new config. The storage adapter is deliberately not swapped — the
     * outbox and the PRF cipher are bound to the store this wallet was created
     * with. Create a new wallet to move to different storage.
     */
    setConfig = (config: WalletConfig): void => {
        this.config = config;
    };

    /**
     * Restore the wallet address persisted by a previous session. Adapters call
     * this once they are on the client (React `useEffect`, Vue `onMounted`), so
     * nothing touches storage during server rendering.
     *
     * Supports both synchronous (localStorage) and asynchronous (AsyncStorage)
     * adapters.
     */
    hydrate = (): void => {
        const maybeStored = this.store.getItem('invisible_wallet_address');
        if (maybeStored && typeof (maybeStored as Promise<unknown>).then === 'function') {
            void (maybeStored as Promise<string | null>).then((v) => { if (v) this.setAddress(v); });
        } else {
            const stored = maybeStored as string | null;
            if (stored) this.setAddress(stored);
        }
    };

    /**
     * Replay the offline outbox whenever connectivity returns, unless the config
     * opted out. Returns the teardown function; a no-op outside the browser.
     */
    watchConnectivity = (): (() => void) => {
        if (this.config.autoReplayOnReconnect === false) return () => {};
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {};
        const onOnline = () => { void this.replayOutbox().catch(() => { /* surfaced via per-entry status */ }); };
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    };

    /** Publish a state change, skipping no-op writes so observers stay quiet. */
    private patch(changes: Partial<WalletState>): void {
        const next = { ...this.state, ...changes };
        if (
            next.address    === this.state.address &&
            next.isDeployed === this.state.isDeployed &&
            next.isPending  === this.state.isPending &&
            next.error      === this.state.error
        ) return;

        this.state = next;
        for (const listener of this.listeners) listener(next);
    }

    private setAddress(address: string | null)  { this.patch({ address }); }
    private setIsDeployed(isDeployed: boolean)  { this.patch({ isDeployed }); }
    private setIsPending(isPending: boolean)    { this.patch({ isPending }); }
    private setError(error: string | null)      { this.patch({ error }); }

    /** The wallet address, or an explanatory throw when there is none yet. */
    private requireAddress(): string {
        const { address } = this.state;
        if (!address) throw new Error('No wallet address. Call register() or login() first.');
        return address;
    }

    /** The relying party ID, falling back to the current page on the web. */
    private resolveRpId(): string {
        return this.config.rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
    }

    // ── register ──────────────────────────────────────────────────────────────

    register = async (username?: string, options?: RegisterOptions): Promise<RegisterResult> => {
        const { factoryAddress, networkPassphrase } = this.config;
        const store = this.store;

        this.setIsPending(true);
        this.setError(null);
        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const normalizedUsername = username ? username.normalize('NFC') : undefined;
            const name   = normalizedUsername || 'Veil User';
            const userId = await resolveUserId(store);

            const resolvedRpId = this.resolveRpId();

            // Guard against an authenticator silently replacing an existing
            // resident credential for this wallet (matching rp.id + user.id).
            const excludeCredentials = await collectKnownCredentials(store);

            const { credentialId, publicKeyBytes, attestationObject, clientDataJSON, authenticatorAttachment, transports } = await webAuthnProvider.create({
                challenge,
                rpId:     resolvedRpId,
                rpName:   'Invisible Wallet',
                userId,
                userName: name,
                authenticatorAttachment: options?.authenticatorAttachment,
                excludeCredentials,
            });

            // Optional attestation verification — enforce authenticator policy.
            if (this.config.attestationPolicy) {
                if (attestationObject && clientDataJSON) {
                    await verifyAttestation({
                        attestationObject,
                        clientDataJSON,
                        policy: this.config.attestationPolicy,
                    });
                } else if (this.config.requireAttestation) {
                    throw new AttestationError(
                        'Attestation required but the platform did not expose an attestationObject.'
                    );
                }
            }

            const publicKeyHex  = bufferToHex(publicKeyBytes);
            const walletAddress = computeWalletAddress(factoryAddress, publicKeyBytes, networkPassphrase);

            // Treat the credential as a portable signer when either the caller asked
            // for a roaming key or the platform reported a cross-platform attachment.
            const resolvedAttachment = authenticatorAttachment ?? options?.authenticatorAttachment;
            const isPortableSigner = resolvedAttachment === 'cross-platform';

            await store.setItem('invisible_wallet_address',    walletAddress);
            await store.setItem('invisible_wallet_key_id',     credentialId);
            await store.setItem('invisible_wallet_public_key', publicKeyHex);

            if (isPortableSigner) {
                // Persist the roaming credential under its own key so it is stored and
                // identified independently of platform passkeys, and so signAuthEntry
                // can replay its transports when signing from another device.
                const portable: PortableSigner = {
                    credentialId,
                    publicKey: publicKeyHex,
                    authenticatorAttachment: 'cross-platform',
                    transports: transports ?? [],
                };
                await store.setItem(PORTABLE_SIGNER_KEY, JSON.stringify(portable));
            } else if (store.removeItem) {
                // Clear any stale portable-signer record from a previous roaming enrolment.
                await store.removeItem(PORTABLE_SIGNER_KEY);
            }

            this.setAddress(walletAddress);
            this.setIsDeployed(false);

            return { walletAddress, publicKeyBytes, authenticatorAttachment: resolvedAttachment, isPortableSigner };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── deriveCounterfactualAddress ───────────────────────────────────────────

    deriveCounterfactualAddress = (publicKeyBytes: Uint8Array): CounterfactualAddress => {
        const { factoryAddress, networkPassphrase } = this.config;
        return _deriveCounterfactualAddress(publicKeyBytes, { factoryAddress, networkPassphrase });
    };

    // ── getPortableSigner ─────────────────────────────────────────────────────

    getPortableSigner = async (): Promise<PortableSigner | null> => {
        return readPortableSigner(this.store);
    };

    // ── deploy ────────────────────────────────────────────────────────────────

    deploy = async (
        signerSecret: string | Keypair,
        publicKeyBytes?: Uint8Array
    ): Promise<DeployResult> => {
        const { factoryAddress, rpcUrl, networkPassphrase, origin } = this.config;
        const store = this.store;

        const signerKeypair = typeof signerSecret === 'string'
            ? Keypair.fromSecret(signerSecret)
            : Keypair.fromSecret(signerSecret.secret());
        this.setIsPending(true);
        this.setError(null);
        let walletAddress: string | undefined;
        try {
            let pubKeyBytes = publicKeyBytes;
            if (!pubKeyBytes) {
                const hex = await store.getItem('invisible_wallet_public_key');
                if (!hex) throw new Error(
                    'No public key found. Call register() first, or pass publicKeyBytes explicitly.'
                );
                pubKeyBytes = hexToUint8Array(hex);
            }

            walletAddress = computeWalletAddress(factoryAddress, pubKeyBytes, networkPassphrase);

            const server = new SorobanRpc.Server(rpcUrl);

            const horizonUrl = networkPassphrase === Networks.TESTNET
                ? 'https://horizon-testnet.stellar.org'
                : 'https://horizon.stellar.org';
            const horizon = new HorizonServer(horizonUrl);
            const sourceAccount = await horizon.loadAccount(signerKeypair.publicKey());
            const factory = new Contract(factoryAddress);

            const resolvedRpId   = this.resolveRpId();
            const resolvedOrigin = origin ?? (typeof window !== 'undefined' ? window.location.origin : `https://${resolvedRpId}`);

            const rpIdBytes   = new TextEncoder().encode(resolvedRpId);
            const originBytes = new TextEncoder().encode(resolvedOrigin);

            const txBuilder = new TransactionBuilder(sourceAccount, {
                // Mainnet surge-prices Soroban inclusion; the minimum bid gets the
                // deploy stuck until it expires. Overbidding is safe — the ledger
                // charges the effective rate, not the bid.
                fee: networkPassphrase === Networks.PUBLIC ? '1000000' : BASE_FEE,
                networkPassphrase,
            });

            txBuilder.addOperation(
                factory.call(
                    'deploy',
                    nativeToScVal(pubKeyBytes,  { type: 'bytes' }),
                    nativeToScVal(rpIdBytes,    { type: 'bytes' }),
                    nativeToScVal(originBytes,  { type: 'bytes' }),
                )
            );

            const tx = txBuilder.setTimeout(30).build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, signerKeypair, this.config);

            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

            this.setAddress(walletAddress);
            this.setIsDeployed(true);
            await store.setItem('invisible_wallet_address', walletAddress);
            return { walletAddress, alreadyDeployed: false };

        } catch (err: unknown) {
            let message: string;
            if (err instanceof Error) {
                message = err.message;
            } else {
                try { message = JSON.stringify(err); } catch { message = String(err); }
            }
            if (message.toLowerCase().includes('alreadydeployed') || message.toLowerCase().includes('already_deployed')) {
                this.setAddress(walletAddress!);
                this.setIsDeployed(true);
                await store.setItem('invisible_wallet_address', walletAddress!);
                return { walletAddress: walletAddress!, alreadyDeployed: true };
            }
            this.setError(message);
            throw new Error(message);
        } finally {
            this.setIsPending(false);
        }
    };

    // ── login ─────────────────────────────────────────────────────────────────

    login = async (options?: LoginOptions): Promise<{ walletAddress: string } | null> => {
        const { factoryAddress, rpcUrl, networkPassphrase } = this.config;
        const store = this.store;

        this.setIsPending(true);
        this.setError(null);
        try {
            const server = new SorobanRpc.Server(rpcUrl);

            // ── Path 1: local storage has an address (original behaviour) ──────
            let candidateAddress = await store.getItem('invisible_wallet_address');

            // ── Path 2: caller supplied a known wallet address ────────────────
            if (!candidateAddress && options?.walletAddress) {
                candidateAddress = options.walletAddress;
            }

            // ── Path 3: derive address from a passkey credential ──────────────
            if (!candidateAddress && options?.credentialId) {
                const resolvedRpId = this.resolveRpId();
                const portable = await readPortableSigner(store);

                // Trigger a WebAuthn assertion so the user authenticates with
                // their passkey.  The provider now exposes publicKeyBytes when
                // the authenticator supports SPKI export on assertion responses.
                const challengeU8 = crypto.getRandomValues(new Uint8Array(32));
                const assertResult = await webAuthnProvider.authenticate({
                    challenge: challengeU8.buffer.slice(
                        challengeU8.byteOffset, challengeU8.byteOffset + challengeU8.byteLength
                    ) as ArrayBuffer,
                    credentialId: options.credentialId,
                    rpId: resolvedRpId,
                    transports: portable?.transports,
                });

                if (assertResult.publicKeyBytes && assertResult.publicKeyBytes.length === 65) {
                    candidateAddress = computeWalletAddress(
                        factoryAddress,
                        assertResult.publicKeyBytes,
                        networkPassphrase
                    );
                }
            }

            // ── Verify on-chain ──────────────────────────────────────────────
            if (!candidateAddress) {
                this.setError(
                    'No wallet found. Please register first, or pass a ' +
                    'credentialId / walletAddress to login().'
                );
                return null;
            }

            try {
                await server.getContractData(
                    candidateAddress,
                    xdr.ScVal.scvLedgerKeyContractInstance(),
                    SorobanRpc.Durability.Persistent
                );

                // Persist for subsequent calls on this device.
                await store.setItem('invisible_wallet_address', candidateAddress);
                this.setAddress(candidateAddress);
                this.setIsDeployed(true);
                return { walletAddress: candidateAddress };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.toLowerCase().includes('not found')) {
                    this.setError('Wallet not yet deployed. Call deploy() to create it on-chain.');
                    this.setAddress(null);
                    this.setIsDeployed(false);
                    return null;
                } else {
                    throw e;
                }
            }
        } catch (err: unknown) {
            this.setError(err instanceof Error ? err.message : String(err));
            return null;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── signAuthEntry ─────────────────────────────────────────────────────────

    signAuthEntry = async (
        signaturePayload: Uint8Array
    ): Promise<WebAuthnSignature | null> => {
        const { rpId } = this.config;
        const store = this.store;

        this.setIsPending(true);
        this.setError(null);
        try {
            const keyId        = await store.getItem('invisible_wallet_key_id');
            const publicKeyHex = await store.getItem('invisible_wallet_public_key');
            if (!keyId)        throw new Error('No key ID found. Please register first.');
            if (!publicKeyHex) throw new Error('No public key found. Please register first.');

            if (signaturePayload.length !== 32) {
                throw new Error('signaturePayload must be exactly 32 bytes');
            }

            const challenge = signaturePayload.buffer.slice(
                signaturePayload.byteOffset,
                signaturePayload.byteOffset + signaturePayload.byteLength
            ) as ArrayBuffer;

            // For a roaming key, forward the stored transports so the assertion can
            // prompt for the security key over USB/NFC/BLE on any device.
            const portable = await readPortableSigner(store);

            const { authData, clientDataJSON, signature } = await webAuthnProvider.authenticate({
                challenge,
                credentialId: keyId,
                rpId,
                transports: portable?.transports,
            });

            const publicKeyBytes = hexToUint8Array(publicKeyHex);

            return { publicKey: publicKeyBytes, authData, clientDataJSON, signature };

        } catch (err: unknown) {
            this.setError(err instanceof Error ? err.message : String(err));
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    /**
     * Sign every address-credential auth entry produced by a simulation with the
     * stored passkey, rewriting each entry's signature in place.
     *
     * Shared by every passkey-gated call (setGuardian, rotateSigner, approve,
     * sendPayment) so the Soroban authorization payload is derived — and bound
     * to the WebAuthn challenge — in exactly one place.
     */
    private async authorizeEntries(sim: SorobanRpc.Api.SimulateTransactionSuccessResponse): Promise<void> {
        const authEntries = sim.result?.auth;
        if (!authEntries) return;

        // stellarHash is a synchronous SHA-256 — avoids crypto.subtle (unavailable on some RN setups)
        const networkIdBytes = new Uint8Array(
            (stellarHash as (input: Buffer) => Buffer)(Buffer.from(this.config.networkPassphrase))
        );

        for (const parsed of authEntries) {
            const cred = parsed.credentials();
            if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
                continue;
            }

            const addrCred = cred.address();
            const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
                new xdr.HashIdPreimageSorobanAuthorization({
                    networkId: Buffer.from(networkIdBytes),
                    nonce: addrCred.nonce(),
                    invocation: parsed.rootInvocation(),
                    signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                })
            );
            const payloadHash = new Uint8Array(
                (stellarHash as (input: Buffer) => Buffer)(Buffer.from(preimage.toXDR()))
            );

            const webAuthnSig = await this.signAuthEntry(payloadHash);
            if (!webAuthnSig) throw new Error('WebAuthn signing was cancelled');

            const sigVec = xdr.ScVal.scvVec([
                nativeToScVal(webAuthnSig.publicKey,      { type: 'bytes' }),
                nativeToScVal(webAuthnSig.authData,       { type: 'bytes' }),
                nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
                nativeToScVal(webAuthnSig.signature,      { type: 'bytes' }),
            ]);

            parsed.credentials(
                xdr.SorobanCredentials.sorobanCredentialsAddress(
                    new xdr.SorobanAddressCredentials({
                        address: addrCred.address(),
                        nonce: addrCred.nonce(),
                        signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                        signature: sigVec,
                    })
                )
            );
        }
    }

    // ── getNonce ──────────────────────────────────────────────────────────────

    getNonce = async (): Promise<bigint> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);

            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('get_nonce'))
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
            if (!result) throw new Error('Simulation returned no result');

            const nonce = scValToNative(result.retval) as bigint;
            return nonce;

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── addSigner ─────────────────────────────────────────────────────────────

    addSigner = async (
        signerKeypair: Keypair,
        newPublicKeyBytes: Uint8Array
    ): Promise<AddSignerResult> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();
            if (newPublicKeyBytes.length !== 65) {
                throw new Error('newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)');
            }

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(
                    walletContract.call(
                        'add_signer',
                        nativeToScVal(newPublicKeyBytes, { type: 'bytes' })
                    )
                )
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, signerKeypair, this.config);

            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

            let signerIndex = 0;
            if ('returnValue' in txResult && txResult.returnValue) {
                try {
                    signerIndex = scValToNative(txResult.returnValue) as number;
                } catch {
                    // Contract may not return an index — default to 0
                }
            }

            return { signerIndex };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── getSigners ────────────────────────────────────────────────────────────

    getSigners = async (): Promise<SignerInfo[]> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);

            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('get_signers'))
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
            if (!result) throw new Error('Simulation returned no result');

            const signersData = scValToNative(result.retval);
            const infos: SignerInfo[] = [];

            const entries: Iterable<[unknown, unknown]> =
                signersData instanceof Map
                    ? signersData.entries()
                    : Object.entries(signersData as Record<string, unknown>);

            for (const [index, key] of entries) {
                infos.push({
                    index: typeof index === 'string' ? parseInt(index, 10) : (index as number),
                    publicKey: bufferToHex(key as Uint8Array),
                });
            }

            return infos.sort((a, b) => a.index - b.index);

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── removeSigner ──────────────────────────────────────────────────────────

    removeSigner = async (
        signerKeypair: Keypair,
        signerIndex: number
    ): Promise<void> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(
                    walletContract.call(
                        'remove_signer',
                        nativeToScVal(signerIndex, { type: 'u32' })
                    )
                )
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, signerKeypair, this.config);

            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── setGuardian ───────────────────────────────────────────────────────────

    setGuardian = async (
        signerKeypair: Keypair,
        guardianAddress: string
    ): Promise<void> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(
                    walletContract.call(
                        'set_guardian',
                        nativeToScVal(guardianAddress, { type: 'address' })
                    )
                )
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();

            await this.authorizeEntries(sim as SorobanRpc.Api.SimulateTransactionSuccessResponse);

            const submissionTx = signForSubmission(assembled, signerKeypair, this.config);

            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── rotateSigner ──────────────────────────────────────────────────────────

    rotateSigner = async (
        signerKeypair: Keypair,
        username?: string,
        options?: RegisterOptions
    ): Promise<RotateSignerResult> => {
        const { rpcUrl, networkPassphrase } = this.config;
        const store = this.store;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            // The key currently registered on-chain — read before we touch storage.
            const oldPublicKeyHex = await store.getItem('invisible_wallet_public_key');
            if (!oldPublicKeyHex) {
                throw new Error('No existing public key found. Call register() or login() first.');
            }
            const oldPublicKeyBytes = hexToUint8Array(oldPublicKeyHex);

            // 1. Register a brand-new WebAuthn credential for the new device.
            //    Deliberately omits excludeCredentials: rotation's entire purpose
            //    is to enrol a replacement credential for this wallet.
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const normalizedUsername = username ? username.normalize('NFC') : undefined;
            const name   = normalizedUsername || 'Veil User';
            const userId = await resolveUserId(store);
            const resolvedRpId = this.resolveRpId();

            const {
                credentialId: newCredentialId,
                publicKeyBytes: newPublicKeyBytes,
                attestationObject,
                clientDataJSON,
                authenticatorAttachment,
                transports,
            } = await webAuthnProvider.create({
                challenge,
                rpId:     resolvedRpId,
                rpName:   'Invisible Wallet',
                userId,
                userName: name,
                authenticatorAttachment: options?.authenticatorAttachment,
            });

            if (newPublicKeyBytes.length !== 65) {
                throw new Error('New credential did not yield a 65-byte uncompressed P-256 key');
            }

            // Optional attestation verification for the new credential — mirrors register().
            if (this.config.attestationPolicy) {
                if (attestationObject && clientDataJSON) {
                    await verifyAttestation({
                        attestationObject,
                        clientDataJSON,
                        policy: this.config.attestationPolicy,
                    });
                } else if (this.config.requireAttestation) {
                    throw new AttestationError(
                        'Attestation required but the platform did not expose an attestationObject.'
                    );
                }
            }

            // 2. Build the rotate_signer(old, new) call against the wallet contract.
            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(
                    walletContract.call(
                        'rotate_signer',
                        nativeToScVal(oldPublicKeyBytes, { type: 'bytes' }),
                        nativeToScVal(newPublicKeyBytes, { type: 'bytes' })
                    )
                )
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();

            // 3. Authorize the rotation with the CURRENT passkey. signAuthEntry reads
            //    the still-current credential from storage, so this must run before we
            //    persist the new credential below.
            await this.authorizeEntries(sim as SorobanRpc.Api.SimulateTransactionSuccessResponse);

            const submissionTx = signForSubmission(assembled, signerKeypair, this.config);

            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

            // 4. Rotation confirmed on-chain — the new credential is now the active
            //    signer. Persist it; the wallet address is intentionally untouched.
            const newPublicKeyHex = bufferToHex(newPublicKeyBytes);
            await store.setItem('invisible_wallet_public_key', newPublicKeyHex);
            await store.setItem('invisible_wallet_key_id',     newCredentialId);

            const resolvedAttachment = authenticatorAttachment ?? options?.authenticatorAttachment;
            if (resolvedAttachment === 'cross-platform') {
                const portable: PortableSigner = {
                    credentialId: newCredentialId,
                    publicKey: newPublicKeyHex,
                    authenticatorAttachment: 'cross-platform',
                    transports: transports ?? [],
                };
                await store.setItem(PORTABLE_SIGNER_KEY, JSON.stringify(portable));
            } else if (store.removeItem) {
                await store.removeItem(PORTABLE_SIGNER_KEY);
            }

            return { oldPublicKeyBytes, newPublicKeyBytes, walletAddress: address };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── initiateRecovery ──────────────────────────────────────────────────────

    initiateRecovery = async (
        guardianKeypair: Keypair,
        newPublicKeyBytes: Uint8Array
    ): Promise<InitiateRecoveryResult> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();
            if (newPublicKeyBytes.length !== 65) {
                throw new Error('newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)');
            }

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(guardianKeypair.publicKey());

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(
                    walletContract.call(
                        'initiate_recovery',
                        nativeToScVal(newPublicKeyBytes, { type: 'bytes' })
                    )
                )
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                const errMsg = sim.error ?? '';
                if (errMsg.includes('NoGuardianSet') || errMsg.includes('no guardian')) {
                    throw new NoGuardianSet();
                }
                throw new Error(`Simulation failed: ${errMsg}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, guardianKeypair, this.config);

            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

            let unlockTime = 0;
            if ('returnValue' in txResult && txResult.returnValue) {
                try {
                    unlockTime = Number(scValToNative(txResult.returnValue));
                } catch {
                    // Default to 0 if parsing fails
                }
            }

            return { unlockTime };

        } catch (err: unknown) {
            if (err instanceof NoGuardianSet) throw err;
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── completeRecovery ──────────────────────────────────────────────────────

    completeRecovery = async (payerKeypair: Keypair): Promise<void> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(payerKeypair.publicKey());

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call('complete_recovery'))
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                const errMsg = sim.error ?? '';
                if (errMsg.includes('TimelockActive') || errMsg.includes('timelock')) {
                    const match = errMsg.match(/(\d{10,})/);
                    const unlockTime = match ? Number(match[1]) : 0;
                    throw new RecoveryTimelockActive(unlockTime);
                }
                if (errMsg.includes('NoGuardianSet') || errMsg.includes('no guardian')) {
                    throw new NoGuardianSet();
                }
                if (errMsg.includes('NotPending') || errMsg.includes('not pending')) {
                    throw new RecoveryNotPending();
                }
                throw new Error(`Simulation failed: ${errMsg}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, payerKeypair, this.config);

            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

        } catch (err: unknown) {
            if (
                err instanceof RecoveryTimelockActive ||
                err instanceof NoGuardianSet ||
                err instanceof RecoveryNotPending
            ) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── getBalance ────────────────────────────────────────────────────────────

    getBalance = async (token?: string): Promise<{ address: string; amount: bigint; assetCode: string }> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const server = new SorobanRpc.Server(rpcUrl);
            const contractAddress = token ?? Asset.native().contractId(networkPassphrase);
            const tokenContract = new Contract(contractAddress);

            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(tokenContract.call(
                    'balance',
                    nativeToScVal(address, { type: 'address' })
                ))
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
            if (!result || result.retval === undefined) throw new Error('Simulation returned no result');

            const amount = scValToNative(result.retval) as bigint;
            return {
                address,
                amount,
                assetCode: token ? token : 'XLM',
            };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── sendPayment ───────────────────────────────────────────────────────────

    sendPayment = async (
        signerKeypair: Keypair | string,
        to: string,
        amount: number | bigint,
        token?: string,
        memo?: string,
    ): Promise<{ transactionHash: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const payerKeypair = typeof signerKeypair === 'string'
                ? Keypair.fromSecret(signerKeypair)
                : signerKeypair;

            const contractAddress = token ?? Asset.native().contractId(networkPassphrase);
            const tokenContract = new Contract(contractAddress);
            const amountValue = typeof amount === 'bigint'
                ? amount
                : BigInt(Math.round(amount));

            const server = new SorobanRpc.Server(rpcUrl);
            const sourceAccount = await server.getAccount(payerKeypair.publicKey());
            const txBuilder = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(tokenContract.call(
                    'transfer',
                    nativeToScVal(address, { type: 'address' }),
                    nativeToScVal(to, { type: 'address' }),
                    nativeToScVal(amountValue, { type: 'i128' }),
                ));

            if (memo !== undefined) {
                txBuilder.addMemo({ type: 'text', value: String(memo) } as any);
            }

            const tx = txBuilder.setTimeout(30).build();
            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();

            await this.authorizeEntries(sim as SorobanRpc.Api.SimulateTransactionSuccessResponse);

            const submissionTx = signForSubmission(assembled, payerKeypair, this.config);
            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

            return { transactionHash: sendResult.hash, status: 'SUCCESS' };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── getAllowance ──────────────────────────────────────────────────────────

    getAllowance = async (spender: string, token: string): Promise<{ amount: number; expiry: number | undefined } | null> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);

            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(walletContract.call(
                    'get_allowance',
                    nativeToScVal(spender, { type: 'address' }),
                    nativeToScVal(token, { type: 'address' })
                ))
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result;
            if (!result || !result.retval) throw new Error('Simulation returned no result');

            if (result.retval.switch() === xdr.ScValType.scvVoid()) {
                return null;
            }

            const allowanceMap = scValToNative(result.retval);
            return {
                amount: Number(allowanceMap.amount),
                expiry: allowanceMap.expiry !== undefined ? Number(allowanceMap.expiry) : undefined,
            };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── approve ───────────────────────────────────────────────────────────────

    approve = async (
        signerKeypair: Keypair,
        spender: string,
        token: string,
        amount: number,
        expiry?: number
    ): Promise<void> => {
        const { rpcUrl, networkPassphrase } = this.config;

        this.setIsPending(true);
        this.setError(null);
        try {
            const address = this.requireAddress();

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());

            let expiryVal: xdr.ScVal;
            if (expiry !== undefined) {
                expiryVal = nativeToScVal([nativeToScVal(BigInt(expiry), { type: 'u64' })], { type: 'Vec' });
            } else {
                expiryVal = xdr.ScVal.scvVoid();
            }

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(
                    walletContract.call(
                        'approve',
                        nativeToScVal(spender, { type: 'address' }),
                        nativeToScVal(token, { type: 'address' }),
                        nativeToScVal(BigInt(amount), { type: 'i128' }),
                        expiryVal
                    )
                )
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();

            await this.authorizeEntries(sim as SorobanRpc.Api.SimulateTransactionSuccessResponse);

            const submissionTx = signForSubmission(assembled, signerKeypair, this.config);

            const sendResult = await server.sendTransaction(submissionTx);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setIsPending(false);
        }
    };

    // ── Offline outbox ────────────────────────────────────────────────────────

    replayOutbox = async (opts?: ReplayOptions): Promise<ReplayResult> => {
        const server = new SorobanRpc.Server(this.config.rpcUrl);
        return this.outbox.replay(server, opts);
    };

    // ── Local PRF-derived encryption ──────────────────────────────────────────
    // Lazily derive (and cache) a passkey-bound cipher for the registered
    // credential, falling back to a stored random key when PRF is unsupported.

    private async getCipher(): Promise<LocalCipher> {
        if (this.cipher) return this.cipher;
        const credentialId = await this.store.getItem('invisible_wallet_key_id');
        if (!credentialId) throw new Error('No passkey credential found. Please register first.');
        this.cipher = await createLocalCipher({ credentialId, rpId: this.config.rpId, storage: this.store });
        return this.cipher;
    }

    encryptLocal = async (plaintext: string | Uint8Array): Promise<string> => {
        const cipher = await this.getCipher();
        return cipher.encrypt(plaintext);
    };

    decryptLocal = async (payload: string): Promise<string> => {
        const cipher = await this.getCipher();
        return cipher.decryptString(payload);
    };

    encryptionMode = async (): Promise<'prf' | 'fallback'> => {
        const cipher = await this.getCipher();
        return cipher.mode;
    };
}

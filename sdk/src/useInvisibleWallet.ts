import { useState, useEffect, useCallback, useMemo } from 'react';
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

/** Result returned by a successful register() call. */
export type RegisterResult = {
    /** The deterministically computed contract address of the new wallet ("C..."). */
    walletAddress: string;
    /** The uncompressed P-256 public key bytes (65 bytes). */
    publicKeyBytes: Uint8Array;
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


export type InvisibleWallet = {
    /** Soroban contract address of the deployed wallet, or null if not yet registered. */
    address: string | null;
    /** True if the wallet contract has been confirmed to exist on-chain. */
    isDeployed: boolean;
    isPending: boolean;
    error: string | null;
    /** Create a new passkey credential and compute the deterministic wallet address. */
    register: (username?: string) => Promise<RegisterResult>;
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
    /**
     * Restore an existing wallet session from storage.
     * Verifies that the wallet contract actually exists on-chain before setting the address.
     */
    login: () => Promise<{ walletAddress: string } | null>;
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
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 1_000;
const POLL_MAX_ATTEMPTS = 30;

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

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useInvisibleWallet(config: WalletConfig): InvisibleWallet {
    const { factoryAddress, rpcUrl, networkPassphrase, rpId, origin } = config;

    const [address, setAddress] = useState<string | null>(null);
    const [isDeployed, setIsDeployed] = useState(false);
    const [isPending, setIsPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const store = useMemo(() => resolveStorage(config.storage), [config.storage]);
    const outbox = useMemo(() => new TransactionOutbox(store), [store]);

    // ── replayOutbox ────────────────────────────────────────────────────────
    // Resubmit any transactions persisted in the offline outbox. Deduped by
    // hash so repeated calls (and the reconnect listener below) are safe.
    const replayOutbox = useCallback(async (opts?: ReplayOptions): Promise<ReplayResult> => {
        const server = new SorobanRpc.Server(rpcUrl);
        return outbox.replay(server, opts);
    }, [rpcUrl, outbox]);

    // Auto-replay when connectivity returns. No-op outside the browser.
    useEffect(() => {
        if (config.autoReplayOnReconnect === false) return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        const onOnline = () => { void replayOutbox().catch(() => { /* surfaced via per-entry status */ }); };
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    }, [config.autoReplayOnReconnect, replayOutbox]);

    useEffect(() => {
        // Support both synchronous (localStorage) and asynchronous (AsyncStorage) adapters.
        // The synchronous branch keeps the existing test behaviour unchanged.
        const maybeStored = store.getItem('invisible_wallet_address');
        if (maybeStored && typeof (maybeStored as Promise<unknown>).then === 'function') {
            (maybeStored as Promise<string | null>).then((v) => { if (v) setAddress(v); });
        } else {
            const stored = maybeStored as string | null;
            if (stored) setAddress(stored);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── register ──────────────────────────────────────────────────────────────

    const register = useCallback(async (username?: string): Promise<RegisterResult> => {
        setIsPending(true);
        setError(null);
        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const name      = username || 'Veil User';
            const userId    = username
                ? new TextEncoder().encode(username)
                : crypto.getRandomValues(new Uint8Array(16));

            const resolvedRpId = rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');

            const { credentialId, publicKeyBytes, attestationObject, clientDataJSON } = await webAuthnProvider.create({
                challenge,
                rpId:     resolvedRpId,
                rpName:   'Invisible Wallet',
                userId,
                userName: name,
            });

            // Optional attestation verification — enforce authenticator policy.
            if (config.attestationPolicy) {
                if (attestationObject && clientDataJSON) {
                    await verifyAttestation({
                        attestationObject,
                        clientDataJSON,
                        policy: config.attestationPolicy,
                    });
                } else if (config.requireAttestation) {
                    throw new AttestationError(
                        'Attestation required but the platform did not expose an attestationObject.'
                    );
                }
            }

            const publicKeyHex  = bufferToHex(publicKeyBytes);
            const walletAddress = computeWalletAddress(factoryAddress, publicKeyBytes, networkPassphrase);

            await store.setItem('invisible_wallet_address',    walletAddress);
            await store.setItem('invisible_wallet_key_id',     credentialId);
            await store.setItem('invisible_wallet_public_key', publicKeyHex);
            setAddress(walletAddress);
            setIsDeployed(false);

            return { walletAddress, publicKeyBytes };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [factoryAddress, networkPassphrase, rpId, store, config.attestationPolicy, config.requireAttestation]);

    // ── deploy ────────────────────────────────────────────────────────────────

    const deploy = useCallback(async (
        signerSecret: string | Keypair,
        publicKeyBytes?: Uint8Array
    ): Promise<DeployResult> => {
        const signerKeypair = typeof signerSecret === 'string'
            ? Keypair.fromSecret(signerSecret)
            : Keypair.fromSecret(signerSecret.secret());
        setIsPending(true);
        setError(null);
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

            const resolvedRpId  = rpId    ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');
            const resolvedOrigin = origin ?? (typeof window !== 'undefined' ? window.location.origin  : `https://${resolvedRpId}`);

            const rpIdBytes   = new TextEncoder().encode(resolvedRpId);
            const originBytes = new TextEncoder().encode(resolvedOrigin);

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
            })
                .addOperation(
                    factory.call(
                        'deploy',
                        nativeToScVal(pubKeyBytes,  { type: 'bytes' }),
                        nativeToScVal(rpIdBytes,    { type: 'bytes' }),
                        nativeToScVal(originBytes,  { type: 'bytes' }),
                    )
                )
                .setTimeout(30)
                .build();

            const sim = await server.simulateTransaction(tx);
            if (SorobanRpc.Api.isSimulationError(sim)) {
                throw new Error(`Simulation failed: ${sim.error}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            assembled.sign(signerKeypair);

            const sendResult = await server.sendTransaction(assembled);
            if (sendResult.status === 'ERROR') {
                throw new Error(
                    `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`
                );
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

            setAddress(walletAddress);
            setIsDeployed(true);
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
                setAddress(walletAddress!);
                setIsDeployed(true);
                await store.setItem('invisible_wallet_address', walletAddress!);
                return { walletAddress: walletAddress!, alreadyDeployed: true };
            }
            setError(message);
            throw new Error(message);
        } finally {
            setIsPending(false);
        }
    }, [factoryAddress, rpcUrl, networkPassphrase, rpId, origin, store]);

    // ── login ─────────────────────────────────────────────────────────────────

    const login = useCallback(async () => {
        setIsPending(true);
        setError(null);
        try {
            const stored = await store.getItem('invisible_wallet_address');
            if (!stored) {
                setError('No wallet found. Please register first.');
                return null;
            }

            const server = new SorobanRpc.Server(rpcUrl);

            try {
                await server.getContractData(
                    stored,
                    xdr.ScVal.scvLedgerKeyContractInstance(),
                    SorobanRpc.Durability.Persistent
                );
                setAddress(stored);
                setIsDeployed(true);
                return { walletAddress: stored };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.toLowerCase().includes('not found')) {
                    setError('Wallet not yet deployed. Call deploy() to create it on-chain.');
                    setAddress(null);
                    setIsDeployed(false);
                    return null;
                } else {
                    throw e;
                }
            }
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
            return null;
        } finally {
            setIsPending(false);
        }
    }, [rpcUrl, store]);

    // ── signAuthEntry ─────────────────────────────────────────────────────────

    const signAuthEntry = useCallback(async (
        signaturePayload: Uint8Array
    ): Promise<WebAuthnSignature | null> => {
        setIsPending(true);
        setError(null);
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

            const { authData, clientDataJSON, signature } = await webAuthnProvider.authenticate({
                challenge,
                credentialId: keyId,
                rpId,
            });

            const publicKeyBytes = hexToUint8Array(publicKeyHex);

            return { publicKey: publicKeyBytes, authData, clientDataJSON, signature };

        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [rpId, store]);

    // ── getNonce ──────────────────────────────────────────────────────────────

    const getNonce = useCallback(async (): Promise<bigint> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);

    // ── addSigner ─────────────────────────────────────────────────────────────

    const addSigner = useCallback(async (
        signerKeypair: Keypair,
        newPublicKeyBytes: Uint8Array
    ): Promise<AddSignerResult> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');
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
            assembled.sign(signerKeypair);

            const sendResult = await server.sendTransaction(assembled);
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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);

    // ── getSigners ────────────────────────────────────────────────────────────

    const getSigners = useCallback(async (): Promise<SignerInfo[]> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);

    // ── removeSigner ──────────────────────────────────────────────────────────

    const removeSigner = useCallback(async (
        signerKeypair: Keypair,
        signerIndex: number
    ): Promise<void> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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
            assembled.sign(signerKeypair);

            const sendResult = await server.sendTransaction(assembled);
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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);

    // ── setGuardian ───────────────────────────────────────────────────────────

    const setGuardian = useCallback(async (
        signerKeypair: Keypair,
        guardianAddress: string
    ): Promise<void> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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

            const successSim = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse;
            const authEntries = successSim.result?.auth;
            if (authEntries) {
                // stellarHash is a synchronous SHA-256 — avoids crypto.subtle (unavailable on some RN setups)
                const networkIdBytes = new Uint8Array(
                    (stellarHash as (input: Buffer) => Buffer)(Buffer.from(networkPassphrase))
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

                    const webAuthnSig = await signAuthEntry(payloadHash);
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

            assembled.sign(signerKeypair);

            const sendResult = await server.sendTransaction(assembled);
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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase, signAuthEntry]);

    // ── initiateRecovery ──────────────────────────────────────────────────────

    const initiateRecovery = useCallback(async (
        guardianKeypair: Keypair,
        newPublicKeyBytes: Uint8Array
    ): Promise<InitiateRecoveryResult> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');
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
            assembled.sign(guardianKeypair);

            const sendResult = await server.sendTransaction(assembled);
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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);

    // ── completeRecovery ──────────────────────────────────────────────────────

    const completeRecovery = useCallback(async (payerKeypair: Keypair): Promise<void> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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
            assembled.sign(payerKeypair);

            const sendResult = await server.sendTransaction(assembled);
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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);

    // ── getBalance ──────────────────────────────────────────────────────────

    const getBalance = useCallback(async (token?: string): Promise<{ address: string; amount: bigint; assetCode: string }> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, networkPassphrase, rpcUrl]);

    // ── sendPayment ──────────────────────────────────────────────────────────

    const sendPayment = useCallback(async (
        signerKeypair: Keypair | string,
        to: string,
        amount: number | bigint,
        token?: string,
        memo?: string,
    ): Promise<{ transactionHash: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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
            const successSim = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse;
            const authEntries = successSim.result?.auth;

            if (authEntries) {
                const networkIdBytes = new Uint8Array(
                    (stellarHash as (input: Buffer) => Buffer)(Buffer.from(networkPassphrase))
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

                    const webAuthnSig = await signAuthEntry(payloadHash);
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

            assembled.sign(payerKeypair);
            const sendResult = await server.sendTransaction(assembled);
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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, networkPassphrase, rpcUrl, signAuthEntry]);

    // ── getAllowance ──────────────────────────────────────────────────────────

    const getAllowance = useCallback(async (spender: string, token: string): Promise<{ amount: number; expiry: number | undefined } | null> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase]);

    // ── approve ───────────────────────────────────────────────────────────────

    const approve = useCallback(async (
        signerKeypair: Keypair,
        spender: string,
        token: string,
        amount: number,
        expiry?: number
    ): Promise<void> => {
        setIsPending(true);
        setError(null);
        try {
            if (!address) throw new Error('No wallet address. Call register() or login() first.');

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

            const successSim = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse;
            const authEntries = successSim.result?.auth;
            if (authEntries) {
                const networkIdBytes = new Uint8Array(
                    (stellarHash as (input: Buffer) => Buffer)(Buffer.from(networkPassphrase))
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

                    const webAuthnSig = await signAuthEntry(payloadHash);
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

            assembled.sign(signerKeypair);

            const sendResult = await server.sendTransaction(assembled);
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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    }, [address, rpcUrl, networkPassphrase, signAuthEntry]);

    return useMemo(() => (
        { address, isDeployed, isPending, error, register, deploy, signAuthEntry, login, getNonce, addSigner, removeSigner, getSigners, setGuardian, initiateRecovery, completeRecovery, approve, getAllowance, getBalance, sendPayment, outbox, replayOutbox }
    ), [address, isDeployed, isPending, error, register, deploy, signAuthEntry, login, getNonce, addSigner, removeSigner, getSigners, setGuardian, initiateRecovery, completeRecovery, approve, getAllowance, getBalance, sendPayment, outbox, replayOutbox]);
}

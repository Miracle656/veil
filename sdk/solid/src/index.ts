import { createSignal, createEffect, onMount } from 'solid-js';
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

import { bufferToHex, hexToUint8Array, computeWalletAddress } from '../../src/utils';
import { webAuthnProvider } from '../../src/webauthn';
import { TransactionOutbox } from '../../src/outbox';
import { verifyAttestation, AttestationError } from '../../src/webauthn/attestation';
import { createLocalCipher } from '../../src/crypto/prf';
import { deriveCounterfactualAddress as _deriveCounterfactualAddress } from '../../src/counterfactual';

import type {
    WalletConfig,
    WebAuthnSignature,
    RegisterOptions,
    PortableSigner,
    RegisterResult,
    DeployResult,
    AddSignerResult,
    SignerInfo,
    InitiateRecoveryResult,
} from '../../src/useInvisibleWallet';
import type { ReplayOptions, ReplayResult } from '../../src/outbox';
import type { AttestationPolicy } from '../../src/webauthn/attestation';
import type { LocalCipher } from '../../src/crypto/prf';
import type { CounterfactualAddress } from '../../src/counterfactual';

export {
    RecoveryTimelockActive,
    NoGuardianSet,
    RecoveryNotPending,
} from '../../src/useInvisibleWallet';

export type {
    WalletConfig,
    WebAuthnSignature,
    RegisterOptions,
    PortableSigner,
    RegisterResult,
    DeployResult,
    AddSignerResult,
    SignerInfo,
    InitiateRecoveryResult,
};

export type SolidInvisibleWallet = {
    address: () => string | null;
    isDeployed: () => boolean;
    isPending: () => boolean;
    error: () => string | null;
    register: (username?: string, options?: RegisterOptions) => Promise<RegisterResult>;
    deploy: (signerKeypair: Keypair | string, publicKeyBytes?: Uint8Array) => Promise<DeployResult>;
    signAuthEntry: (signaturePayload: Uint8Array) => Promise<WebAuthnSignature | null>;
    deriveCounterfactualAddress: (publicKeyBytes: Uint8Array) => CounterfactualAddress;
    getPortableSigner: () => Promise<PortableSigner | null>;
    login: () => Promise<{ walletAddress: string } | null>;
    getNonce: () => Promise<bigint>;
    addSigner: (signerKeypair: Keypair, newPublicKeyBytes: Uint8Array) => Promise<AddSignerResult>;
    removeSigner: (signerKeypair: Keypair, signerIndex: number) => Promise<void>;
    getSigners: () => Promise<SignerInfo[]>;
    setGuardian: (signerKeypair: Keypair, guardianAddress: string) => Promise<void>;
    initiateRecovery: (guardianKeypair: Keypair, newPublicKeyBytes: Uint8Array) => Promise<InitiateRecoveryResult>;
    completeRecovery: (payerKeypair: Keypair) => Promise<void>;
    approve: (signerKeypair: Keypair, spender: string, token: string, amount: number, expiry?: number) => Promise<void>;
    getBalance: (token?: string) => Promise<{ address: string; amount: bigint; assetCode: string }>;
    sendPayment: (
        signerKeypair: Keypair | string,
        to: string,
        amount: number | bigint,
        token?: string,
        memo?: string,
    ) => Promise<{ transactionHash: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }>;
    getAllowance: (spender: string, token: string) => Promise<{ amount: number; expiry: number | undefined } | null>;
    outbox: TransactionOutbox;
    replayOutbox: (opts?: ReplayOptions) => Promise<ReplayResult>;
    encryptLocal: (plaintext: string | Uint8Array) => Promise<string>;
    decryptLocal: (payload: string) => Promise<string>;
    encryptionMode: () => Promise<'prf' | 'fallback'>;
};

const POLL_INTERVAL_MS  = 1_000;
const POLL_MAX_ATTEMPTS = 30;

const PORTABLE_SIGNER_KEY = 'invisible_wallet_portable_signer';

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

function resolveStorage(storage?: any): any {
    if (storage) return storage;
    if (typeof localStorage !== 'undefined') {
        return {
            getItem:    (k: string) => localStorage.getItem(k),
            setItem:    (k: string, v: string) => localStorage.setItem(k, v),
            removeItem: (k: string) => localStorage.removeItem(k),
        };
    }
    return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

async function readPortableSigner(store: any): Promise<PortableSigner | null> {
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

export function useInvisibleWallet(config: WalletConfig): SolidInvisibleWallet {
    const { factoryAddress, rpcUrl, networkPassphrase, rpId, origin } = config;

    const [address, setAddress] = createSignal<string | null>(null);
    const [isDeployed, setIsDeployed] = createSignal(false);
    const [isPending, setIsPending] = createSignal(false);
    const [error, setError] = createSignal<string | null>(null);

    const store = resolveStorage(config.storage);
    const outbox = new TransactionOutbox(store);

    let cipherRef: LocalCipher | null = null;

    const replayOutbox = async (opts?: ReplayOptions): Promise<ReplayResult> => {
        const server = new SorobanRpc.Server(rpcUrl);
        return outbox.replay(server, opts);
    };

    createEffect(() => {
        if (config.autoReplayOnReconnect === false) return;
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
        const onOnline = () => { void replayOutbox().catch(() => {}); };
        window.addEventListener('online', onOnline);
        return () => window.removeEventListener('online', onOnline);
    });

    onMount(() => {
        const maybeStored = store.getItem('invisible_wallet_address');
        if (maybeStored && typeof (maybeStored as Promise<unknown>).then === 'function') {
            (maybeStored as Promise<string | null>).then((v) => { if (v) setAddress(v); });
        } else {
            const stored = maybeStored as string | null;
            if (stored) setAddress(stored);
        }
    });

    const register = async (username?: string, options?: RegisterOptions): Promise<RegisterResult> => {
        setIsPending(true);
        setError(null);
        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const normalizedUsername = username ? username.normalize('NFC') : undefined;
            const name      = normalizedUsername || 'Veil User';
            const userId    = normalizedUsername
                ? new TextEncoder().encode(normalizedUsername)
                : crypto.getRandomValues(new Uint8Array(16));

            const resolvedRpId = rpId ?? (typeof window !== 'undefined' ? window.location.hostname : 'localhost');

            const { credentialId, publicKeyBytes, attestationObject, clientDataJSON, authenticatorAttachment, transports } = await webAuthnProvider.create({
                challenge,
                rpId:     resolvedRpId,
                rpName:   'Invisible Wallet',
                userId,
                userName: name,
                authenticatorAttachment: options?.authenticatorAttachment,
            });

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

            const resolvedAttachment = authenticatorAttachment ?? options?.authenticatorAttachment;
            const isPortableSigner = resolvedAttachment === 'cross-platform';

            await store.setItem('invisible_wallet_address',    walletAddress);
            await store.setItem('invisible_wallet_key_id',     credentialId);
            await store.setItem('invisible_wallet_public_key', publicKeyHex);

            if (isPortableSigner) {
                const portable: PortableSigner = {
                    credentialId,
                    publicKey: publicKeyHex,
                    authenticatorAttachment: 'cross-platform',
                    transports: transports ?? [],
                };
                await store.setItem(PORTABLE_SIGNER_KEY, JSON.stringify(portable));
            } else if (store.removeItem) {
                await store.removeItem(PORTABLE_SIGNER_KEY);
            }

            setAddress(walletAddress);
            setIsDeployed(false);

            return { walletAddress, publicKeyBytes, authenticatorAttachment: resolvedAttachment, isPortableSigner };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    const deriveCounterfactualAddress = (publicKeyBytes: Uint8Array) => {
        return _deriveCounterfactualAddress(publicKeyBytes, { factoryAddress, networkPassphrase });
    };

    const getPortableSigner = async (): Promise<PortableSigner | null> => {
        return readPortableSigner(store);
    };

    const deploy = async (
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

            const txBuilder = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
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
            const submissionTx = signForSubmission(assembled, signerKeypair, config);

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
    };

    const login = async () => {
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
    };

    const signAuthEntry = async (
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
            setError(err instanceof Error ? err.message : String(err));
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    const getNonce = async (): Promise<bigint> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);

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
    };

    const addSigner = async (
        signerKeypair: Keypair,
        newPublicKeyBytes: Uint8Array
    ): Promise<AddSignerResult> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');
            if (newPublicKeyBytes.length !== 65) {
                throw new Error('newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)');
            }

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);
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
            const submissionTx = signForSubmission(assembled, signerKeypair, config);

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
    };

    const getSigners = async (): Promise<SignerInfo[]> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);

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
    };

    const removeSigner = async (
        signerKeypair: Keypair,
        signerIndex: number
    ): Promise<void> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);
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
            const submissionTx = signForSubmission(assembled, signerKeypair, config);

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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    const setGuardian = async (
        signerKeypair: Keypair,
        guardianAddress: string
    ): Promise<void> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);
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

            const submissionTx = signForSubmission(assembled, signerKeypair, config);

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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    const initiateRecovery = async (
        guardianKeypair: Keypair,
        newPublicKeyBytes: Uint8Array
    ): Promise<InitiateRecoveryResult> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');
            if (newPublicKeyBytes.length !== 65) {
                throw new Error('newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)');
            }

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);
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
                    throw new Error('NoGuardianSet');
                }
                throw new Error(`Simulation failed: ${errMsg}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, guardianKeypair, config);

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
                }
            }

            return { unlockTime };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    const completeRecovery = async (payerKeypair: Keypair): Promise<void> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);
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
                    throw new Error(`RecoveryTimelockActive: ${unlockTime}`);
                }
                if (errMsg.includes('NoGuardianSet') || errMsg.includes('no guardian')) {
                    throw new Error('NoGuardianSet');
                }
                if (errMsg.includes('NotPending') || errMsg.includes('not pending')) {
                    throw new Error('RecoveryNotPending');
                }
                throw new Error(`Simulation failed: ${errMsg}`);
            }

            const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
            const submissionTx = signForSubmission(assembled, payerKeypair, config);

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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    const getBalance = async (token?: string): Promise<{ address: string; amount: bigint; assetCode: string }> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

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
                    nativeToScVal(currentAddress, { type: 'address' })
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
                address: currentAddress,
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
    };

    const sendPayment = async (
        signerKeypair: Keypair | string,
        to: string,
        amount: number | bigint,
        token?: string,
        memo?: string,
    ): Promise<{ transactionHash: string; status: 'PENDING' | 'SUCCESS' | 'FAILED' }> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

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
                    nativeToScVal(currentAddress, { type: 'address' }),
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

            const submissionTx = signForSubmission(assembled, payerKeypair, config);
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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    const getAllowance = async (spender: string, token: string): Promise<{ amount: number; expiry: number | undefined } | null> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);

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
    };

    const approve = async (
        signerKeypair: Keypair,
        spender: string,
        token: string,
        amount: number,
        expiry?: number
    ): Promise<void> => {
        setIsPending(true);
        setError(null);
        try {
            const currentAddress = address();
            if (!currentAddress) throw new Error('No wallet address. Call register() or login() first.');

            const server = new SorobanRpc.Server(rpcUrl);
            const walletContract = new Contract(currentAddress);
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

            const submissionTx = signForSubmission(assembled, signerKeypair, config);

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
            setError(message);
            throw err;
        } finally {
            setIsPending(false);
        }
    };

    const getCipher = async (): Promise<LocalCipher> => {
        if (cipherRef) return cipherRef;
        const credentialId = await store.getItem('invisible_wallet_key_id');
        if (!credentialId) throw new Error('No passkey credential found. Please register first.');
        const cipher = await createLocalCipher({ credentialId, rpId, storage: store });
        cipherRef = cipher;
        return cipher;
    };

    const encryptLocal = async (plaintext: string | Uint8Array): Promise<string> => {
        const cipher = await getCipher();
        return cipher.encrypt(plaintext);
    };

    const decryptLocal = async (payload: string): Promise<string> => {
        const cipher = await getCipher();
        return cipher.decryptString(payload);
    };

    const encryptionMode = async (): Promise<'prf' | 'fallback'> => {
        const cipher = await getCipher();
        return cipher.mode;
    };

    return {
        address,
        isDeployed,
        isPending,
        error,
        register,
        deploy,
        signAuthEntry,
        deriveCounterfactualAddress,
        getPortableSigner,
        login,
        getNonce,
        addSigner,
        removeSigner,
        getSigners,
        setGuardian,
        initiateRecovery,
        completeRecovery,
        approve,
        getAllowance,
        getBalance,
        sendPayment,
        outbox,
        replayOutbox,
        encryptLocal,
        decryptLocal,
        encryptionMode,
    };
}

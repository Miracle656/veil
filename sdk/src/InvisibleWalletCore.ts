import {
    Account,
    Contract,
    Keypair,
    rpc as SorobanRpc,
    Horizon,
    StrKey,
    TransactionBuilder,
    BASE_FEE,
    xdr,
    nativeToScVal,
    scValToNative,
    Networks,
} from '@stellar/stellar-sdk';

const HorizonServer = Horizon.Server;
import {
    bufferToHex,
    hexToUint8Array,
    derToRawSignature,
    extractP256PublicKey,
    computeWalletAddress,
} from './utils';

// ── Types ─────────────────────────────────────────────────────────────────────

export type WalletConfig = {
    /** The factory contract's Stellar strkey (e.g. "CABC..."). */
    factoryAddress: string;
    /** Stellar Horizon-compatible RPC endpoint (e.g. "https://soroban-testnet.stellar.org"). */
    rpcUrl: string;
    /** Stellar network passphrase. Use Networks.TESTNET or Networks.PUBLIC. */
    networkPassphrase: string;
    /** The WebAuthn relying party ID (e.g. "localhost"). Optional — defaults to window.location.hostname. */
    rpId?: string;
    /** The WebAuthn origin (e.g. "https://veil.app"). Optional — defaults to window.location.origin. */
    origin?: string;
};

export type WebAuthnSignature = {
    publicKey: Uint8Array;
    authData: Uint8Array;
    clientDataJSON: Uint8Array;
    signature: Uint8Array;
};

export type RegisterResult = {
    walletAddress: string;
    publicKeyBytes: Uint8Array;
};

export type DeployResult = {
    walletAddress: string;
    alreadyDeployed: boolean;
};

export type AddSignerResult = {
    signerIndex: number;
};

export type SignerInfo = {
    index: number;
    publicKey: string;
};

export type InitiateRecoveryResult = {
    unlockTime: number;
};

export interface WalletState {
    address: string | null;
    isDeployed: boolean;
    isPending: boolean;
    error: string | null;
}

// ── Recovery Errors ───────────────────────────────────────────────────────────

export class RecoveryTimelockActive extends Error {
    constructor(public readonly unlockTime: number) {
        super(`Recovery timelock active until ${unlockTime}`);
        this.name = 'RecoveryTimelockActive';
    }
}

export class NoGuardianSet extends Error {
    constructor() {
        super('No guardian set on this wallet');
        this.name = 'NoGuardianSet';
    }
}

export class RecoveryNotPending extends Error {
    constructor() {
        super('No recovery is currently pending');
        this.name = 'RecoveryNotPending';
    }
}

const POLL_INTERVAL_MS  = 1_000;
const POLL_MAX_ATTEMPTS = 30;

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

// ── Core Class ────────────────────────────────────────────────────────────────

export class InvisibleWalletCore {
    private state: WalletState = {
        address: null,
        isDeployed: false,
        isPending: false,
        error: null,
    };
    private listeners = new Set<(state: WalletState) => void>();
    private config: WalletConfig;

    constructor(config: WalletConfig | string) {
        if (typeof config === 'string') {
            this.config = {
                factoryAddress: config,
                rpcUrl: 'https://soroban-testnet.stellar.org',
                networkPassphrase: Networks.TESTNET,
            };
        } else {
            this.config = config;
        }

        if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
            const stored = localStorage.getItem('invisible_wallet_address');
            if (stored) {
                this.state.address = stored;
            }
        }
    }

    getState(): WalletState {
        return this.state;
    }

    private updateState(updates: Partial<WalletState>) {
        this.state = { ...this.state, ...updates };
        for (const listener of this.listeners) {
            try {
                listener(this.state);
            } catch (e) {
                console.error('Error in listener:', e);
            }
        }
    }

    subscribe(listener: (state: WalletState) => void): () => void {
        this.listeners.add(listener);
        listener(this.state);
        return () => {
            this.listeners.delete(listener);
        };
    }

    // ── register ──────────────────────────────────────────────────────────────

    async register(username?: string): Promise<RegisterResult> {
        const { factoryAddress, networkPassphrase } = this.config;
        this.updateState({ isPending: true, error: null });
        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const name = username || 'Veil User';
            const userId = username ? new TextEncoder().encode(username) : crypto.getRandomValues(new Uint8Array(16));

            if (typeof navigator === 'undefined' || !navigator.credentials) {
                throw new Error('WebAuthn is not supported in this environment');
            }

            const credential = await navigator.credentials.create({
                publicKey: {
                    challenge,
                    rp: { name: 'Invisible Wallet' },
                    user: {
                        id: userId,
                        name: name,
                        displayName: name,
                    },
                    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
                    timeout: 60_000,
                    authenticatorSelection: {
                        residentKey: 'preferred',
                        userVerification: 'required',
                    },
                },
            }) as PublicKeyCredential;

            if (!credential) throw new Error('Credential creation failed');

            const response = credential.response as AuthenticatorAttestationResponse;
            const publicKeyBytes = await extractP256PublicKey(response);
            const publicKeyHex = bufferToHex(publicKeyBytes);

            const walletAddress = computeWalletAddress(factoryAddress, publicKeyBytes, networkPassphrase);

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('invisible_wallet_address',    walletAddress);
                localStorage.setItem('invisible_wallet_key_id',     credential.id);
                localStorage.setItem('invisible_wallet_public_key', publicKeyHex);
            }
            
            this.updateState({ address: walletAddress, isDeployed: false });

            return { walletAddress, publicKeyBytes };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── deploy ────────────────────────────────────────────────────────────────

    async deploy(
        signerSecret: string | Keypair,
        publicKeyBytes?: Uint8Array
    ): Promise<DeployResult> {
        const { factoryAddress, rpcUrl, networkPassphrase, rpId, origin } = this.config;
        
        const signerKeypair = typeof signerSecret === 'string'
            ? Keypair.fromSecret(signerSecret)
            : Keypair.fromSecret(signerSecret.secret());
            
        this.updateState({ isPending: true, error: null });
        let walletAddress: string | undefined;
        try {
            let pubKeyBytes = publicKeyBytes;
            if (!pubKeyBytes) {
                const hex = typeof localStorage !== 'undefined' ? localStorage.getItem('invisible_wallet_public_key') : null;
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

            const defaultRpId = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
            const defaultOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';

            const rpIdBytes  = new TextEncoder().encode(rpId ?? defaultRpId);
            const originBytes = new TextEncoder().encode(origin ?? defaultOrigin);

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

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('invisible_wallet_address', walletAddress);
            }
            this.updateState({ address: walletAddress, isDeployed: true });
            return { walletAddress, alreadyDeployed: false };

        } catch (err: unknown) {
            let message: string;
            if (err instanceof Error) {
                message = err.message;
            } else {
                try { message = JSON.stringify(err); } catch { message = String(err); }
            }
            if (message.toLowerCase().includes('alreadydeployed') || message.toLowerCase().includes('already_deployed')) {
                if (typeof localStorage !== 'undefined') {
                    localStorage.setItem('invisible_wallet_address', walletAddress!);
                }
                this.updateState({ address: walletAddress!, isDeployed: true });
                return { walletAddress: walletAddress!, alreadyDeployed: true };
            }
            this.updateState({ error: message });
            throw new Error(message);
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── login ─────────────────────────────────────────────────────────────────

    async login(): Promise<{ walletAddress: string } | null> {
        const { rpcUrl } = this.config;
        this.updateState({ isPending: true, error: null });
        try {
            const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('invisible_wallet_address') : null;
            if (!stored) {
                this.updateState({ error: 'No wallet found. Please register first.' });
                return null;
            }

            const server = new SorobanRpc.Server(rpcUrl);

            try {
                await server.getContractData(
                    stored,
                    xdr.ScVal.scvLedgerKeyContractInstance(),
                    SorobanRpc.Durability.Persistent
                );
                this.updateState({ address: stored, isDeployed: true });
                return { walletAddress: stored };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                if (msg.toLowerCase().includes('not found')) {
                    this.updateState({ error: 'Wallet not yet deployed. Call deploy() to create it on-chain.', address: null, isDeployed: false });
                    return null;
                } else {
                    throw e;
                }
            }
        } catch (err: unknown) {
            this.updateState({ error: err instanceof Error ? err.message : String(err) });
            return null;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── signAuthEntry ─────────────────────────────────────────────────────────

    async signAuthEntry(
        signaturePayload: Uint8Array
    ): Promise<WebAuthnSignature | null> {
        this.updateState({ isPending: true, error: null });
        try {
            const keyId = typeof localStorage !== 'undefined' ? localStorage.getItem('invisible_wallet_key_id') : null;
            const publicKeyHex = typeof localStorage !== 'undefined' ? localStorage.getItem('invisible_wallet_public_key') : null;
            if (!keyId)        throw new Error('No key ID found. Please register first.');
            if (!publicKeyHex) throw new Error('No public key found. Please register first.');

            if (signaturePayload.length !== 32) {
                throw new Error('signaturePayload must be exactly 32 bytes');
            }

            const challenge = signaturePayload.buffer.slice(
                signaturePayload.byteOffset,
                signaturePayload.byteOffset + signaturePayload.byteLength
            ) as ArrayBuffer;

            const credIdBin = atob(keyId.replace(/-/g, '+').replace(/_/g, '/'));
            const credId = Uint8Array.from(credIdBin, c => c.charCodeAt(0));

            if (typeof navigator === 'undefined' || !navigator.credentials) {
                throw new Error('WebAuthn is not supported in this environment');
            }

            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge,
                    allowCredentials: [{ id: credId, type: 'public-key' }],
                    userVerification: 'required',
                },
            }) as PublicKeyCredential;

            if (!assertion) throw new Error('Signing was cancelled');

            const response = assertion.response as AuthenticatorAssertionResponse;
            const rawSignature = derToRawSignature(response.signature);
            const publicKeyBytes = hexToUint8Array(publicKeyHex);

            return {
                publicKey:      publicKeyBytes,
                authData:       new Uint8Array(response.authenticatorData),
                clientDataJSON: new Uint8Array(response.clientDataJSON),
                signature:      rawSignature,
            };

        } catch (err: unknown) {
            this.updateState({ error: err instanceof Error ? err.message : String(err) });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── getNonce ──────────────────────────────────────────────────────────────

    async getNonce(): Promise<bigint> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── addSigner ─────────────────────────────────────────────────────────────

    async addSigner(
        signerKeypair: Keypair,
        newPublicKeyBytes: Uint8Array
    ): Promise<AddSignerResult> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
                    // ignore
                }
            }

            return { signerIndex };

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── removeSigner ──────────────────────────────────────────────────────────

    async removeSigner(
        signerKeypair: Keypair,
        signerIndex: number
    ): Promise<void> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── getSigners ────────────────────────────────────────────────────────────

    async getSigners(): Promise<SignerInfo[]> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── setGuardian ───────────────────────────────────────────────────────────

    async setGuardian(
        signerKeypair: Keypair,
        guardianAddress: string
    ): Promise<void> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
                const networkIdBytes = new Uint8Array(
                    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(networkPassphrase))
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
                        await crypto.subtle.digest('SHA-256', new Uint8Array(preimage.toXDR()))
                    );

                    const webAuthnSig = await this.signAuthEntry(payloadHash);
                    if (!webAuthnSig) throw new Error('WebAuthn signing was cancelled');

                    const sigVec = xdr.ScVal.scvVec([
                        nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
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
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── initiateRecovery ──────────────────────────────────────────────────────

    async initiateRecovery(
        guardianKeypair: Keypair,
        newPublicKeyBytes: Uint8Array
    ): Promise<InitiateRecoveryResult> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
                    // ignore
                }
            }

            return { unlockTime };

        } catch (err: unknown) {
            if (err instanceof NoGuardianSet) throw err;
            const message = err instanceof Error ? err.message : String(err);
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── completeRecovery ──────────────────────────────────────────────────────

    async completeRecovery(payerKeypair: Keypair): Promise<void> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── getAllowance ──────────────────────────────────────────────────────────

    async getAllowance(spender: string, token: string): Promise<{ amount: number; expiry: number | undefined } | null> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }

    // ── approve ───────────────────────────────────────────────────────────────

    async approve(
        signerKeypair: Keypair,
        spender: string,
        token: string,
        amount: number,
        expiry?: number
    ): Promise<void> {
        const { networkPassphrase, rpcUrl } = this.config;
        const address = this.state.address;
        this.updateState({ isPending: true, error: null });
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
                    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(networkPassphrase))
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
                        await crypto.subtle.digest('SHA-256', new Uint8Array(preimage.toXDR()))
                    );

                    const webAuthnSig = await this.signAuthEntry(payloadHash);
                    if (!webAuthnSig) throw new Error('WebAuthn signing was cancelled');

                    const sigVec = xdr.ScVal.scvVec([
                        nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
                        nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
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
            this.updateState({ error: message });
            throw err;
        } finally {
            this.updateState({ isPending: false });
        }
    }
}

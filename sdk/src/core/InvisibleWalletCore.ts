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
} from '../utils';

// Types (same as before)
export type WalletConfig = {
    factoryAddress: string;
    rpcUrl: string;
    networkPassphrase: string;
    rpId?: string;
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

// Recovery Errors
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

// Polling helper
const POLL_INTERVAL_MS = 1_000;
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

// Core class - framework agnostic
export class InvisibleWalletCore {
    private config: WalletConfig;
    private address: string | null = null;
    private isDeployed: boolean = false;
    
    // Callbacks for state updates (to be used by React/Vue)
    private onStateChange?: (state: { address: string | null; isDeployed: boolean; isPending: boolean; error: string | null }) => void;
    private pendingCount: number = 0;
    private errorValue: string | null = null;

    constructor(config: WalletConfig, onStateChange?: (state: any) => void) {
        this.config = config;
        this.onStateChange = onStateChange;
        
        // Load stored address on initialization
        const stored = localStorage.getItem('invisible_wallet_address');
        if (stored) {
            this.address = stored;
            this.notifyStateChange();
        }
    }

    private setPending(isPending: boolean) {
        if (isPending) {
            this.pendingCount++;
        } else {
            this.pendingCount--;
        }
        this.notifyStateChange();
    }

    private setError(error: string | null) {
        this.errorValue = error;
        this.notifyStateChange();
    }

    private setAddress(address: string | null) {
        this.address = address;
        this.notifyStateChange();
    }

    private setIsDeployed(isDeployed: boolean) {
        this.isDeployed = isDeployed;
        this.notifyStateChange();
    }

    private notifyStateChange() {
        if (this.onStateChange) {
            this.onStateChange({
                address: this.address,
                isDeployed: this.isDeployed,
                isPending: this.pendingCount > 0,
                error: this.errorValue,
            });
        }
    }

    getAddress(): string | null {
        return this.address;
    }

    getIsDeployed(): boolean {
        return this.isDeployed;
    }

    async register(username?: string): Promise<RegisterResult> {
        this.setPending(true);
        this.setError(null);
        try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const name = username || 'Veil User';
            const userId = username ? new TextEncoder().encode(username) : crypto.getRandomValues(new Uint8Array(16));

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

            const walletAddress = computeWalletAddress(
                this.config.factoryAddress, 
                publicKeyBytes, 
                this.config.networkPassphrase
            );

            localStorage.setItem('invisible_wallet_address', walletAddress);
            localStorage.setItem('invisible_wallet_key_id', credential.id);
            localStorage.setItem('invisible_wallet_public_key', publicKeyHex);
            
            this.setAddress(walletAddress);
            this.setIsDeployed(false);

            return { walletAddress, publicKeyBytes };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setPending(false);
        }
    }

    async deploy(signerSecret: string | Keypair, publicKeyBytes?: Uint8Array): Promise<DeployResult> {
        const signerKeypair = typeof signerSecret === 'string'
            ? Keypair.fromSecret(signerSecret)
            : Keypair.fromSecret(signerSecret.secret());
        
        this.setPending(true);
        this.setError(null);
        let walletAddress: string | undefined;
        
        try {
            let pubKeyBytes = publicKeyBytes;
            if (!pubKeyBytes) {
                const hex = localStorage.getItem('invisible_wallet_public_key');
                if (!hex) throw new Error('No public key found. Call register() first, or pass publicKeyBytes explicitly.');
                pubKeyBytes = hexToUint8Array(hex);
            }

            walletAddress = computeWalletAddress(
                this.config.factoryAddress, 
                pubKeyBytes, 
                this.config.networkPassphrase
            );

            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const horizonUrl = this.config.networkPassphrase === Networks.TESTNET
                ? 'https://horizon-testnet.stellar.org'
                : 'https://horizon.stellar.org';
            const horizon = new HorizonServer(horizonUrl);
            const sourceAccount = await horizon.loadAccount(signerKeypair.publicKey());
            const factory = new Contract(this.config.factoryAddress);

            const rpIdBytes = new TextEncoder().encode(this.config.rpId ?? window.location.hostname);
            const originBytes = new TextEncoder().encode(this.config.origin ?? window.location.origin);

            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
            })
                .addOperation(
                    factory.call(
                        'deploy',
                        nativeToScVal(pubKeyBytes, { type: 'bytes' }),
                        nativeToScVal(rpIdBytes, { type: 'bytes' }),
                        nativeToScVal(originBytes, { type: 'bytes' }),
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
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }

            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }

            this.setAddress(walletAddress);
            this.setIsDeployed(true);
            localStorage.setItem('invisible_wallet_address', walletAddress);
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
                localStorage.setItem('invisible_wallet_address', walletAddress!);
                return { walletAddress: walletAddress!, alreadyDeployed: true };
            }
            this.setError(message);
            throw new Error(message);
        } finally {
            this.setPending(false);
        }
    }

    async login(): Promise<{ walletAddress: string } | null> {
        this.setPending(true);
        this.setError(null);
        try {
            const stored = localStorage.getItem('invisible_wallet_address');
            if (!stored) {
                this.setError('No wallet found. Please register first.');
                return null;
            }

            const server = new SorobanRpc.Server(this.config.rpcUrl);
            try {
                await server.getContractData(
                    stored,
                    xdr.ScVal.scvLedgerKeyContractInstance(),
                    SorobanRpc.Durability.Persistent
                );
                this.setAddress(stored);
                this.setIsDeployed(true);
                return { walletAddress: stored };
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
            this.setPending(false);
        }
    }

    async signAuthEntry(signaturePayload: Uint8Array): Promise<WebAuthnSignature | null> {
        this.setPending(true);
        this.setError(null);
        try {
            const keyId = localStorage.getItem('invisible_wallet_key_id');
            const publicKeyHex = localStorage.getItem('invisible_wallet_public_key');
            if (!keyId) throw new Error('No key ID found. Please register first.');
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
                publicKey: publicKeyBytes,
                authData: new Uint8Array(response.authenticatorData),
                clientDataJSON: new Uint8Array(response.clientDataJSON),
                signature: rawSignature,
            };
        } catch (err: unknown) {
            this.setError(err instanceof Error ? err.message : String(err));
            throw err;
        } finally {
            this.setPending(false);
        }
    }

    async getNonce(): Promise<bigint> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
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
            return scValToNative(result.retval) as bigint;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setPending(false);
        }
    }

    async addSigner(signerKeypair: Keypair, newPublicKeyBytes: Uint8Array): Promise<AddSignerResult> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            if (newPublicKeyBytes.length !== 65) {
                throw new Error('newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)');
            }
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
            })
                .addOperation(walletContract.call('add_signer', nativeToScVal(newPublicKeyBytes, { type: 'bytes' })))
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
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
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
                    // Default to 0
                }
            }
            return { signerIndex };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setPending(false);
        }
    }

    async getSigners(): Promise<SignerInfo[]> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
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
            this.setPending(false);
        }
    }

    async removeSigner(signerKeypair: Keypair, signerIndex: number): Promise<void> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
            })
                .addOperation(walletContract.call('remove_signer', nativeToScVal(signerIndex, { type: 'u32' })))
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
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
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
            this.setPending(false);
        }
    }

    async setGuardian(signerKeypair: Keypair, guardianAddress: string): Promise<void> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
            })
                .addOperation(walletContract.call('set_guardian', nativeToScVal(guardianAddress, { type: 'address' })))
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
                    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.config.networkPassphrase))
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
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
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
            this.setPending(false);
        }
    }

    async initiateRecovery(guardianKeypair: Keypair, newPublicKeyBytes: Uint8Array): Promise<InitiateRecoveryResult> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            if (newPublicKeyBytes.length !== 65) {
                throw new Error('newPublicKeyBytes must be exactly 65 bytes (uncompressed P-256)');
            }
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const sourceAccount = await server.getAccount(guardianKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
            })
                .addOperation(walletContract.call('initiate_recovery', nativeToScVal(newPublicKeyBytes, { type: 'bytes' })))
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
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
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
                    // Default to 0
                }
            }
            return { unlockTime };
        } catch (err: unknown) {
            if (err instanceof NoGuardianSet) throw err;
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setPending(false);
        }
    }

    async completeRecovery(payerKeypair: Keypair): Promise<void> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const sourceAccount = await server.getAccount(payerKeypair.publicKey());
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
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
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
            }
            const txResult = await waitForTransaction(server, sendResult.hash);
            if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                throw new Error(`Transaction failed with status: ${txResult.status}`);
            }
        } catch (err: unknown) {
            if (err instanceof RecoveryTimelockActive || err instanceof NoGuardianSet || err instanceof RecoveryNotPending) {
                throw err;
            }
            const message = err instanceof Error ? err.message : String(err);
            this.setError(message);
            throw err;
        } finally {
            this.setPending(false);
        }
    }

    async getAllowance(spender: string, token: string): Promise<{ amount: number; expiry: number | undefined } | null> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const dummyKeypair = Keypair.random();
            const sourceAccount = new Account(dummyKeypair.publicKey(), '0');
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
            })
                .addOperation(walletContract.call('get_allowance', nativeToScVal(spender, { type: 'address' }), nativeToScVal(token, { type: 'address' })))
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
            this.setPending(false);
        }
    }

    async approve(signerKeypair: Keypair, spender: string, token: string, amount: number, expiry?: number): Promise<void> {
        this.setPending(true);
        this.setError(null);
        try {
            if (!this.address) throw new Error('No wallet address. Call register() or login() first.');
            const server = new SorobanRpc.Server(this.config.rpcUrl);
            const walletContract = new Contract(this.address);
            const sourceAccount = await server.getAccount(signerKeypair.publicKey());
            let expiryVal: xdr.ScVal;
            if (expiry !== undefined) {
                expiryVal = nativeToScVal([nativeToScVal(BigInt(expiry), { type: 'u64' })], { type: 'Vec' });
            } else {
                expiryVal = xdr.ScVal.scvVoid();
            }
            const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: this.config.networkPassphrase,
            })
                .addOperation(walletContract.call('approve', nativeToScVal(spender, { type: 'address' }), nativeToScVal(token, { type: 'address' }), nativeToScVal(BigInt(amount), { type: 'i128' }), expiryVal))
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
                    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(this.config.networkPassphrase))
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
                throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
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
            this.setPending(false);
        }
    }
}
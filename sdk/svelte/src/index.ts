import { writable } from 'svelte/store';
import {
    Contract,
    Keypair,
    TransactionBuilder,
    BASE_FEE,
    rpc as SorobanRpc,
    xdr,
    nativeToScVal,
    Asset,
    hash as stellarHash,
} from '@stellar/stellar-sdk';
import {
    createInvisibleWallet,
    type InvisibleWallet,
    type WalletConfig,
    type RegisterResult,
    type DeployResult,
    type WebAuthnSignature,
} from 'invisible-wallet-sdk/vanilla';

export type {
    WalletConfig,
    RegisterResult,
    DeployResult,
    WebAuthnSignature,
} from 'invisible-wallet-sdk/vanilla';

/** Reactive state exposed by the wallet store. */
export type WalletStoreState = {
    status: 'idle' | 'registering' | 'deploying' | 'loggingIn' | 'signing' | 'sending' | 'ready' | 'error';
    walletAddress: string | null;
    error: string | null;
};

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
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Transaction ${hash} not confirmed after ${POLL_MAX_ATTEMPTS} attempts`);
}

/**
 * Creates a Svelte store wrapping the framework-agnostic `InvisibleWallet`
 * (from `invisible-wallet-sdk/vanilla`): a writable `{ status, walletAddress,
 * error }` store plus `register` / `login` / `deploy` / `sign` / `send` helpers
 * that update it. No React dependency enters the bundle — the underlying SDK's
 * `vanilla` build is framework-agnostic.
 */
export function createWalletStore(config: WalletConfig) {
    const { subscribe, set, update } = writable<WalletStoreState>({
        status: 'idle',
        walletAddress: null,
        error: null,
    });

    let wallet: InvisibleWallet | null = null;

    function getWallet(): InvisibleWallet {
        if (!wallet) wallet = createInvisibleWallet(config);
        return wallet;
    }

    function fail(err: unknown): never {
        const message = err instanceof Error ? err.message : String(err);
        update((s) => ({ ...s, status: 'error', error: message }));
        throw err;
    }

    /** Create a passkey credential and compute the wallet's contract address. */
    async function register(username?: string): Promise<RegisterResult> {
        update((s) => ({ ...s, status: 'registering', error: null }));
        try {
            const result = await getWallet().register(username);
            set({ status: 'ready', walletAddress: result.walletAddress, error: null });
            return result;
        } catch (err) {
            return fail(err);
        }
    }

    /** Deploy the wallet contract via the factory, paying fees with `signerKeypair`. */
    async function deploy(signerKeypair: Keypair | string, publicKeyBytes?: Uint8Array): Promise<DeployResult> {
        update((s) => ({ ...s, status: 'deploying', error: null }));
        try {
            const result = await getWallet().deploy(signerKeypair, publicKeyBytes);
            update((s) => ({ ...s, status: 'ready', walletAddress: result.walletAddress, error: null }));
            return result;
        } catch (err) {
            return fail(err);
        }
    }

    /** Resume a wallet already stored on this device; returns null if none/undeployed. */
    async function login(): Promise<{ walletAddress: string } | null> {
        update((s) => ({ ...s, status: 'loggingIn', error: null }));
        try {
            const result = await getWallet().login();
            if (result) {
                set({ status: 'ready', walletAddress: result.walletAddress, error: null });
            } else {
                set({ status: 'idle', walletAddress: null, error: null });
            }
            return result;
        } catch (err) {
            return fail(err);
        }
    }

    /** Sign a Soroban authorization payload with the stored passkey. */
    async function sign(signaturePayload: Uint8Array): Promise<WebAuthnSignature | null> {
        update((s) => ({ ...s, status: 'signing', error: null }));
        try {
            const signature = await getWallet().signAuthEntry(signaturePayload);
            update((s) => ({ ...s, status: 'ready' }));
            return signature;
        } catch (err) {
            return fail(err);
        }
    }

    /**
     * Send a Soroban token payment (native XLM by default) from the wallet,
     * authorizing the transfer with the stored passkey and paying network fees
     * with `signerKeypair`.
     */
    async function send(
        signerKeypair: Keypair | string,
        to: string,
        amount: number | bigint,
        token?: string,
        memo?: string
    ): Promise<{ transactionHash: string; status: 'SUCCESS' }> {
        const w = getWallet();
        if (!w.address) throw new Error('No wallet address. Call register() or login() first.');

        update((s) => ({ ...s, status: 'sending', error: null }));
        try {
            const payerKeypair = typeof signerKeypair === 'string'
                ? Keypair.fromSecret(signerKeypair)
                : signerKeypair;

            const contractAddress = token ?? Asset.native().contractId(config.networkPassphrase);
            const tokenContract = new Contract(contractAddress);
            const amountValue = typeof amount === 'bigint' ? amount : BigInt(Math.round(amount));

            const server = new SorobanRpc.Server(config.rpcUrl);
            const sourceAccount = await server.getAccount(payerKeypair.publicKey());
            const txBuilder = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase: config.networkPassphrase,
            }).addOperation(
                tokenContract.call(
                    'transfer',
                    nativeToScVal(w.address, { type: 'address' }),
                    nativeToScVal(to, { type: 'address' }),
                    nativeToScVal(amountValue, { type: 'i128' })
                )
            );

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
                    (stellarHash as (input: Buffer) => Buffer)(Buffer.from(config.networkPassphrase))
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

                    const webAuthnSig = await w.signAuthEntry(payloadHash);
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

            update((s) => ({ ...s, status: 'ready' }));
            return { transactionHash: sendResult.hash, status: 'SUCCESS' };
        } catch (err) {
            return fail(err);
        }
    }

    return {
        subscribe,
        register,
        deploy,
        login,
        sign,
        send,
    };
}

export type VeilWalletStore = ReturnType<typeof createWalletStore>;

import { writable } from 'svelte/store';
import { InvisibleWalletCore } from '../../src/InvisibleWalletCore';
import { Contract, Keypair, rpc as SorobanRpc, Asset, TransactionBuilder, BASE_FEE, xdr, nativeToScVal, } from '@stellar/stellar-sdk';
const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ATTEMPTS = 30;
async function waitForTransaction(server, hash) {
    for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        const result = await server.getTransaction(hash);
        if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
            return result;
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(`Transaction ${hash} not confirmed after ${POLL_MAX_ATTEMPTS} attempts`);
}
export function createWallet(config) {
    const core = new InvisibleWalletCore(config);
    const store = writable({
        status: 'idle',
        walletAddress: core.getState().address,
        isDeployed: core.getState().isDeployed,
        error: core.getState().error,
    });
    // Subscribe to the core wallet state to propagate changes to the Svelte store
    core.subscribe((state) => {
        store.set({
            status: state.isPending ? 'pending' : (state.error ? 'error' : 'idle'),
            walletAddress: state.address,
            isDeployed: state.isDeployed,
            error: state.error,
        });
    });
    return {
        subscribe: store.subscribe,
        // Expose the core instance directly
        core,
        // Core helpers
        register: async (username) => {
            return core.register(username);
        },
        deploy: async (signerSecret, publicKeyBytes) => {
            return core.deploy(signerSecret, publicKeyBytes);
        },
        login: async () => {
            return core.login();
        },
        sign: async (signaturePayload) => {
            return core.signAuthEntry(signaturePayload);
        },
        // End-to-end passkey-signed send helper
        send: async (recipient, amount, feePayerSecret) => {
            const state = core.getState();
            const smartWalletAddress = state.address;
            if (!smartWalletAddress) {
                throw new Error('No wallet address found. Call register() or login() first.');
            }
            const { networkPassphrase, rpcUrl } = core.config;
            const feePayerKeypair = typeof feePayerSecret === 'string'
                ? Keypair.fromSecret(feePayerSecret)
                : Keypair.fromSecret(feePayerSecret.secret());
            // Set state to pending
            store.update(s => ({ ...s, status: 'pending', error: null }));
            core.updateState({ isPending: true, error: null });
            try {
                const server = new SorobanRpc.Server(rpcUrl);
                const sourceAccount = await server.getAccount(feePayerKeypair.publicKey());
                const nativeAsset = Asset.native();
                const sacContractId = nativeAsset.contractId(networkPassphrase);
                const sacContract = new Contract(sacContractId);
                const amountStroops = BigInt(Math.round(parseFloat(amount.toString()) * 10000000));
                const tx = new TransactionBuilder(sourceAccount, {
                    fee: BASE_FEE,
                    networkPassphrase,
                })
                    .addOperation(sacContract.call('transfer', nativeToScVal(smartWalletAddress, { type: 'address' }), nativeToScVal(recipient, { type: 'address' }), nativeToScVal(amountStroops, { type: 'i128' })))
                    .setTimeout(30)
                    .build();
                const sim = await server.simulateTransaction(tx);
                if (SorobanRpc.Api.isSimulationError(sim)) {
                    throw new Error(`Simulation failed: ${sim.error}`);
                }
                const assembled = SorobanRpc.assembleTransaction(tx, sim).build();
                const successSim = sim;
                const authEntries = successSim.result?.auth;
                if (authEntries) {
                    const networkIdBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(networkPassphrase)));
                    for (const parsed of authEntries) {
                        const cred = parsed.credentials();
                        if (cred.switch().value !== xdr.SorobanCredentialsType.sorobanCredentialsAddress().value) {
                            continue;
                        }
                        const addrCred = cred.address();
                        const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({
                            networkId: Buffer.from(networkIdBytes),
                            nonce: addrCred.nonce(),
                            invocation: parsed.rootInvocation(),
                            signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                        }));
                        const payloadHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(preimage.toXDR())));
                        const webAuthnSig = await core.signAuthEntry(payloadHash);
                        if (!webAuthnSig)
                            throw new Error('WebAuthn signing was cancelled');
                        const sigVec = xdr.ScVal.scvVec([
                            nativeToScVal(webAuthnSig.publicKey, { type: 'bytes' }),
                            nativeToScVal(webAuthnSig.authData, { type: 'bytes' }),
                            nativeToScVal(webAuthnSig.clientDataJSON, { type: 'bytes' }),
                            nativeToScVal(webAuthnSig.signature, { type: 'bytes' }),
                        ]);
                        parsed.credentials(xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
                            address: addrCred.address(),
                            nonce: addrCred.nonce(),
                            signatureExpirationLedger: addrCred.signatureExpirationLedger(),
                            signature: sigVec,
                        })));
                    }
                }
                assembled.sign(feePayerKeypair);
                const sendResult = await server.sendTransaction(assembled);
                if (sendResult.status === 'ERROR') {
                    throw new Error(`Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown error'}`);
                }
                const txResult = await waitForTransaction(server, sendResult.hash);
                if (txResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
                    throw new Error(`Transaction failed with status: ${txResult.status}`);
                }
                store.update(s => ({ ...s, status: 'idle', error: null }));
                core.updateState({ isPending: false, error: null });
                return sendResult.hash;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                store.update(s => ({ ...s, status: 'error', error: message }));
                core.updateState({ isPending: false, error: message });
                throw err;
            }
        }
    };
}

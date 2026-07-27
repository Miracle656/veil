import { writable } from 'svelte/store';
import {
    InvisibleWalletCore,
    WalletConfig,
    RegisterResult,
    DeployResult,
    WebAuthnSignature,
    AddSignerResult,
    SignerInfo,
    InitiateRecoveryResult
} from '../../src/InvisibleWalletCore';
import { Keypair } from '@stellar/stellar-sdk';

export interface WalletStoreState {
    status: 'idle' | 'pending' | 'error';
    walletAddress: string | null;
    isDeployed: boolean;
    error: string | null;
}

export function createWallet(config: WalletConfig | string) {
    const core = new InvisibleWalletCore(config);

    const store = writable<WalletStoreState>({
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
        register: async (username?: string): Promise<RegisterResult> => {
            return core.register(username);
        },

        deploy: async (
            signerSecret: string | Keypair,
            publicKeyBytes?: Uint8Array
        ): Promise<DeployResult> => {
            return core.deploy(signerSecret, publicKeyBytes);
        },

        login: async (): Promise<{ walletAddress: string } | null> => {
            return core.login();
        },

        sign: async (
            signaturePayload: Uint8Array
        ): Promise<WebAuthnSignature | null> => {
            return core.signAuthEntry(signaturePayload);
        },

        // End-to-end passkey-signed send helper (delegates to core)
        send: async (
            recipient: string,
            amount: number | string,
            feePayerSecret: string | Keypair
        ): Promise<string> => {
            return core.send(recipient, amount, feePayerSecret);
        }
    };
}

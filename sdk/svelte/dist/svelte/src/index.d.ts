import { InvisibleWalletCore, WalletConfig, RegisterResult, DeployResult, WebAuthnSignature } from '../../src/InvisibleWalletCore';
import { Keypair } from '@stellar/stellar-sdk';
export interface WalletStoreState {
    status: 'idle' | 'pending' | 'error';
    walletAddress: string | null;
    isDeployed: boolean;
    error: string | null;
}
export declare function createWallet(config: WalletConfig | string): {
    subscribe: (this: void, run: import("svelte/store").Subscriber<WalletStoreState>, invalidate?: import("svelte/store").Invalidator<WalletStoreState> | undefined) => import("svelte/store").Unsubscriber;
    core: InvisibleWalletCore;
    register: (username?: string) => Promise<RegisterResult>;
    deploy: (signerSecret: string | Keypair, publicKeyBytes?: Uint8Array) => Promise<DeployResult>;
    login: () => Promise<{
        walletAddress: string;
    } | null>;
    sign: (signaturePayload: Uint8Array) => Promise<WebAuthnSignature | null>;
    send: (recipient: string, amount: number | string, feePayerSecret: string | Keypair) => Promise<string>;
};

import { Keypair } from '@stellar/stellar-sdk';
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
export declare class RecoveryTimelockActive extends Error {
    readonly unlockTime: number;
    constructor(unlockTime: number);
}
export declare class NoGuardianSet extends Error {
    constructor();
}
export declare class RecoveryNotPending extends Error {
    constructor();
}
export declare class InvisibleWalletCore {
    private state;
    private listeners;
    private config;
    constructor(config: WalletConfig | string);
    getState(): WalletState;
    private updateState;
    subscribe(listener: (state: WalletState) => void): () => void;
    register(username?: string): Promise<RegisterResult>;
    deploy(signerSecret: string | Keypair, publicKeyBytes?: Uint8Array): Promise<DeployResult>;
    login(): Promise<{
        walletAddress: string;
    } | null>;
    signAuthEntry(signaturePayload: Uint8Array): Promise<WebAuthnSignature | null>;
    getNonce(): Promise<bigint>;
    addSigner(signerKeypair: Keypair, newPublicKeyBytes: Uint8Array): Promise<AddSignerResult>;
    removeSigner(signerKeypair: Keypair, signerIndex: number): Promise<void>;
    getSigners(): Promise<SignerInfo[]>;
    setGuardian(signerKeypair: Keypair, guardianAddress: string): Promise<void>;
    initiateRecovery(guardianKeypair: Keypair, newPublicKeyBytes: Uint8Array): Promise<InitiateRecoveryResult>;
    completeRecovery(payerKeypair: Keypair): Promise<void>;
    getAllowance(spender: string, token: string): Promise<{
        amount: number;
        expiry: number | undefined;
    } | null>;
    approve(signerKeypair: Keypair, spender: string, token: string, amount: number, expiry?: number): Promise<void>;
}

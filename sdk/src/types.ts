import type { Keypair } from '@stellar/stellar-sdk';

/** Minimal snapshot of the hook's public state for consumers. */
export type WalletState = {
    address: string | null;
    isDeployed: boolean;
    isPending: boolean;
    error: string | null;
};

/** Options passed to `register()` on the hook. */
export type RegisterOptions = {
    username?: string;
};

/** Options for signing operations that require a payload to sign. */
export type SignOptions = {
    signaturePayload: Uint8Array;
};

/** Options used when sending/deploying transactions via the hook. */
export type SendOptions = {
    signerSecret: string | Keypair;
    publicKeyBytes?: Uint8Array;
};

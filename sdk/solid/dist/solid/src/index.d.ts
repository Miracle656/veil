import { Keypair } from '@stellar/stellar-sdk';
import { TransactionOutbox } from '../../src/outbox';
import type { WalletConfig, WebAuthnSignature, RegisterOptions, PortableSigner, RegisterResult, DeployResult, AddSignerResult, SignerInfo, InitiateRecoveryResult } from '../../src/useInvisibleWallet';
import type { ReplayOptions, ReplayResult } from '../../src/outbox';
import type { CounterfactualAddress } from '../../src/counterfactual';
export { RecoveryTimelockActive, NoGuardianSet, RecoveryNotPending, } from '../../src/useInvisibleWallet';
export type { WalletConfig, WebAuthnSignature, RegisterOptions, PortableSigner, RegisterResult, DeployResult, AddSignerResult, SignerInfo, InitiateRecoveryResult, };
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
    login: () => Promise<{
        walletAddress: string;
    } | null>;
    getNonce: () => Promise<bigint>;
    addSigner: (signerKeypair: Keypair, newPublicKeyBytes: Uint8Array) => Promise<AddSignerResult>;
    removeSigner: (signerKeypair: Keypair, signerIndex: number) => Promise<void>;
    getSigners: () => Promise<SignerInfo[]>;
    setGuardian: (signerKeypair: Keypair, guardianAddress: string) => Promise<void>;
    initiateRecovery: (guardianKeypair: Keypair, newPublicKeyBytes: Uint8Array) => Promise<InitiateRecoveryResult>;
    completeRecovery: (payerKeypair: Keypair) => Promise<void>;
    approve: (signerKeypair: Keypair, spender: string, token: string, amount: number, expiry?: number) => Promise<void>;
    getBalance: (token?: string) => Promise<{
        address: string;
        amount: bigint;
        assetCode: string;
    }>;
    sendPayment: (signerKeypair: Keypair | string, to: string, amount: number | bigint, token?: string, memo?: string) => Promise<{
        transactionHash: string;
        status: 'PENDING' | 'SUCCESS' | 'FAILED';
    }>;
    getAllowance: (spender: string, token: string) => Promise<{
        amount: number;
        expiry: number | undefined;
    } | null>;
    outbox: TransactionOutbox;
    replayOutbox: (opts?: ReplayOptions) => Promise<ReplayResult>;
    encryptLocal: (plaintext: string | Uint8Array) => Promise<string>;
    decryptLocal: (payload: string) => Promise<string>;
    encryptionMode: () => Promise<'prf' | 'fallback'>;
};
export declare function useInvisibleWallet(config: WalletConfig): SolidInvisibleWallet;

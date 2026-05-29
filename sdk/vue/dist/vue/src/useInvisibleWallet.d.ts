import { WalletConfig, RegisterResult, DeployResult, AddSignerResult, SignerInfo, InitiateRecoveryResult, RecoveryTimelockActive, NoGuardianSet, RecoveryNotPending } from '../../src/core/InvisibleWalletCore';
import { Keypair } from '@stellar/stellar-sdk';

export declare function useInvisibleWallet(config: WalletConfig): {
    address: Readonly<import('vue').Ref<string | null, string | null>>;
    isDeployed: Readonly<import('vue').Ref<boolean, boolean>>;
    isPending: Readonly<import('vue').Ref<boolean, boolean>>;
    error: Readonly<import('vue').Ref<string | null, string | null>>;
    register: (username?: string) => Promise<RegisterResult>;
    deploy: (signerKeypair: Keypair | string, publicKeyBytes?: Uint8Array) => Promise<DeployResult>;
    login: () => Promise<{
        walletAddress: string;
    } | null>;
    signAuthEntry: (signaturePayload: Uint8Array) => Promise<import('../../src/core/InvisibleWalletCore').WebAuthnSignature | null>;
    getNonce: () => Promise<bigint>;
    addSigner: (signerKeypair: Keypair, newPublicKeyBytes: Uint8Array) => Promise<AddSignerResult>;
    getSigners: () => Promise<SignerInfo[]>;
    removeSigner: (signerKeypair: Keypair, signerIndex: number) => Promise<void>;
    setGuardian: (signerKeypair: Keypair, guardianAddress: string) => Promise<void>;
    initiateRecovery: (guardianKeypair: Keypair, newPublicKeyBytes: Uint8Array) => Promise<InitiateRecoveryResult>;
    completeRecovery: (payerKeypair: Keypair) => Promise<void>;
    getAllowance: (spender: string, token: string) => Promise<{
        amount: number;
        expiry: number | undefined;
    } | null>;
    approve: (signerKeypair: Keypair, spender: string, token: string, amount: number, expiry?: number) => Promise<void>;
};
export { RecoveryTimelockActive, NoGuardianSet, RecoveryNotPending };
export type { WalletConfig, RegisterResult, DeployResult, AddSignerResult, SignerInfo, InitiateRecoveryResult };
//# sourceMappingURL=useInvisibleWallet.d.ts.map
import { ref, readonly, onMounted, onUnmounted } from 'vue';
import { Keypair } from '@stellar/stellar-sdk';
import { 
    InvisibleWalletCore, 
    type WalletConfig, 
    type RegisterResult, 
    type DeployResult, 
    type AddSignerResult, 
    type SignerInfo, 
    type InitiateRecoveryResult,
    RecoveryTimelockActive, 
    NoGuardianSet, 
    RecoveryNotPending 
} from 'invisible-wallet-sdk';

export function useInvisibleWallet(config: WalletConfig) {
    const address = ref<string | null>(null);
    const isDeployed = ref(false);
    const isPending = ref(false);
    const error = ref<string | null>(null);

    let core: InvisibleWalletCore | null = null;

    // Create core instance with state callback
    const initializeCore = () => {
        core = new InvisibleWalletCore(config, (state) => {
            address.value = state.address;
            isDeployed.value = state.isDeployed;
            isPending.value = state.isPending;
            error.value = state.error;
        });
    };

    // Initialize on mount
    onMounted(() => {
        initializeCore();
    });

    // Cleanup on unmount
    onUnmounted(() => {
        core = null;
    });

    // Wrapper methods that delegate to core
    const register = async (username?: string): Promise<RegisterResult> => {
        if (!core) throw new Error('Core not initialized');
        return core.register(username);
    };

    const deploy = async (signerKeypair: Keypair | string, publicKeyBytes?: Uint8Array): Promise<DeployResult> => {
        if (!core) throw new Error('Core not initialized');
        return core.deploy(signerKeypair, publicKeyBytes);
    };

    const login = async (): Promise<{ walletAddress: string } | null> => {
        if (!core) throw new Error('Core not initialized');
        return core.login();
    };

    const signAuthEntry = async (signaturePayload: Uint8Array) => {
        if (!core) throw new Error('Core not initialized');
        return core.signAuthEntry(signaturePayload);
    };

    const getNonce = async (): Promise<bigint> => {
        if (!core) throw new Error('Core not initialized');
        return core.getNonce();
    };

    const addSigner = async (signerKeypair: Keypair, newPublicKeyBytes: Uint8Array): Promise<AddSignerResult> => {
        if (!core) throw new Error('Core not initialized');
        return core.addSigner(signerKeypair, newPublicKeyBytes);
    };

    const getSigners = async (): Promise<SignerInfo[]> => {
        if (!core) throw new Error('Core not initialized');
        return core.getSigners();
    };

    const removeSigner = async (signerKeypair: Keypair, signerIndex: number): Promise<void> => {
        if (!core) throw new Error('Core not initialized');
        return core.removeSigner(signerKeypair, signerIndex);
    };

    const setGuardian = async (signerKeypair: Keypair, guardianAddress: string): Promise<void> => {
        if (!core) throw new Error('Core not initialized');
        return core.setGuardian(signerKeypair, guardianAddress);
    };

    const initiateRecovery = async (guardianKeypair: Keypair, newPublicKeyBytes: Uint8Array): Promise<InitiateRecoveryResult> => {
        if (!core) throw new Error('Core not initialized');
        return core.initiateRecovery(guardianKeypair, newPublicKeyBytes);
    };

    const completeRecovery = async (payerKeypair: Keypair): Promise<void> => {
        if (!core) throw new Error('Core not initialized');
        return core.completeRecovery(payerKeypair);
    };

    const getAllowance = async (spender: string, token: string) => {
        if (!core) throw new Error('Core not initialized');
        return core.getAllowance(spender, token);
    };

    const approve = async (signerKeypair: Keypair, spender: string, token: string, amount: number, expiry?: number): Promise<void> => {
        if (!core) throw new Error('Core not initialized');
        return core.approve(signerKeypair, spender, token, amount, expiry);
    };

    // Return reactive state and methods
    return {
        // Reactive state (readonly to prevent direct mutations)
        address: readonly(address),
        isDeployed: readonly(isDeployed),
        isPending: readonly(isPending),
        error: readonly(error),
        
        // Methods
        register,
        deploy,
        login,
        signAuthEntry,
        getNonce,
        addSigner,
        getSigners,
        removeSigner,
        setGuardian,
        initiateRecovery,
        completeRecovery,
        getAllowance,
        approve,
    };
}

// Export error classes for consumers
export { RecoveryTimelockActive, NoGuardianSet, RecoveryNotPending };
export type { WalletConfig, RegisterResult, DeployResult, AddSignerResult, SignerInfo, InitiateRecoveryResult };
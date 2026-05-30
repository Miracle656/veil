import type { useInvisibleWallet } from './useInvisibleWallet';

export type WalletState = Pick<
    ReturnType<typeof useInvisibleWallet>,
    'address' | 'isDeployed' | 'isPending' | 'error'
>;

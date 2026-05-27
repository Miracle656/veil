import { createWallet } from '@veil/invisible-wallet-svelte';

// Default Stellar Testnet Configuration
export const FACTORY_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
export const RPC_URL = 'https://soroban-testnet.stellar.org';
export const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

export const wallet = createWallet({
    factoryAddress: FACTORY_ADDRESS,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
});

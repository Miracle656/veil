import { Networks } from '@stellar/stellar-sdk';
import type { WalletConfig } from 'invisible-wallet-sdk/angular';

/**
 * Network settings for the starter.
 *
 * Deploy your own factory contract and paste its id here, or reuse the same
 * settings shown in ./examples/vue/.env.example. For mainnet, point `rpcUrl`
 * at a public Soroban RPC and use `Networks.PUBLIC`.
 */
export const environment: { wallet: WalletConfig, horizonUrl: string } = {
  wallet: {
    factoryAddress: 'YOUR_FACTORY_CONTRACT_ID',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  },
  horizonUrl: 'https://horizon-testnet.stellar.org',
};
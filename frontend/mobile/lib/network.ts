import { Networks } from '@stellar/stellar-sdk';

/**
 * Network configuration for the mobile app. Mirrors
 * `frontend/wallet/lib/network.ts`, reading `EXPO_PUBLIC_*` variables instead of
 * `NEXT_PUBLIC_*` ones so values are inlined by the Expo bundler.
 */

export type VeilNetworkName = 'testnet' | 'mainnet';

export type VeilNetwork = {
  name: VeilNetworkName;
  displayName: string;
  networkPassphrase: string;
  horizonUrl: string;
  rpcUrl: string;
};

export const NETWORKS: Record<VeilNetworkName, VeilNetwork> = {
  testnet: {
    name: 'testnet',
    displayName: 'Stellar Testnet',
    networkPassphrase: Networks.TESTNET,
    horizonUrl:
      process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() || 'https://horizon-testnet.stellar.org',
    rpcUrl:
      process.env['EXPO_PUBLIC_SOROBAN_RPC_URL']?.trim() ||
      process.env['EXPO_PUBLIC_RPC_URL']?.trim() ||
      'https://soroban-testnet.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    displayName: 'Stellar Mainnet',
    networkPassphrase: Networks.PUBLIC,
    horizonUrl: process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() || 'https://horizon.stellar.org',
    rpcUrl: process.env['EXPO_PUBLIC_MAINNET_RPC_URL']?.trim() || '',
  },
};

export function getNetwork(): VeilNetwork {
  return process.env['EXPO_PUBLIC_NETWORK'] === 'mainnet' ? NETWORKS.mainnet : NETWORKS.testnet;
}

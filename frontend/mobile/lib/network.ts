import { Asset, Networks } from '@stellar/stellar-sdk';

export type VeilNetworkName = 'testnet' | 'mainnet';

export type VeilNetwork = {
  name: VeilNetworkName;
  displayName: string;
  networkPassphrase: string;
  horizonUrl: string;
  rpcUrl: string;
  factoryContractId: string;
  friendbotUrl: string | null;
};

const NETWORKS: Record<VeilNetworkName, VeilNetwork> = {
  testnet: {
    name: 'testnet',
    displayName: 'Stellar Testnet',
    networkPassphrase: Networks.TESTNET,
    horizonUrl:
      process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() ||
      'https://horizon-testnet.stellar.org',
    rpcUrl:
      process.env['EXPO_PUBLIC_SOROBAN_RPC_URL']?.trim() ||
      process.env['EXPO_PUBLIC_RPC_URL']?.trim() ||
      'https://soroban-testnet.stellar.org',
    factoryContractId:
      process.env['EXPO_PUBLIC_FACTORY_CONTRACT_ID_TESTNET']?.trim() ||
      process.env['EXPO_PUBLIC_FACTORY_CONTRACT_ID']?.trim() ||
      '',
    friendbotUrl: 'https://friendbot.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    displayName: 'Stellar Mainnet',
    networkPassphrase: Networks.PUBLIC,
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: process.env['EXPO_PUBLIC_MAINNET_RPC_URL']?.trim() || '',
    factoryContractId:
      process.env['EXPO_PUBLIC_FACTORY_CONTRACT_ID_MAINNET']?.trim() || '',
    friendbotUrl: null,
  },
};

export function getNetwork(): VeilNetwork {
  return process.env['EXPO_PUBLIC_NETWORK'] === 'mainnet'
    ? NETWORKS.mainnet
    : NETWORKS.testnet;
}

export function getNativeAssetContractId(): string {
  return Asset.native().contractId(getNetwork().networkPassphrase);
}

export function buildFriendbotUrl(address: string): string | null {
  const friendbotUrl = getNetwork().friendbotUrl;
  if (!friendbotUrl) return null;
  const url = new URL(friendbotUrl);
  url.searchParams.set('addr', address);
  return url.toString();
}

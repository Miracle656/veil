import { Asset, Networks } from '@stellar/stellar-sdk';
import type { WalletConfig } from '@veil/invisible-wallet-svelte';
import {
  PUBLIC_NETWORK,
  PUBLIC_SOROBAN_RPC_URL,
  PUBLIC_HORIZON_URL,
  PUBLIC_FACTORY_CONTRACT_ID,
} from '$env/static/public';

const isMainnet = PUBLIC_NETWORK === 'mainnet';

// gitguardian:ignore=true — public well-known Stellar network passphrase, not a secret
export const networkPassphrase = isMainnet ? Networks.PUBLIC : Networks.TESTNET;
export const rpcUrl = PUBLIC_SOROBAN_RPC_URL;
export const horizonUrl = PUBLIC_HORIZON_URL;
export const friendbotUrl = isMainnet ? null : 'https://friendbot.stellar.org';

/** Contract id of the native (XLM) Stellar Asset Contract on this network. */
export function nativeAssetContractId(): string {
  return Asset.native().contractId(networkPassphrase);
}

export const walletConfig: WalletConfig = {
  factoryAddress: PUBLIC_FACTORY_CONTRACT_ID,
  rpcUrl,
  networkPassphrase,
};

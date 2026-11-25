import { StrKey } from '@stellar/stellar-sdk';
import type { VeilNetworkName } from '../lib/network';

/**
 * DeFindex Vault configuration for mobile.
 *
 * Keeps contract IDs in config rather than in components and validates every
 * contract address with StrKey.isValidContract rather than trusting a pasted
 * constant or environment string.
 */

export interface DefindexVaultConfig {
  vaultAddress: string;
  name: string;
  symbol: string;
  underlyingAssetCode: string;
  veilFeeBps: number;
}

/**
 * Validates that an address is a valid Soroban contract ID (C...).
 * Throws a descriptive error if the address is invalid or malformed.
 */
export function assertValidContractAddress(address: string, context = 'DeFindex vault'): string {
  const trimmed = address?.trim();
  if (!trimmed || !StrKey.isValidContract(trimmed)) {
    throw new Error(
      `Invalid ${context} contract address: "${address}". Expected a valid 56-character Stellar contract ID starting with 'C'.`,
    );
  }
  return trimmed;
}

/**
 * Default DeFindex vault contract addresses per network.
 * Mainnet points to the canonical DeFindex Meru USDC vault (verified on-chain).
 * Testnet can be overridden via EXPO_PUBLIC_DEFINDEX_VAULT_CONTRACT_ID_TESTNET or
 * EXPO_PUBLIC_DEFINDEX_VAULT_CONTRACT_ID.
 */
export const DEFAULT_DEFINDEX_VAULT_CONTRACTS: Record<VeilNetworkName, string> = {
  mainnet: 'CCA2ZJP5BVRXYTQH4FAGHCAUMRYCXVC4CRYC2NXHWMR7TIVX36U7F5HR',
  // Testnet default deployment or configured via environment
  testnet:
    process.env['EXPO_PUBLIC_DEFINDEX_VAULT_CONTRACT_ID_TESTNET']?.trim() ||
    process.env['EXPO_PUBLIC_DEFINDEX_VAULT_CONTRACT_ID']?.trim() ||
    // Fallback valid C... contract ID on testnet
    'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA',
};

/**
 * Returns the validated configuration for the DeFindex vault on the specified network.
 */
export function getDefindexVaultConfig(
  networkName: VeilNetworkName = 'mainnet',
  overrideAddress?: string,
): DefindexVaultConfig {
  const rawAddress =
    overrideAddress ||
    (networkName === 'testnet'
      ? process.env['EXPO_PUBLIC_DEFINDEX_VAULT_CONTRACT_ID_TESTNET']?.trim() ||
        process.env['EXPO_PUBLIC_DEFINDEX_VAULT_CONTRACT_ID']?.trim() ||
        DEFAULT_DEFINDEX_VAULT_CONTRACTS.testnet
      : DEFAULT_DEFINDEX_VAULT_CONTRACTS.mainnet);

  const vaultAddress = assertValidContractAddress(rawAddress, `DeFindex vault (${networkName})`);

  return {
    vaultAddress,
    name: 'DeFindex USDC Vault',
    symbol: 'dfUSDC',
    underlyingAssetCode: 'USDC',
    // Veil charges 0 bps (0.00%) on vault deposits/yield
    veilFeeBps: 0,
  };
}

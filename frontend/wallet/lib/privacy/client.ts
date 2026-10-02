import { StrKey } from '@stellar/stellar-sdk';

export interface PrivacyClientConfig {
  poolId: string;
  assetContractId: string;
}

export function validatePrivacyConfig(config: PrivacyClientConfig): void {
  if (!StrKey.isValidContract(config.poolId)) {
    throw new Error(`Invalid pool contract ID: ${config.poolId}. Must be a valid C... address.`);
  }

  if (!StrKey.isValidContract(config.assetContractId)) {
    throw new Error(`Invalid asset contract ID: ${config.assetContractId}. Must be a valid C... address.`);
  }
}

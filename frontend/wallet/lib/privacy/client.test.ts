import { validatePrivacyConfig } from './client';

describe('PrivacyClient Configuration Validation', () => {
  it('should pass with valid contract IDs', () => {
    const validConfig = {
      poolId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      assetContractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    };

    expect(() => validatePrivacyConfig(validConfig)).not.toThrow();
  });

  it('should refuse malformed or invalid contract IDs', () => {
    const invalidConfig = {
      poolId: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 
      assetContractId: 'invalid-contract-id',
    };

    expect(() => validatePrivacyConfig(invalidConfig)).toThrow(/Invalid pool contract ID/);
  });
});

import { ASSET_REGISTRY, isRegisteredIssuer, verifyAsset } from '../assets';
import { visibleHoldings } from '../../components/AssetsList';

const REAL_USDY = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6';

describe('verifyAsset', () => {
  it('distinguishes real USDY from a same-code impostor', () => {
    expect(isRegisteredIssuer('USDY', REAL_USDY, 'mainnet')).toBe(true);
    expect(verifyAsset('USDY', REAL_USDY, 'mainnet')).toEqual({
      verified: true,
      impersonates: null,
    });
    expect(verifyAsset('USDY', 'GIMPOSTOR', 'mainnet')).toMatchObject({
      verified: false,
      impersonates: { code: 'USDY', issuerName: 'Ondo', issuer: REAL_USDY },
    });
  });

  it('flags a mixed-case registered code as an impersonation', () => {
    expect(verifyAsset('Usdc', ASSET_REGISTRY.USDC.issuer, 'mainnet')).toEqual({
      verified: false,
      impersonates: ASSET_REGISTRY.USDC,
    });
  });

  it('partitions real and impostor USDY holdings and expands them together', () => {
    const real = {
      code: 'USDY',
      issuer: REAL_USDY,
      name: 'USDY',
      balance: '1',
      usd: null,
      native: false,
      assetType: 'credit_alphanum4',
      verification: verifyAsset('USDY', REAL_USDY, 'mainnet'),
    };
    const impostor = {
      code: 'USDY',
      issuer: 'GIMPOSTOR',
      name: 'USDY',
      balance: '2',
      usd: null,
      native: false,
      assetType: 'credit_alphanum4',
      verification: verifyAsset('USDY', 'GIMPOSTOR', 'mainnet'),
    };

    expect(visibleHoldings([real, impostor], false)).toEqual([real]);
    expect(visibleHoldings([real, impostor], true)).toEqual([real, impostor]);
  });
});

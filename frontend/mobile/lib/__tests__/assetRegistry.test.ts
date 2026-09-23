import { verifyAsset } from '../assetRegistry';

const REAL_USDY = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6';

describe('verifyAsset', () => {
  it('distinguishes real USDY from a same-code impostor', () => {
    expect(verifyAsset('USDY', REAL_USDY, 'mainnet')).toEqual({
      verified: true,
      impersonates: null,
    });
    expect(verifyAsset('USDY', 'GIMPOSTOR', 'mainnet')).toMatchObject({
      verified: false,
      impersonates: { code: 'USDY', issuerName: 'Ondo', issuer: REAL_USDY },
    });
  });
});

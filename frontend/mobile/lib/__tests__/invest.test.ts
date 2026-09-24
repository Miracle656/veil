const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import {
  INVEST_ASSETS,
  INVEST_FEATURE_ENABLED,
  getAvailableInvestAssets,
  hasAcknowledgedEligibility,
  getEligibilityAcknowledgement,
  recordEligibilityAcknowledgement,
} from '../invest';

describe('invest assets eligibility gate and regional availability (#743)', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it('defines feature flag defaulting to off (false)', () => {
    expect(INVEST_FEATURE_ENABLED).toBe(false);
  });

  it('default configuration offers no invest asset in any region', () => {
    expect(INVEST_ASSETS.length).toBeGreaterThan(0);
    for (const asset of INVEST_ASSETS) {
      expect(asset.enabledRegions).toEqual([]);
      expect(asset.whoMayHold).toBeTruthy();
      expect(asset.declarationText).toBeTruthy();
    }
  });

  it('returns empty array in default-off state even if a region is requested', () => {
    // When INVEST_FEATURE_ENABLED is false, no assets are offered
    const assets = getAvailableInvestAssets('GLOBAL');
    expect(assets).toEqual([]);

    const ngAssets = getAvailableInvestAssets('NG');
    expect(ngAssets).toEqual([]);
  });

  it('returns empty array for an excluded region when feature is enabled', () => {
    // Simulate an enabled asset in NG only, while the feature flag is on.
    const testAsset = { ...INVEST_ASSETS[0], enabledRegions: ['NG'] };
    expect(
      getAvailableInvestAssets('US', { featureEnabled: true, assets: [testAsset] }),
    ).toEqual([]);
    expect(
      getAvailableInvestAssets('NG', { featureEnabled: true, assets: [testAsset] }),
    ).toEqual([testAsset]);
  });

  it('records eligibility acknowledgement locally with timestamp and asset code', async () => {
    const assetCode = 'USDY';
    expect(await hasAcknowledgedEligibility(assetCode)).toBe(false);

    const ack = await recordEligibilityAcknowledgement(assetCode);
    expect(ack.assetCode).toBe('USDY');
    expect(ack.timestamp).toBeTruthy();
    expect(new Date(ack.timestamp).getTime()).not.toBeNaN();

    expect(await hasAcknowledgedEligibility(assetCode)).toBe(true);

    const fetchedAck = await getEligibilityAcknowledgement(assetCode);
    expect(fetchedAck).toEqual(ack);
  });
});


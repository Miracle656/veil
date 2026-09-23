import { getAvailableInvestAssets, INVEST_ASSETS } from '../invest';

describe('invest assets and regional availability (V182/V190)', () => {
  it('defines invest assets with required fields: issuerName, backs, riskLine', () => {
    expect(INVEST_ASSETS.length).toBeGreaterThan(0);
    const usdy = INVEST_ASSETS.find((a) => a.code === 'USDY');
    expect(usdy).toBeDefined();
    expect(usdy?.issuerName).toBe('Ondo Finance');
    expect(usdy?.backs).toBeTruthy();
    expect(usdy?.riskLine).toBeTruthy();
  });

  it('returns available assets for an enabled region', () => {
    const assets = getAvailableInvestAssets('GLOBAL');
    expect(assets.length).toBeGreaterThan(0);
    expect(assets[0].code).toBe('USDY');
  });

  it('returns empty array when region is empty or not enabled', () => {
    const emptyRegionAssets = getAvailableInvestAssets('');
    expect(emptyRegionAssets).toEqual([]);

    const unenabledRegionAssets = getAvailableInvestAssets('RESTRICTED_REGION_XYZ');
    expect(unenabledRegionAssets).toEqual([]);
  });
});

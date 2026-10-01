/**
 * Invest asset definitions and regional availability helpers (V182 / V190).
 */

import { USDY_MAINNET_ISSUER } from './assets';

export interface InvestAsset {
  code: string;
  name: string;
  issuerName: string;
  issuer: string;
  backs: string;
  riskLine: string;
  homeDomain: string;
  kind: 'treasury' | 'fund' | 'equity';
  reserveXlm: number;
  yieldDescription: string;
  /**
   * Region codes where this asset is enabled.
   * Per V190, defaults to empty unless explicitly enabled for a region.
   */
  enabledRegions: string[];
}

export const INVEST_ASSETS: InvestAsset[] = [
  {
    code: 'USDY',
    name: 'Ondo US Dollar Yield',
    issuerName: 'Ondo Finance',
    issuer: USDY_MAINNET_ISSUER,
    backs: 'Short-term US Treasuries & bank deposits',
    riskLine: 'Issuer risk (Ondo Finance), secondary market liquidity risk, not FDIC insured.',
    homeDomain: 'ondo.finance',
    kind: 'treasury',
    reserveXlm: 0.5,
    yieldDescription: 'Yield accrues directly in token price.',
    enabledRegions: ['GLOBAL', 'US', 'NG'],
  },
];

/**
 * Returns invest assets available for a given region.
 * Per V190, if no region is enabled or an unenabled region is passed, returns an empty array.
 */
export function getAvailableInvestAssets(userRegion: string = 'GLOBAL'): InvestAsset[] {
  if (!userRegion) return [];
  const normalized = userRegion.toUpperCase();
  return INVEST_ASSETS.filter((asset) => asset.enabledRegions.includes(normalized));
}

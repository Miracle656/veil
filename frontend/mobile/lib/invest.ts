import { USDY_MAINNET_ISSUER } from './assets';
import { getSecureJSON, setSecureJSON } from './storage';

/**
 * Feature flag for the invest rail.
 * Defaults to false so the rail can be switched off entirely in one place.
 */
export const INVEST_FEATURE_ENABLED = false;

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
   * Per V190 and Issue #743, defaults to empty ([]) until explicitly enabled.
   */
  enabledRegions: string[];
  /**
   * Describes eligible categories of holders.
   */
  whoMayHold: string;
  /**
   * Explicit eligibility declaration text required before purchase.
   */
  declarationText: string;
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
    enabledRegions: [], // Default configuration offers no invest asset in any region
    whoMayHold: 'Non-US persons and residents of permitted jurisdictions.',
    declarationText: 'I declare that I am not a US person, not a resident of an excluded jurisdiction, and am eligible to hold tokenized treasury assets.',
  },
];

/**
 * Record of user eligibility acknowledgement stored locally.
 */
export interface EligibilityAcknowledgement {
  assetCode: string;
  timestamp: string;
}

/**
 * Returns invest assets available for a given region.
 * Per V190 & #743, if feature flag is off, no region is enabled, or an unenabled region is passed, returns [].
 */
export function getAvailableInvestAssets(userRegion: string = 'GLOBAL'): InvestAsset[] {
  if (!INVEST_FEATURE_ENABLED) return [];
  if (!userRegion) return [];
  const normalized = userRegion.toUpperCase();
  return INVEST_ASSETS.filter((asset) => asset.enabledRegions.includes(normalized));
}

/**
 * Records an eligibility acknowledgement locally with a timestamp and the asset code covered.
 */
export async function recordEligibilityAcknowledgement(
  assetCode: string,
): Promise<EligibilityAcknowledgement> {
  const record: EligibilityAcknowledgement = {
    assetCode: assetCode.toUpperCase(),
    timestamp: new Date().toISOString(),
  };
  const key = `veil_invest_ack_${assetCode.toLowerCase()}`;
  await setSecureJSON(key, record);
  return record;
}

/**
 * Retrieves the recorded eligibility acknowledgement for a given asset code.
 */
export async function getEligibilityAcknowledgement(
  assetCode: string,
): Promise<EligibilityAcknowledgement | null> {
  const key = `veil_invest_ack_${assetCode.toLowerCase()}`;
  return getSecureJSON<EligibilityAcknowledgement>(key);
}

/**
 * Checks whether the user has recorded an eligibility acknowledgement for the specified asset.
 */
export async function hasAcknowledgedEligibility(assetCode: string): Promise<boolean> {
  const ack = await getEligibilityAcknowledgement(assetCode);
  return ack !== null && ack.assetCode === assetCode.toUpperCase() && Boolean(ack.timestamp);
}


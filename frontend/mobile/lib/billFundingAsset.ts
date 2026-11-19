/**
 * Which asset a bill is paid from, and whether the person was told.
 *
 * A bill is funded from XLM or USDC, and the choice changes what leaves the
 * wallet (and what a fee is quoted in). The decision lives here as pure
 * functions so every bill screen explains it the same way, and so it can be
 * tested without a wallet.
 *
 * XLM affordability uses the reserve-aware spendable balance, never the raw
 * one: base reserve plus trustlines is why a balance that looks sufficient is
 * not.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import type { NairaCoin } from './onramp';

export const BILL_FUNDING_KEY = 'veil.bill.fundingCoin';

export interface FundingHoldings {
  /** Reserve-aware spendable XLM. */
  xlm: number;
  usdc: number;
}

export interface FundingCosts {
  /** Amount of each coin the bill costs at its own rate; null while unquoted. */
  xlm: number | null;
  usdc: number | null;
}

export type FundingStatus = 'both' | 'only-one' | 'neither' | 'unknown';

export interface FundingDecision {
  status: FundingStatus;
  /** The asset the bill will be paid with, or null when neither can cover it. */
  coin: NairaCoin | null;
  /** True when the person may pick between the two. */
  canChoose: boolean;
  /** True when the app picked and the person did not. */
  automatic: boolean;
  /** Plain-language explanation to show next to the asset. */
  reason: string | null;
}

const other = (c: NairaCoin): NairaCoin => (c === 'xlm' ? 'usdc' : 'xlm');
const label = (c: NairaCoin) => c.toUpperCase();

export function canAfford(cost: number | null, held: number): boolean {
  return cost !== null && cost > 0 && held >= cost;
}

export function decideFundingAsset(params: {
  costs: FundingCosts;
  holdings: FundingHoldings | null;
  /** The person's explicit or remembered choice, if any. */
  preferred: NairaCoin | null;
}): FundingDecision {
  const { costs, holdings, preferred } = params;
  if (!holdings || (costs.xlm === null && costs.usdc === null)) {
    return { status: 'unknown', coin: preferred, canChoose: false, automatic: false, reason: null };
  }
  const xlmOk = canAfford(costs.xlm, holdings.xlm);
  const usdcOk = canAfford(costs.usdc, holdings.usdc);

  if (xlmOk && usdcOk) {
    return {
      status: 'both',
      coin: preferred ?? 'usdc',
      canChoose: true,
      automatic: preferred === null,
      reason: preferred === null ? 'Both XLM and USDC can cover this. Choose which one to spend.' : null,
    };
  }
  if (xlmOk || usdcOk) {
    const coin: NairaCoin = xlmOk ? 'xlm' : 'usdc';
    const why =
      other(coin) === 'xlm'
        ? 'your spendable XLM is short (the account reserve is held back)'
        : 'your USDC balance is short';
    return {
      status: 'only-one',
      coin,
      canChoose: false,
      automatic: true,
      reason: `Paid with ${label(coin)} because ${why}.`,
    };
  }
  return {
    status: 'neither',
    coin: null,
    canChoose: false,
    automatic: false,
    reason: 'Neither XLM nor USDC in this wallet can cover this bill.',
  };
}

export async function loadFundingChoice(): Promise<NairaCoin | null> {
  try {
    const v = await AsyncStorage.getItem(BILL_FUNDING_KEY);
    return v === 'xlm' || v === 'usdc' ? v : null;
  } catch {
    return null;
  }
}

export async function saveFundingChoice(coin: NairaCoin): Promise<void> {
  try {
    await AsyncStorage.setItem(BILL_FUNDING_KEY, coin);
  } catch {
    // Remembering is a convenience; never block a payment on it.
  }
}

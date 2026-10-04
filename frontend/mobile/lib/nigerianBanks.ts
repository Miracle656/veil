/**
 * Nigerian bank codes for the offramp payout picker.
 *
 * A subset of Linq's list — the banks people actually hold accounts with,
 * including the mobile-money providers that dominate here. The code is what
 * Linq matches on; the name is only ever shown.
 *
 * Deliberately not fetched at runtime: the list changes rarely, an offline
 * picker is better than a spinner, and a wrong code produces a failed payout
 * AFTER the USDC has gone rather than a validation error before it.
 *
 * The `slug` is for the logo only, and it is a SEPARATE identifier from `code`.
 * nigerianbanks.xyz numbers banks on its own scheme, and for several of these
 * the two disagree — OPay is 100004 here and 999992 there, Moniepoint 090405
 * against 50515, Stanbic 039 against 221. Searching that list by name is worse
 * still: "FCMB" matches *FCMB MFB*, the microfinance arm, which is a different
 * institution with a different code. So the slugs below were each resolved by
 * hand and written down, and nothing derives a payout code from them. Getting
 * this wrong sends someone's money to the wrong bank.
 */
export interface NigerianBank {
  /** Linq's payout code. The only field that moves money. */
  code: string;
  name: string;
  /** nigerianbanks.xyz slug — logo only, never a payout identifier. */
  slug?: string;
}

/** Where a bank's mark is served from. Undefined slug means the lettered fallback. */
export function bankLogoUrl(slug?: string): string | null {
  return slug ? `https://nigerianbanks.xyz/logo/${slug}.png` : null;
}

export const NIGERIAN_BANKS: NigerianBank[] = [
  { code: '044', name: 'Access Bank', slug: 'access-bank' },
  { code: '058', name: 'GTBank', slug: 'guaranty-trust-bank' },
  { code: '011', name: 'First Bank', slug: 'first-bank-of-nigeria' },
  { code: '057', name: 'Zenith Bank', slug: 'zenith-bank' },
  { code: '033', name: 'UBA', slug: 'united-bank-for-africa' },
  { code: '090267', name: 'Kuda Microfinance Bank', slug: 'kuda-bank' },
  { code: '100004', name: 'OPay', slug: 'paycom' },
  { code: '100033', name: 'PalmPay', slug: 'palmpay' },
  { code: '090405', name: 'Moniepoint MFB', slug: 'moniepoint-mfb-ng' },
  { code: '035', name: 'Wema Bank', slug: 'wema-bank' },
  { code: '232', name: 'Sterling Bank', slug: 'sterling-bank' },
  { code: '070', name: 'Fidelity Bank', slug: 'fidelity-bank' },
  { code: '214', name: 'FCMB', slug: 'first-city-monument-bank' },
  { code: '039', name: 'Stanbic IBTC', slug: 'stanbic-ibtc-bank' },
  { code: '076', name: 'Polaris Bank', slug: 'polaris-bank' },
];

export function bankName(code: string): string {
  return NIGERIAN_BANKS.find((b) => b.code === code)?.name ?? code;
}

/** The logo slug for a payout code, or undefined when we have no mark for it. */
export function bankSlug(code: string): string | undefined {
  return NIGERIAN_BANKS.find((b) => b.code === code)?.slug;
}

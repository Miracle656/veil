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
  /** What the POPULAR chip says. Chips are narrow; "Kuda" fits, the legal name does not. */
  short?: string;
  /** Shown as a chip when the search box is empty. */
  popular?: boolean;
  /**
   * Overrides the derived badge letters.
   *
   * The rule below reads initials off the words, which is right for almost
   * everything — "First Bank of Nigeria" gives FB, "First City Monument Bank"
   * gives FC. A single-word name gives one letter, and GTBank is the one that
   * wants two.
   */
  badge?: string;
}

/** Up to two letters for the disc behind a bank with no logo. */
export function bankInitials(bank: { name: string; short?: string; badge?: string }): string {
  if (bank.badge) return bank.badge;
  const words = (bank.short ?? bank.name).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

/** Where a bank's mark is served from. Undefined slug means the lettered fallback. */
export function bankLogoUrl(slug?: string): string | null {
  return slug ? `https://nigerianbanks.xyz/logo/${slug}.png` : null;
}

export const NIGERIAN_BANKS: NigerianBank[] = [
  { code: '044', name: 'Access Bank', slug: 'access-bank', short: 'Access', popular: true },
  { code: '058', name: 'GTBank', slug: 'guaranty-trust-bank', short: 'GTBank', badge: 'GT', popular: true },
  { code: '011', name: 'First Bank', slug: 'first-bank-of-nigeria' },
  { code: '057', name: 'Zenith Bank', slug: 'zenith-bank' },
  { code: '033', name: 'UBA', slug: 'united-bank-for-africa' },
  { code: '090267', name: 'Kuda Microfinance Bank', slug: 'kuda-bank', short: 'Kuda', popular: true },
  { code: '100004', name: 'OPay', slug: 'paycom', short: 'OPay', popular: true },
  { code: '100033', name: 'PalmPay', slug: 'palmpay', short: 'PalmPay', popular: true },
  { code: '090405', name: 'Moniepoint MFB', slug: 'moniepoint-mfb-ng', short: 'Moniepoint', popular: true },
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

/** The six offered as chips before anyone types, in the order the design shows. */
export const POPULAR_BANKS: NigerianBank[] = NIGERIAN_BANKS.filter((b) => b.popular);

/**
 * Split a bank name around the matched run so the typed part can be bolded.
 *
 * The design highlights what you typed inside the result — "**Fir**st Bank of
 * Nigeria" — which is what makes a two-letter query legible at a glance. The
 * match is case-insensitive, but the ORIGINAL casing is kept in the output:
 * slicing the lowercased copy would print "fir" over the bank's real name.
 */
export function highlight(name: string, query: string): { text: string; hit: boolean }[] {
  if (!query) return [{ text: name, hit: false }];
  const at = name.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return [{ text: name, hit: false }];
  return [
    { text: name.slice(0, at), hit: false },
    { text: name.slice(at, at + query.length), hit: true },
    { text: name.slice(at + query.length), hit: false },
  ].filter((p) => p.text !== '');
}

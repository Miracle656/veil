/**
 * The dApp allow-list — the one source of truth for dApp discovery in Veil.
 *
 * Both apps render this exact module:
 *
 *   - Web  — `frontend/wallet/app/dapps/page.tsx` (directory screen; every
 *     entry opens in a NEW TAB, never embedded).
 *   - Mobile — `frontend/mobile/app/dapps.tsx` (discovery screen; entries open
 *     outside the wallet).
 *
 * Because there is only one list, adding a dApp is a single edit to this file
 * and the two apps can never drift apart — `tests/dappParity.test.ts` in the
 * web wallet fails if either app stops reading from here or a second copy of
 * the directory appears anywhere under `frontend/`.
 *
 * Parity means discovery, not embedding: a browser inside the wallet adds a
 * signing surface with none of the isolation, so every entry below is an HTTPS
 * origin and that is the only thing either app is ever allowed to open.
 */

/** One curated dApp entry. */
export type DappEntry = {
  /** Stable key, unique across the directory — used as the render/test handle. */
  id: string;
  /** Display name shown in both apps. */
  name: string;
  /** One short line describing what the dApp does. */
  description: string;
  /**
   * HTTPS origin (scheme + host, no path). This is the only URL either app
   * will navigate to for this entry — the web wallet opens it in a new tab,
   * the mobile app hands it to the system browser.
   */
  origin: string;
};

/**
 * The curated directory.
 *
 * Adding a dApp = appending one entry here. Nothing else in either app needs
 * to change: both screens map over this array.
 */
export const DAPP_DIRECTORY: readonly DappEntry[] = [
  {
    id: 'stellarx',
    name: 'StellarX',
    origin: 'https://stellarx.com',
    description: 'Decentralized exchange for Stellar — trade tokens, stocks and fiat with no trading fees.',
  },
  {
    id: 'aquarius',
    name: 'Aquarius',
    origin: 'https://aqua.network',
    description: "Stellar's DeFi hub — swap, provide liquidity, earn rewards and vote on AQUA governance.",
  },
  {
    id: 'sonar',
    name: 'Sonar',
    origin: 'https://sonar.xyz',
    description: 'Lend, borrow and supply on Blend — the lending markets built on Stellar.',
  },
  {
    id: 'soroswap',
    name: 'Soroswap',
    origin: 'https://soroswap.finance',
    description: 'Open-source AMM on Stellar — swap assets and provide liquidity.',
  },
  {
    id: 'stellarexpert',
    name: 'StellarExpert',
    origin: 'https://stellarexpert.com',
    description: 'Block explorer and analytics for Stellar accounts, transactions and assets.',
  },
];

/**
 * Normalize a URL down to its canonical `https://host` origin, or `null` when
 * it is not a well-formed HTTPS origin.
 *
 * Deliberately regex-based rather than `new URL(...)`: this module runs in the
 * browser, under Jest, and in React Native's Hermes — where the `URL` global
 * has historically been incomplete — and the allow-list decision must behave
 * identically in all three.
 *
 * Canonicalisation lowercases the host and drops a leading `www.` so a redirect
 * from the bare domain to `www.` (or back) cannot slip past the allow-list.
 */
export function normalizeDappOrigin(value: string): string | null {
  const match = /^https:\/\/([^/?#]+)/i.exec(value.trim());
  if (!match) return null;

  const host = match[1].toLowerCase();
  // A bare hostname[:port] only — this rejects userinfo (`https://evil@host`)
  // and anything with embedded whitespace or credentials.
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(host)) return null;

  const canonical = host.replace(/^www\./, '');
  // Require a dotted host: `https://evil` / `https://localhost` are not
  // origins this directory will ever hold.
  if (!canonical.includes('.')) return null;

  return `https://${canonical}`;
}

/**
 * Whether `value` names an origin this directory allow-lists.
 *
 * Scheme-sensitive: `http://` is refused even for an allow-listed host, and a
 * look-alike host (`https://stellarx.com.evil.example`) never matches.
 */
export function isAllowedDappOrigin(value: string): boolean {
  const origin = normalizeDappOrigin(value);
  if (!origin) return false;
  return DAPP_DIRECTORY.some((entry) => normalizeDappOrigin(entry.origin) === origin);
}

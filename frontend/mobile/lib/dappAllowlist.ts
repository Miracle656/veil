/**
 * The curated allow-list of Stellar dApps Veil can open in its in-app browser.
 *
 * One module is the source of truth for two things that must not drift apart:
 *
 *   1. the set of origins the browser shell is *allowed* to load (V211), and
 *   2. the directory the user browses to pick one (V212).
 *
 * The directory reads {@link DAPP_ALLOWLIST} directly rather than keeping its
 * own copy, so adding a dApp is a single edit and there is no second list to
 * fall behind.
 *
 * Everything here is pure string handling with no React Native or Expo
 * imports, so it can be unit-tested directly and reused by the web wallet's
 * directory (V218).
 *
 * Security notes
 * --------------
 * - An entry's `origin` is an *origin*, not a URL: scheme + host (+ port), with
 *   no path, query or credentials. {@link normalizeOrigin} enforces that.
 * - Only `https` is accepted. A page that redirects to `http://` is refused,
 *   even for a host that is allow-listed — plaintext is not a browse surface
 *   inside a wallet.
 * - A URL carrying userinfo (`https://evil.example@app.soroswap.finance`) is
 *   rejected rather than resolved, so a look-alike cannot masquerade as a
 *   listed host.
 */

/** Coarse grouping shown on each directory row and used by the search filter. */
export type DappCategory =
  | 'Swap'
  | 'Trade'
  | 'Lend'
  | 'Bridge'
  | 'Wallet'
  | 'Tools'
  | 'Learn';

/** One dApp the browser is allowed to open. */
export type DappEntry = {
  /** Stable slug, used as a React key and in test output. */
  id: string;
  /** Display name. */
  name: string;
  /** Canonical `https://` origin — the exact place the browser opens. */
  origin: string;
  /** Square icon URL; the UI falls back to a monogram if it cannot load. */
  icon: string;
  /** One line describing what the dApp is for. */
  description: string;
  /** Coarse grouping. */
  category: DappCategory;
};

/**
 * The allow-list. Every origin here is loaded only over HTTPS, and the browser
 * shell refuses anything absent from this list — including via a redirect.
 */
export const DAPP_ALLOWLIST: readonly DappEntry[] = [
  {
    id: 'soroswap',
    name: 'Soroswap',
    origin: 'https://app.soroswap.finance',
    icon: 'https://app.soroswap.finance/favicon.ico',
    description: 'Swap Stellar assets through an on-chain automated market maker.',
    category: 'Swap',
  },
  {
    id: 'stellarterm',
    name: 'StellarTerm',
    origin: 'https://stellarterm.com',
    icon: 'https://stellarterm.com/favicon.ico',
    description: 'Trade on the Stellar decentralized exchange from the browser.',
    category: 'Trade',
  },
  {
    id: 'stellarx',
    name: 'StellarX',
    origin: 'https://www.stellarx.com',
    icon: 'https://www.stellarx.com/favicon.ico',
    description: 'A full-featured trading interface for Stellar assets.',
    category: 'Trade',
  },
  {
    id: 'lobstr',
    name: 'LOBSTR',
    origin: 'https://lobstr.co',
    icon: 'https://lobstr.co/favicon.ico',
    description: 'A popular Stellar wallet and exchange front end.',
    category: 'Wallet',
  },
  {
    id: 'aqua',
    name: 'Aqua',
    origin: 'https://aqua.network',
    icon: 'https://aqua.network/favicon.ico',
    description: 'Provide liquidity and vote on the Aqua community treasury.',
    category: 'Lend',
  },
  {
    id: 'allbridge',
    name: 'Allbridge',
    origin: 'https://app.allbridge.io',
    icon: 'https://app.allbridge.io/favicon.ico',
    description: 'Bridge assets between Stellar and other networks.',
    category: 'Bridge',
  },
  {
    id: 'stellar-laboratory',
    name: 'Stellar Laboratory',
    origin: 'https://laboratory.stellar.org',
    icon: 'https://laboratory.stellar.org/favicon.ico',
    description: 'Build and inspect transactions with the official Stellar tooling.',
    category: 'Tools',
  },
  {
    id: 'stellar-quest',
    name: 'Stellar Quest',
    origin: 'https://quest.stellar.org',
    icon: 'https://quest.stellar.org/favicon.ico',
    description: 'Learn Soroban and Stellar by completing guided challenges.',
    category: 'Learn',
  },
] as const;

/** Every allow-listed origin, for O(1) membership checks. */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(
  DAPP_ALLOWLIST.map((entry) => entry.origin),
);

/**
 * Normalise a URL to its HTTPS origin, or return `null` when it is not one we
 * are willing to load.
 *
 * An origin is `https://host[:port]` with the port omitted when it is the
 * default 443. Everything else — a path, a query, a fragment, credentials, a
 * non-HTTPS scheme, a malformed authority — is refused.
 */
export function normalizeOrigin(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // Bound the input before touching it; a real dApp URL never approaches this.
  if (!trimmed || trimmed.length > 2048) return null;

  const match = /^(https?):\/\/([^/?#]+)/i.exec(trimmed);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  // Only HTTPS. Plaintext would expose the session, and the point of the shell
  // is that a dApp is browsed deliberately over a secure origin.
  if (scheme !== 'https') return null;

  const authority = match[2]!;
  // Credentials (`user@host`) and whitespace/backslashes are never valid here.
  if (authority.includes('@') || /[\s\\]/.test(authority)) return null;

  // Split off an explicit port. IP-literal hosts are not relevant to this list.
  let host = authority;
  let port = '';
  const colon = authority.lastIndexOf(':');
  if (colon !== -1) {
    host = authority.slice(0, colon);
    port = authority.slice(colon + 1);
    if (!/^\d+$/.test(port) || Number(port) > 65535) return null;
  }

  host = host.toLowerCase();
  // A host is dot-separated labels of letters, digits and hyphens.
  if (!host || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
    return null;
  }

  return port && port !== '443' ? `https://${host}:${port}` : `https://${host}`;
}

/** True when `raw` resolves to an origin on the allow-list. */
export function isAllowedDappUrl(raw: string): boolean {
  const origin = normalizeOrigin(raw);
  return origin !== null && ALLOWED_ORIGINS.has(origin);
}

/**
 * The canonical allow-listed origin for `raw`, or `null` when it is not on the
 * list. The browser shell loads only what this returns.
 */
export function allowedOriginOf(raw: string): string | null {
  const origin = normalizeOrigin(raw);
  return origin !== null && ALLOWED_ORIGINS.has(origin) ? origin : null;
}

/** The allow-list entry for a URL or origin, or `undefined` when not listed. */
export function getDappForUrl(raw: string): DappEntry | undefined {
  const origin = normalizeOrigin(raw);
  if (origin === null) return undefined;
  return DAPP_ALLOWLIST.find((entry) => entry.origin === origin);
}

/** The allow-list entry whose origin is exactly `origin`, normalised first. */
export function getDappByOrigin(origin: string): DappEntry | undefined {
  return getDappForUrl(origin);
}

/**
 * Filter the directory by a free-text query.
 *
 * Matches the dApp name or its category, case-insensitively. A blank query
 * returns the whole list, and a query that matches nothing returns an empty
 * array — which is what the screen renders as its empty state.
 */
export function filterDapps(query: string): DappEntry[] {
  const needle = (query ?? '').trim().toLowerCase();
  if (!needle) return [...DAPP_ALLOWLIST];
  return DAPP_ALLOWLIST.filter(
    (entry) =>
      entry.name.toLowerCase().includes(needle) ||
      entry.category.toLowerCase().includes(needle),
  );
}

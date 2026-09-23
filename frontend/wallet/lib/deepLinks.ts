/**
 * Inbound deep-link resolution for the Veil web wallet.
 *
 * Three families of URL can reach the wallet:
 *   1. `veil://pay?...`                  custom scheme
 *   2. `https://app.useveilapp.xyz/pay?...` web / app link
 *   3. `web+stellar:pay?destination=...` SEP-7 payment request
 *
 * Security requirements (#704):
 *   - Parse and carry asset_issuer through deep links.
 *   - Match assets on code AND issuer (Asset resolution requires code + issuer).
 *   - When a link names an asset the wallet cannot resolve to a specific issuer,
 *     say so rather than picking one.
 */

export const DEEP_LINK_SCHEME = 'veil';
export const ASSOCIATED_DOMAINS = ['app.useveilapp.xyz'] as const;
export const SEP7_SCHEME = 'web+stellar';
export const FALLBACK_ROUTE = '/';
export const MAX_DEEP_LINK_LENGTH = 7168;

/** Routes reachable from outside the app, and the query parameters each one accepts. */
export const LINKABLE_ROUTES: Record<string, readonly string[]> = {
  '/pay': ['to', 'amount', 'asset', 'asset_issuer', 'memo', 'msg', 'uri'],
  '/send': ['to', 'amount', 'asset', 'asset_issuer', 'memo'],
  '/receive': ['amount', 'asset', 'asset_issuer'],
  '/create-wallet': [],
};

const PATH_ALIASES: Record<string, string> = {
  '': '/',
  '/': '/',
  '/request': '/receive',
  '/payment-request': '/pay',
};

const SEP7_PARAM_MAP: Record<string, string> = {
  destination: 'to',
  amount: 'amount',
  asset_code: 'asset',
  asset_issuer: 'asset_issuer',
  memo: 'memo',
  msg: 'msg',
};

export type DeepLinkContext = {
  initial?: boolean;
};

export interface ResolvableAssetHolding {
  code: string;
  issuer: string | null;
  balance?: string;
  name?: string;
  native?: boolean;
}

export type AssetResolutionResult =
  | { status: 'none' }
  | { status: 'resolved'; asset: ResolvableAssetHolding }
  | { status: 'unresolved'; code: string; issuer?: string; error: string };

/**
 * Match a requested asset from a deep link or SEP-7 URI against a wallet's holdings.
 *
 * Security requirement (#704):
 * Asset resolution requires code + issuer.
 * Anyone on Stellar can issue an asset with code "USDC", so a link naming "USDC"
 * without an issuer must NOT resolve to whatever USDC the wallet happens to hold.
 * When a link names an asset the wallet cannot resolve to a specific issuer,
 * we return an unresolved status with an explicit error rather than picking an arbitrary holding.
 */
export function resolvePaymentAsset(
  params: { asset?: string; asset_issuer?: string },
  holdings: ResolvableAssetHolding[]
): AssetResolutionResult {
  const code = params.asset?.trim();
  const issuer = params.asset_issuer?.trim();

  if (!code) {
    return { status: 'none' };
  }

  const upperCode = code.toUpperCase();

  // Native XLM has no issuer on Stellar.
  if (upperCode === 'XLM' && (!issuer || issuer.toLowerCase() === 'native')) {
    const nativeHolding = holdings.find((h) => h.code.toUpperCase() === 'XLM' && (!h.issuer || h.native));
    if (nativeHolding) {
      return { status: 'resolved', asset: nativeHolding };
    }
    return { status: 'resolved', asset: { code: 'XLM', issuer: null, native: true } };
  }

  // Non-native asset (or an asset called XLM with an explicit non-native issuer)
  if (!issuer) {
    return {
      status: 'unresolved',
      code,
      error: `Asset ${code} cannot be resolved to a specific issuer. Anyone can issue an asset called ${code}. Please select an asset explicitly.`,
    };
  }

  const matched = holdings.find(
    (h) => h.code.toUpperCase() === upperCode && h.issuer === issuer
  );

  if (!matched) {
    return {
      status: 'unresolved',
      code,
      issuer,
      error: `Unknown issuer ${issuer} for asset ${code}. You do not hold this asset.`,
    };
  }

  return { status: 'resolved', asset: matched };
}

function isAssociatedDomain(host: string): boolean {
  return (ASSOCIATED_DOMAINS as readonly string[]).includes(host.toLowerCase());
}

function splitPathAndQuery(rest: string): { path: string; query: string } {
  const withoutFragment = rest.split('#')[0] ?? '';
  const queryIndex = withoutFragment.indexOf('?');
  return queryIndex === -1
    ? { path: withoutFragment, query: '' }
    : {
        path: withoutFragment.slice(0, queryIndex),
        query: withoutFragment.slice(queryIndex + 1),
      };
}

function normalizePath(path: string): string {
  const decoded = decodeURIComponent(path.trim());
  const trimmed = `/${decoded.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return trimmed === '/' ? '/' : trimmed.toLowerCase();
}

function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

function parseQuery(query: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of query.split('&')) {
    if (!part) continue;
    const equalsIndex = part.indexOf('=');
    const key = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
    const value = equalsIndex === -1 ? '' : part.slice(equalsIndex + 1);
    pairs.push([decodeComponent(key), decodeComponent(value)]);
  }
  return pairs;
}

function buildTarget(route: string, query: string, rename?: Record<string, string>): string {
  const allowed = LINKABLE_ROUTES[route];
  if (!allowed) return FALLBACK_ROUTE;

  const forwarded: Array<[string, string]> = [];
  const seen = new Set<string>();

  for (const [rawKey, value] of parseQuery(query)) {
    const key = rename ? rename[rawKey] : rawKey;
    if (!key || !allowed.includes(key) || seen.has(key)) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    seen.add(key);
    forwarded.push([key, trimmed]);
  }

  if (forwarded.length === 0) return route;
  const serialized = forwarded
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${route}?${serialized}`;
}

export function resolveDeepLink(url: string, _context: DeepLinkContext = {}): string {
  if (typeof url !== 'string') return FALLBACK_ROUTE;
  const raw = url.trim();
  if (!raw || raw.length > MAX_DEEP_LINK_LENGTH) return FALLBACK_ROUTE;

  try {
    if (raw.startsWith('/')) {
      return resolveInAppPath(raw);
    }

    const schemeEnd = raw.indexOf(':');
    if (schemeEnd === -1) return FALLBACK_ROUTE;
    const scheme = raw.slice(0, schemeEnd).toLowerCase();
    const rest = raw.slice(schemeEnd + 1);

    if (scheme === SEP7_SCHEME) {
      return resolveSep7Uri(rest, raw);
    }

    if (scheme === DEEP_LINK_SCHEME) {
      return resolveInAppPath(rest.replace(/^\/\//, '/'));
    }

    if (scheme === 'https' || scheme === 'http') {
      return resolveWebLink(rest);
    }

    return FALLBACK_ROUTE;
  } catch {
    return FALLBACK_ROUTE;
  }
}

function resolveInAppPath(pathAndQuery: string): string {
  const { path, query } = splitPathAndQuery(pathAndQuery);
  const normalized = normalizePath(path);
  const route = PATH_ALIASES[normalized] ?? normalized;
  if (!(route in LINKABLE_ROUTES)) return FALLBACK_ROUTE;
  return buildTarget(route, query);
}

function resolveWebLink(rest: string): string {
  const authorityAndPath = rest.replace(/^\/\//, '');
  const slashIndex = authorityAndPath.search(/[/?#]/);
  const authority = slashIndex === -1 ? authorityAndPath : authorityAndPath.slice(0, slashIndex);
  const host = authority.split('@').pop()?.split(':')[0] ?? '';
  if (!isAssociatedDomain(host)) return FALLBACK_ROUTE;

  const pathAndQuery = slashIndex === -1 ? '/' : authorityAndPath.slice(slashIndex);
  return resolveInAppPath(pathAndQuery);
}

function resolveSep7Uri(rest: string, originalUri: string): string {
  const { path, query } = splitPathAndQuery(rest);
  if (path.replace(/^\/+/, '').toLowerCase() !== 'pay') return FALLBACK_ROUTE;

  const target = buildTarget('/pay', query, SEP7_PARAM_MAP);
  const separator = target.includes('?') ? '&' : '?';
  return `${target}${separator}uri=${encodeURIComponent(originalUri)}`;
}

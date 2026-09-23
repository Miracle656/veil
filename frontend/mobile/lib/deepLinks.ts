/**
 * Inbound deep-link resolution for the Veil mobile app.
 *
 * Three families of URL reach the app, and all three must land on the same
 * in-app routes whether the app was cold-started by the link or was already
 * running in the background (warm resume):
 *
 *   1. `veil://pay?...`                  custom scheme (app.config.ts `scheme`)
 *   2. `https://app.veil.xyz/pay?...`    iOS universal link / Android app link
 *   3. `web+stellar:pay?destination=...` SEP-7 payment request
 *
 * Everything here is pure string handling with no React Native or Expo imports,
 * so it can be unit-tested directly and reused by the SEP-7 handler in
 * backlog #38.
 *
 * Inbound links are untrusted input: any app, web page, or QR code can send one.
 * {@link resolveDeepLink} therefore never echoes an arbitrary path back to the
 * router — it matches against a fixed allowlist of routes and copies only known
 * query parameters, falling back to the home route for anything unrecognised.
 */

/** Custom URL scheme registered by the app (kept in sync with `app.config.ts`). */
export const DEEP_LINK_SCHEME = 'veil';

/** Hosts whose `https://` links are claimed as universal / app links. */
export const ASSOCIATED_DOMAINS = ['app.useveilapp.xyz'] as const;

/** SEP-7 URI scheme, without the trailing colon. */
export const SEP7_SCHEME = 'web+stellar';

/** Route used whenever a link is missing, malformed, or unrecognised. */
export const FALLBACK_ROUTE = '/';

/**
 * Hard cap on the length of an inbound URL. SEP-7 caps its URIs at 7168 chars;
 * anything past that is not a real request and is rejected without parsing.
 */
export const MAX_DEEP_LINK_LENGTH = 7168;

/**
 * Routes reachable from outside the app, and the query parameters each one
 * accepts. Parameters outside this list are dropped rather than forwarded, so a
 * crafted link cannot smuggle state into a screen that never expected it.
 */
const LINKABLE_ROUTES: Record<string, readonly string[]> = {
  '/pay': ['to', 'amount', 'asset', 'asset_issuer', 'memo', 'msg', 'uri'],
  '/send': ['to', 'amount', 'asset', 'asset_issuer', 'memo'],
  '/receive': ['amount', 'asset', 'asset_issuer'],
  '/create-wallet': [],
};

/** Aliases for paths that read naturally in a shared link but are not routes. */
const PATH_ALIASES: Record<string, string> = {
  '': '/',
  '/': '/',
  '/request': '/receive',
  '/payment-request': '/pay',
};

/**
 * SEP-7 `pay` field names mapped onto the query parameters the `/pay` route
 * understands. Full validation of the URI (address checksums, amount ranges,
 * hostile callbacks) belongs to the SEP-7 handler in backlog #38 — this mapping
 * only decides *where* the link goes, and the raw URI is forwarded as `uri` so
 * that handler can re-parse the original, unmodified request.
 */
const SEP7_PARAM_MAP: Record<string, string> = {
  destination: 'to',
  amount: 'amount',
  asset_code: 'asset',
  asset_issuer: 'asset_issuer',
  memo: 'memo',
  msg: 'msg',
};

/** Context supplied by expo-router when it hands the app an inbound link. */
export type DeepLinkContext = {
  /**
   * True when the link cold-started the app, false on a warm resume. Resolution
   * is identical for both — the flag is threaded through only so callers can
   * distinguish the two when logging.
   */
  initial?: boolean;
};

function isAssociatedDomain(host: string): boolean {
  return (ASSOCIATED_DOMAINS as readonly string[]).includes(host.toLowerCase());
}

/**
 * Split a URL into its path and query without using the `URL` constructor,
 * which rejects non-special schemes like `web+stellar:` inconsistently across
 * Hermes, Node, and browsers.
 */
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

/** Normalise a raw path to a single leading slash and no trailing slash. */
function normalizePath(path: string): string {
  const decoded = decodeURIComponent(path.trim());
  const trimmed = `/${decoded.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return trimmed === '/' ? '/' : trimmed.toLowerCase();
}

/**
 * Decode one query component. React Native's own `URLSearchParams` is a stub
 * whose accessors throw, so query strings are parsed by hand here rather than
 * depending on which polyfill happens to be installed at launch time.
 */
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    // A malformed percent-escape is not worth discarding the whole link over.
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
    // First occurrence wins; a repeated key must not overwrite it.
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

/**
 * Resolve an inbound URL to an in-app route.
 *
 * Always returns a path the router can navigate to; unrecognised, malformed, or
 * foreign links resolve to {@link FALLBACK_ROUTE} rather than throwing, because
 * a throw here happens during launch and would take the app down with it.
 *
 * @example
 * resolveDeepLink('veil://pay?to=GABC&amount=10')          // '/pay?to=GABC&amount=10'
 * resolveDeepLink('https://app.veil.xyz/receive')          // '/receive'
 * resolveDeepLink('web+stellar:pay?destination=GABC')      // '/pay?to=GABC&uri=…'
 * resolveDeepLink('https://evil.example/pay')              // '/'
 */
export function resolveDeepLink(url: string, _context: DeepLinkContext = {}): string {
  if (typeof url !== 'string') return FALLBACK_ROUTE;
  const raw = url.trim();
  if (!raw || raw.length > MAX_DEEP_LINK_LENGTH) return FALLBACK_ROUTE;

  try {
    // expo-router hands `+native-intent` an already-stripped path (e.g. `/pay?x=1`)
    // when the link matched the app's own scheme, so accept that shape too.
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
      // `veil://pay?x=1` and the host-less `veil:pay?x=1` are both valid.
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
  // `rest` is everything after `https:` — strip the `//` and peel off the host.
  const authorityAndPath = rest.replace(/^\/\//, '');
  const slashIndex = authorityAndPath.search(/[/?#]/);
  const authority = slashIndex === -1 ? authorityAndPath : authorityAndPath.slice(0, slashIndex);
  // Drop any userinfo (`user@host`) and port so `evil.com@app.veil.xyz` cannot
  // masquerade as an associated domain.
  const host = authority.split('@').pop()?.split(':')[0] ?? '';
  if (!isAssociatedDomain(host)) return FALLBACK_ROUTE;

  const pathAndQuery = slashIndex === -1 ? '/' : authorityAndPath.slice(slashIndex);
  return resolveInAppPath(pathAndQuery);
}

function resolveSep7Uri(rest: string, originalUri: string): string {
  const { path, query } = splitPathAndQuery(rest);
  // SEP-7 puts the operation where a path would go: `web+stellar:pay?…`.
  if (path.replace(/^\/+/, '').toLowerCase() !== 'pay') return FALLBACK_ROUTE;

  const target = buildTarget('/pay', query, SEP7_PARAM_MAP);
  const separator = target.includes('?') ? '&' : '?';
  return `${target}${separator}uri=${encodeURIComponent(originalUri)}`;
}

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


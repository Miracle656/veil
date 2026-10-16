/**
 * Per-origin dApp permissions: what each site has been allowed to do, when it
 * was allowed, and a way to take that back.
 *
 * WalletConnect already has an equivalent shape — `getWalletConnectSessions()`
 * in `lib/walletConnect.ts` — because a WalletConnect session is negotiated and
 * named. A page in the dApp browser is not: it is just an origin, it can ask at
 * any moment, and nothing about loading it implies anything. So the grant has to
 * be per-origin and per-capability, and revocable without touching the page.
 *
 * Two rules shape everything here.
 *
 * **Grants are per-origin, never global.** `https://swap.example` and
 * `https://pay.example` are different origins and get different records, even
 * one inside the other. An origin is normalised with {@link normalizeOrigin}
 * before it is ever used as a key, so `https://Example.com:443/a` and
 * `https://example.com` cannot end up as two grants for what the browser
 * considers one site.
 *
 * **Revocation is immediate, not on next load.** The authoritative copy is the
 * module-level map below, and every check reads it synchronously. Persisting to
 * AsyncStorage is a background write; a page already open in the browser is
 * holding a reference to this module, so a revoke from Settings takes effect on
 * that page's very next call rather than after a restart. The subscribers are
 * what make the settings list and any open prompt re-render on a change.
 *
 * This module never signs anything. Signing stays in `signXdrPayload()`
 * (`lib/walletConnect.ts`), which is the only implementation of the
 * `__check_auth` ceremony; a caller gates on {@link isOriginPermissionGranted}
 * first and then routes the request through there.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** AsyncStorage key holding the per-origin grant list. */
export const ORIGIN_PERMISSIONS_STORAGE_KEY = 'veil_origin_permissions';

/**
 * What a dApp origin can be allowed to do. Deliberately two, and deliberately
 * separate: "you may show my address" is a much smaller ask than "you may ask
 * me to sign", and a user who is fine with the first is not automatically
 * fine with the second.
 */
export type PermissionScope = 'address_disclosure' | 'transaction_signing';

/** Every scope, in the order the settings screen lists them. */
export const PERMISSION_SCOPES: readonly PermissionScope[] = [
  'address_disclosure',
  'transaction_signing',
];

/** Human-readable scope names for prompts and the settings list. */
export const PERMISSION_SCOPE_LABELS: Record<PermissionScope, string> = {
  address_disclosure: 'View your address',
  transaction_signing: 'Request signatures',
};

/**
 * What a user should be told before approving a scope — the reason the prompt
 * exists at all. Shown next to the scope name so the grant is an informed one.
 */
export const PERMISSION_SCOPE_DESCRIPTIONS: Record<PermissionScope, string> = {
  address_disclosure: 'Can see your wallet address and network.',
  transaction_signing: 'Can ask you to approve transactions. Each one still needs your passkey.',
};

/** One scope granted to one origin. */
export type ScopeGrant = {
  scope: PermissionScope;
  /** Epoch milliseconds the user granted it. */
  grantedAt: number;
};

/**
 * Everything granted to a single origin.
 *
 * `name` is whatever the page called itself at grant time. It is display-only:
 * a page can name itself anything, so the origin is always shown beside it and
 * is what the grant is actually keyed on.
 */
export type OriginGrant = {
  /** Normalised origin, e.g. `https://swap.example`. */
  origin: string;
  /** Display name reported by the page, when it gave one. */
  name?: string;
  /** Grants held by this origin, one per granted scope. */
  grants: ScopeGrant[];
};

// ── Origin normalisation ──────────────────────────────────────────────────────

/**
 * Reduce a page URL to the origin the browser would use as its security
 * boundary, or `null` when the input is not a usable web origin.
 *
 * Scheme, host and non-default port only — path, query, fragment, credentials
 * and the default port are all dropped, because the browser treats
 * `https://example.com/a` and `https://example.com/b` as one origin for
 * permission purposes. Anything that is not `http:`/`https:` is rejected: a
 * `javascript:`, `data:` or custom-scheme URL is not a site the user visited,
 * and giving it a grant record would be inventing a permission boundary that
 * does not exist.
 *
 * The host is lowercased here rather than trusted from the parser: React
 * Native's `URL` is a polyfill and does not normalise case the way a browser
 * does, so `https://Example.com` and `https://example.com` would otherwise
 * become two separate grants for one site — and the second would be
 * unreachable from the list that is supposed to revoke it.
 */
export function normalizeOrigin(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    // A bare host ("example.com") is a real thing for a page to report as its
    // own origin, so it is tried as a host before being rejected.
    url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.hostname) return null;

  // The polyfill drops the default port for these two schemes, so `host` is
  // the whole serialised origin apart from case.
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Narrow an arbitrary value to a known scope. */
export function isPermissionScope(value: unknown): value is PermissionScope {
  return value === 'address_disclosure' || value === 'transaction_signing';
}

/**
 * Coerce a stored grant list back into a valid one.
 *
 * Corrupt or hand-edited storage must never crash the app or, worse, be read as
 * a grant the user did not give: anything unrecognised is dropped, and a grant
 * with no scopes left is dropped entirely.
 */
function parseGrants(raw: unknown): OriginGrant[] {
  if (!Array.isArray(raw)) return [];
  const grants: OriginGrant[] = [];

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Partial<OriginGrant>;
    const origin = typeof candidate.origin === 'string' ? normalizeOrigin(candidate.origin) : null;
    if (!origin) continue;
    if (!Array.isArray(candidate.grants)) continue;

    const seen = new Set<PermissionScope>();
    const scopes: ScopeGrant[] = [];
    for (const grant of candidate.grants) {
      if (typeof grant !== 'object' || grant === null) continue;
      const { scope, grantedAt } = grant as Partial<ScopeGrant>;
      if (!isPermissionScope(scope) || seen.has(scope)) continue;
      if (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) continue;
      seen.add(scope);
      scopes.push({ scope, grantedAt });
    }
    if (scopes.length === 0) continue;

    const name = typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : undefined;
    grants.push({ origin, name, grants: scopes });
  }

  return grants;
}

// ── State ─────────────────────────────────────────────────────────────────────

let byOrigin = new Map<string, OriginGrant>();
let hydrated = false;
const listeners = new Set<() => void>();

/** Snapshot for `useSyncExternalStore`; replaced only when the grants change. */
let snapshot: OriginGrant[] = [];

function publish(): void {
  snapshot = [...byOrigin.values()].sort((a, b) => {
    const aAt = a.grants[0]?.grantedAt ?? 0;
    const bAt = b.grants[0]?.grantedAt ?? 0;
    return bAt - aAt;
  });
  for (const listener of listeners) listener();
}

async function persist(): Promise<void> {
  await AsyncStorage.setItem(ORIGIN_PERMISSIONS_STORAGE_KEY, JSON.stringify([...byOrigin.values()]));
}

// ── Reads ─────────────────────────────────────────────────────────────────────

/** Every origin holding at least one grant, most recently granted first. */
export function getOriginGrants(): OriginGrant[] {
  return snapshot;
}

/** The grants held by one origin, or `null` when it holds none. */
export function getOriginGrant(origin: string): OriginGrant | null {
  const key = normalizeOrigin(origin);
  return key ? (byOrigin.get(key) ?? null) : null;
}

/**
 * Whether `origin` currently holds `scope`.
 *
 * The synchronous read is the point: a dApp bridge calls this on every single
 * request, so a revoke that happened while the page was open is visible to the
 * very next call.
 */
export function isOriginPermissionGranted(origin: string, scope: PermissionScope): boolean {
  const key = normalizeOrigin(origin);
  if (!key) return false;
  return byOrigin.get(key)?.grants.some((grant) => grant.scope === scope) ?? false;
}

/** When `origin` was granted `scope`, or `null` when it was never granted. */
export function getPermissionGrantedAt(origin: string, scope: PermissionScope): number | null {
  const key = normalizeOrigin(origin);
  if (!key) return null;
  return byOrigin.get(key)?.grants.find((grant) => grant.scope === scope)?.grantedAt ?? null;
}

/** Whether stored grants have been read yet. */
export function isOriginPermissionsHydrated(): boolean {
  return hydrated;
}

/**
 * Subscribe to grant changes — a grant, a revoke, or a revoke-all.
 * @returns An unsubscribe function.
 */
export function subscribeToOriginGrants(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ── Hydration ─────────────────────────────────────────────────────────────────

let hydration: Promise<OriginGrant[]> | null = null;

/**
 * Load stored grants. Idempotent: repeated calls share one read.
 *
 * A read failure leaves the store empty rather than propagating — a transient
 * storage error must not crash a screen, and an empty store only ever costs the
 * user a re-prompt.
 */
export function hydrateOriginPermissions(): Promise<OriginGrant[]> {
  hydration ??= AsyncStorage.getItem(ORIGIN_PERMISSIONS_STORAGE_KEY)
    .catch(() => null)
    .then((raw) => {
      if (raw == null) {
        byOrigin = new Map();
      } else {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        byOrigin = new Map(parseGrants(parsed).map((grant) => [grant.origin, grant]));
      }
      hydrated = true;
      publish();
      return snapshot;
    });
  return hydration;
}

// Start reading at import so grants are in place before the first dApp call and
// before the settings screen paints.
void hydrateOriginPermissions();

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Grant one or more scopes to an origin.
 *
 * Applied in memory before it is persisted, so the next call from the page sees
 * the grant immediately and a failed write costs the grant at next launch
 * rather than the interaction now. Re-granting a scope already held updates
 * its `grantedAt` rather than duplicating the record, so "when was this
 * allowed" stays a single answer.
 */
export async function grantOriginPermissions(
  origin: string,
  scopes: readonly PermissionScope[],
  options: { name?: string; grantedAt?: number } = {}
): Promise<OriginGrant> {
  const key = normalizeOrigin(origin);
  if (!key) throw new Error(`Not a grantable origin: ${origin}`);
  if (scopes.length === 0) throw new Error('No scopes to grant.');

  const grantedAt = options.grantedAt ?? Date.now();
  const existing = byOrigin.get(key);
  const merged = new Map<PermissionScope, ScopeGrant>();

  for (const grant of existing?.grants ?? []) merged.set(grant.scope, grant);
  for (const scope of scopes) {
    if (!isPermissionScope(scope)) throw new Error(`Unknown permission scope: ${String(scope)}`);
    merged.set(scope, { scope, grantedAt });
  }

  const name = options.name?.trim() || existing?.name;
  const record: OriginGrant = {
    origin: key,
    ...(name ? { name } : {}),
    grants: PERMISSION_SCOPES.filter((scope) => merged.has(scope)).map(
      (scope) => merged.get(scope) as ScopeGrant
    ),
  };

  byOrigin = new Map(byOrigin).set(key, record);
  publish();
  await persist();
  return record;
}

/**
 * Revoke one scope from an origin, or every scope when `scope` is omitted.
 *
 * The origin's record is removed entirely once its last scope goes, so a
 * revoked origin does not linger in the settings list as an empty row and a
 * later grant starts from a clean `grantedAt`.
 *
 * @returns Whether anything was actually revoked.
 */
export async function revokeOriginPermissions(origin: string, scope?: PermissionScope): Promise<boolean> {
  const key = normalizeOrigin(origin);
  if (!key) return false;
  const existing = byOrigin.get(key);
  if (!existing) return false;

  if (scope === undefined) {
    byOrigin = new Map(byOrigin);
    byOrigin.delete(key);
    publish();
    await persist();
    return true;
  }

  const remaining = existing.grants.filter((grant) => grant.scope !== scope);
  if (remaining.length === existing.grants.length) return false;

  const next = new Map(byOrigin);
  if (remaining.length === 0) {
    next.delete(key);
  } else {
    next.set(key, { ...existing, grants: remaining });
  }
  byOrigin = next;
  publish();
  await persist();
  return true;
}

/**
 * Revoke every origin's every scope. This is the "clear all permissions"
 * escape hatch on the settings screen.
 *
 * @returns How many origins were cleared.
 */
export async function revokeAllOriginPermissions(): Promise<number> {
  const cleared = byOrigin.size;
  if (cleared === 0) return 0;
  byOrigin = new Map();
  publish();
  await persist();
  return cleared;
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Render a `grantedAt` for the settings list.
 *
 * Absolute rather than relative ("3 days ago"): the question this screen
 * answers is "when did I allow this", and a relative label re-renders into
 * something else as the app stays open.
 */
export function formatGrantedAt(grantedAt: number): string {
  const date = new Date(grantedAt);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toISOString().slice(0, 10);
}

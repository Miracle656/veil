/**
 * Bootnode URL resolution with automatic fallback (#719).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROBLEM
 * ─────────────────────────────────────────────────────────────────────────────
 * SPP note discovery requires a bootnode that holds the full pool event history.
 * Veil runs its own at `EXPO_PUBLIC_SPP_BOOTNODE_URL`, but it may be:
 *   • Not yet deployed (env var unset)
 *   • Temporarily unreachable (network, maintenance, Render suspension)
 *
 * In either case we fall back to Nethermind's public testnet bootnode and
 * notify the user so they can investigate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DESIGN — same proven pattern as rpcFailover.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * `resolveBootnodeWithFallback(primary, fallback?)`:
 *   1. If `primary` is null/empty → return fallback immediately (no probe).
 *   2. HEAD-check `${primary}/healthz` with a 5-second timeout.
 *   3. If the check succeeds (HTTP 200) → return primary (cached).
 *   4. Otherwise → log a console.warn, return fallback (cached).
 *
 * The resolved URL is cached for `CACHE_TTL_MS` (5 minutes) so each
 * note-scan call does not re-probe the endpoint.  The cache is keyed on
 * `primary` so changing the env var (rare — requires a rebuild) is handled
 * correctly.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * ```ts
 * import { resolveBootnodeUrl } from '@/lib/privacy/config'
 * import { resolveBootnodeWithFallback, getBootnodeStatus } from '@/lib/privacy/bootnode'
 *
 * const bootnodeUrl = await resolveBootnodeWithFallback(resolveBootnodeUrl())
 * // Pass bootnodeUrl to the SPP SDK as sppClient({ bootnodeUrl, ... })
 *
 * // To display the fallback banner in the UI:
 * const { usingFallback, reason } = getBootnodeStatus()
 * ```
 */

const FALLBACK_BOOTNODE_URL = 'https://bootnode.dev-nethermind.xyz';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const PROBE_TIMEOUT_MS = 5_000;

interface CacheEntry {
  url: string;
  usingFallback: boolean;
  reason: string | null;
  resolvedAt: number;
}

const cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Bootnode status (for UI banners)
// ---------------------------------------------------------------------------

export interface BootnodeStatus {
  /** The URL that will actually be used. */
  url: string;
  /** True when the primary is down and we are using Nethermind's bootnode. */
  usingFallback: boolean;
  /** Human-readable reason string, or null when the primary is healthy. */
  reason: string | null;
}

let _lastStatus: BootnodeStatus = {
  url: FALLBACK_BOOTNODE_URL,
  usingFallback: false,
  reason: null,
};

/**
 * Return the status from the most recent `resolveBootnodeWithFallback` call.
 * Suitable for driving a UI banner without triggering another network probe.
 */
export function getBootnodeStatus(): BootnodeStatus {
  return { ..._lastStatus };
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

async function probeHealthz(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const endpoint = `${url.replace(/\/$/, '')}/healthz`;
  try {
    const res = await fetchImpl(endpoint, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the bootnode URL to use, probing the primary and falling back to
 * Nethermind's bootnode on failure.
 *
 * @param primary      - Veil's bootnode URL from `resolveBootnodeUrl()`, or null.
 * @param fallback     - Fallback URL (defaults to Nethermind's testnet bootnode).
 * @param fetchImpl    - Optional fetch override for testing.
 */
export async function resolveBootnodeWithFallback(
  primary: string | null,
  fallback: string = FALLBACK_BOOTNODE_URL,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const cacheKey = primary ?? '';
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return cached.url;
  }

  // No primary configured — use fallback immediately (no probe needed).
  if (!primary) {
    const entry: CacheEntry = {
      url: fallback,
      usingFallback: true,
      reason: 'No SPP bootnode configured (EXPO_PUBLIC_SPP_BOOTNODE_URL is unset). Using Nethermind\'s public bootnode.',
      resolvedAt: Date.now(),
    };
    cache.set(cacheKey, entry);
    _lastStatus = { url: fallback, usingFallback: true, reason: entry.reason };
    console.warn(`[privacy] ${entry.reason}`);
    return fallback;
  }

  // Probe the primary.
  const healthy = await probeHealthz(primary, fetchImpl);

  if (healthy) {
    const entry: CacheEntry = {
      url: primary,
      usingFallback: false,
      reason: null,
      resolvedAt: Date.now(),
    };
    cache.set(cacheKey, entry);
    _lastStatus = { url: primary, usingFallback: false, reason: null };
    return primary;
  }

  // Primary failed — use fallback and warn.
  const reason = `Primary SPP bootnode (${primary}) is unreachable. Using Nethermind's public bootnode.`;
  console.warn(`[privacy] ${reason}`);

  const entry: CacheEntry = {
    url: fallback,
    usingFallback: true,
    reason,
    resolvedAt: Date.now(),
  };
  cache.set(cacheKey, entry);
  _lastStatus = { url: fallback, usingFallback: true, reason };
  return fallback;
}

/**
 * Invalidate the cached probe result for `primary`.
 * Call this when the user manually retries their sync.
 */
export function invalidateBootnodeCache(primary: string | null = null): void {
  cache.delete(primary ?? '');
}

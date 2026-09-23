/**
 * SPP privacy configuration — mobile app (#719).
 *
 * Mirror of `frontend/wallet/lib/privacy/config.ts` for the Expo / React
 * Native app.  The only difference is the env var prefix: `EXPO_PUBLIC_`
 * instead of `NEXT_PUBLIC_`.
 *
 * Resolution order for the primary bootnode:
 *   1. EXPO_PUBLIC_SPP_BOOTNODE_URL (Veil's own deployed bootnode)
 *   2. null  →  caller falls back to Nethermind's public bootnode
 *
 * Usage:
 *   import { resolveBootnodeUrl } from '@/lib/privacy/config'
 *   import { resolveBootnodeWithFallback } from '@/lib/privacy/bootnode'
 *
 *   const bootnodeUrl = await resolveBootnodeWithFallback(resolveBootnodeUrl())
 *   // Pass to the SPP SDK as sppClient({ bootnodeUrl, ... })
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SppBootnodeConfig {
  /**
   * Veil's own deployed bootnode URL (from EXPO_PUBLIC_SPP_BOOTNODE_URL).
   * `null` when the env var is not set — caller should use the fallback.
   */
  primary: string | null;
  /**
   * Nethermind's public testnet bootnode.  Always available as last resort.
   */
  fallback: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Nethermind's public SPP testnet bootnode. */
export const NETHERMIND_BOOTNODE_URL = 'https://bootnode.dev-nethermind.xyz';

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/**
 * Return the full bootnode config.
 *
 * Expo bakes `EXPO_PUBLIC_*` variables into the JS bundle at build time,
 * matching Next.js's `NEXT_PUBLIC_*` semantics — both are safe to read in
 * client-side code.
 */
export function getSppBootnodeConfig(): SppBootnodeConfig {
  const primary =
    process.env['EXPO_PUBLIC_SPP_BOOTNODE_URL']?.trim() || null;
  return {
    primary,
    fallback: NETHERMIND_BOOTNODE_URL,
  };
}

/**
 * Convenience: the primary bootnode URL or null.
 * Pass to `resolveBootnodeWithFallback()` before using.
 */
export function resolveBootnodeUrl(): string | null {
  return getSppBootnodeConfig().primary;
}

// ---------------------------------------------------------------------------
// Bootnode status (for React Native UI)
// ---------------------------------------------------------------------------

export interface BootnodeStatus {
  url: string;
  usingFallback: boolean;
  reason: string | null;
}

const CACHE_TTL_MS = 5 * 60 * 1_000; // 5 minutes
const PROBE_TIMEOUT_MS = 5_000;

interface CacheEntry extends BootnodeStatus {
  resolvedAt: number;
}

const cache = new Map<string, CacheEntry>();

let _lastStatus: BootnodeStatus = {
  url: NETHERMIND_BOOTNODE_URL,
  usingFallback: false,
  reason: null,
};

export function getBootnodeStatus(): BootnodeStatus {
  return { ..._lastStatus };
}

async function probeHealthz(url: string): Promise<boolean> {
  const endpoint = `${url.replace(/\/$/, '')}/healthz`;
  try {
    const res = await fetch(endpoint, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Resolve the bootnode URL, probing the primary and falling back to
 * Nethermind's bootnode on failure.  Result is cached for 5 minutes.
 *
 * @param primary  - From `resolveBootnodeUrl()`.
 * @param fallback - Defaults to Nethermind's testnet bootnode.
 */
export async function resolveBootnodeWithFallback(
  primary: string | null,
  fallback: string = NETHERMIND_BOOTNODE_URL,
): Promise<string> {
  const cacheKey = primary ?? '';
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS) {
    return cached.url;
  }

  if (!primary) {
    const reason =
      'No SPP bootnode configured (EXPO_PUBLIC_SPP_BOOTNODE_URL is unset). Using Nethermind\'s public bootnode.';
    const entry: CacheEntry = { url: fallback, usingFallback: true, reason, resolvedAt: Date.now() };
    cache.set(cacheKey, entry);
    _lastStatus = { url: fallback, usingFallback: true, reason };
    console.warn(`[privacy] ${reason}`);
    return fallback;
  }

  const healthy = await probeHealthz(primary);
  if (healthy) {
    const entry: CacheEntry = { url: primary, usingFallback: false, reason: null, resolvedAt: Date.now() };
    cache.set(cacheKey, entry);
    _lastStatus = { url: primary, usingFallback: false, reason: null };
    return primary;
  }

  const reason = `Primary SPP bootnode (${primary}) is unreachable. Using Nethermind's public bootnode.`;
  console.warn(`[privacy] ${reason}`);
  const entry: CacheEntry = { url: fallback, usingFallback: true, reason, resolvedAt: Date.now() };
  cache.set(cacheKey, entry);
  _lastStatus = { url: fallback, usingFallback: true, reason };
  return fallback;
}

/** Invalidate the cached probe for `primary`. */
export function invalidateBootnodeCache(primary: string | null = null): void {
  cache.delete(primary ?? '');
}

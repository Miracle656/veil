/**
 * SPP privacy configuration — wallet (#719).
 *
 * Centralises all Stellar Private Payments service URLs in one place so the
 * rest of the codebase never hard-codes bootnode addresses.
 *
 * Resolution order for the primary bootnode:
 *   1. NEXT_PUBLIC_SPP_BOOTNODE_URL (Veil's own deployed bootnode)
 *   2. null  →  caller falls back to Nethermind's public bootnode
 *
 * The Nethermind fallback URL is hard-coded here rather than in env because:
 *   a) It is a public service that should always be available as last resort.
 *   b) Hard-coding it makes the fallback contract explicit and auditable.
 *
 * To wire the resolved bootnode URL into the SPP SDK, pass it as `bootnodeUrl`
 * in the SDK's privacy config:
 *
 *   import { resolveBootnodeUrl } from '@/lib/privacy/config'
 *   import { resolveBootnodeWithFallback } from '@/lib/privacy/bootnode'
 *
 *   const bootnodeUrl = await resolveBootnodeWithFallback(resolveBootnodeUrl())
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SppBootnodeConfig {
  /**
   * Veil's own deployed bootnode URL (from NEXT_PUBLIC_SPP_BOOTNODE_URL).
   * `null` when the env var is not set — use the fallback instead.
   */
  primary: string | null;
  /**
   * Nethermind's public testnet bootnode.  Always used when the primary is
   * null or unreachable.
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
 * Return the full bootnode config: primary (from env) + fallback (Nethermind).
 *
 * Stable across renders — reads `NEXT_PUBLIC_*` which are baked in at build
 * time and cannot change without a rebuild.
 */
export function getSppBootnodeConfig(): SppBootnodeConfig {
  const primary =
    process.env['NEXT_PUBLIC_SPP_BOOTNODE_URL']?.trim() || null;
  return {
    primary,
    fallback: NETHERMIND_BOOTNODE_URL,
  };
}

/**
 * Convenience: return the primary bootnode URL, or null when none is
 * configured.  Callers should pass this to `resolveBootnodeWithFallback()`
 * before using it.
 *
 * @example
 *   const bootnode = await resolveBootnodeWithFallback(resolveBootnodeUrl())
 */
export function resolveBootnodeUrl(): string | null {
  return getSppBootnodeConfig().primary;
}

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
 * The privacy feature flag and the per-network Stellar Private Payments (SPP)
 * config (V131).
 *
 * SPP is an unaudited developer preview that runs on testnet only — "not yet
 * approved for mainnet". Every later issue in the privacy batch reads two
 * things from this module and nowhere else:
 *
 *   - {@link isPrivacyEnabled} — the single switch that hides the feature;
 *   - {@link getSppConfig} — the pool, verifier, ASP and registry contract
 *     IDs for the active network.
 *
 * The network is resolved per call rather than captured at import time, so the
 * runtime override in `lib/network.ts` takes effect without module-level state
 * going stale.
 */

import { getNetworkName, type VeilNetworkName } from '../network';

/**
 * Build-time switch for the privacy feature, off unless a build opts in with
 * `EXPO_PUBLIC_PRIVACY_FEATURE_FLAG=1` (or `true`), mirroring the wallet's
 * `NEXT_PUBLIC_PRIVACY_FEATURE_FLAG`.
 */
function privacyFlagOn(): boolean {
  return (
    process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'] === '1' ||
    process.env['EXPO_PUBLIC_PRIVACY_FEATURE_FLAG'] === 'true'
  );
}

/**
 * Whether the privacy feature is available for `network`, defaulting to the
 * active network.
 *
 * Off by default, and unconditionally off on mainnet. SPP is a testnet-only
 * preview, so an enabled build flag must never become a path to private
 * payments on mainnet — even a mainnet build that sets it gets `false`.
 */
export function isPrivacyEnabled(network: VeilNetworkName = getNetworkName()): boolean {
  if (network === 'mainnet') return false;
  return privacyFlagOn();
}

/** One entry of SPP's `pools` array in `deployments/testnet/deployments.json`. */
export type SppPool = {
  /** `poolContractId` — the pool's own contract. */
  id: string;
  /** `tokenContractId` — the token contract the pool moves. */
  tokenContractId: string;
  /** `policyFlags` — the compliance policy the pool was deployed with. */
  policyFlags: readonly string[];
  /** `asset.kind` — whether the pool's base asset is native XLM. */
  assetKind: 'native' | 'soroban';
  /** `gvkMode`, present only when the pool is global-view-key traceable. */
  gvkMode?: 'traceable';
};

/** The SPP deployment the app should talk to on one network, if any. */
export type SppNetworkConfig = {
  /** `asp_membership` — ASP contract holding the approved-key Merkle tree. */
  aspMembership: string;
  /** `asp_non_membership` — ASP contract holding the blocked-key tree. */
  aspNonMembership: string;
  /** `verifiers` — the on-chain Groth16 verifier contracts. */
  verifiers: {
    /** `verifiers.B` — block-list / allow-list pools without a global view key. */
    standard: string;
    /** `verifiers.B_gvk_T` — traceable global-view-key pools. */
    traceable: string;
  };
  /** `public_key_registry` — Stellar address → SPP public keys. */
  publicKeyRegistry: string;
  /** Nethermind's hosted events archive for sync past the 7-day RPC window. */
  bootnodeUrl: string;
  /** `pools` — the canonical pools for this network. */
  pools: readonly SppPool[];
};

/**
 * SPP contract addresses, copied from SPP's
 * `deployments/testnet/deployments.json` at upstream commit
 * `91ba67d659cb50a66ecba7ba42e27f8e686117f4`
 * (NethermindEth/stellar-private-payments, 2026-09-23 — "redeploy testnet for
 * the packed storage layout"). Copy the testnet entry again — and bump the
 * commit hash above with it — whenever SPP redeploys.
 *
 * Mainnet has no entry on purpose: SPP is not approved for mainnet, so there is
 * nothing to point at, and {@link getSppConfig} returning `null` there is how a
 * screen knows not to offer any of it.
 */
export const SPP_NETWORKS: Partial<Record<VeilNetworkName, SppNetworkConfig>> = {
  testnet: {
    aspMembership: 'CAUPZISOB4GWTH22MVKA6MRWJMQRTLUMIGUSBFNJEF32Z6WEY3RFOKGC',
    aspNonMembership: 'CAFLZKGO3KYKNOBPCVT3APFEWMUBRDBF4EVYK65E6O653WYMX4XH4QYJ',
    verifiers: {
      standard: 'CD34JHLNB7AYASRLOTMT6EECBKFMOS356PPP5RPXRO5Y5EA5Y4DIXGTV',
      traceable: 'CDBA2ZZSVV5VVE4OL2ORCSG2XDN4CD2UPTZIEO7BI32RKRTPFCUF2FMV',
    },
    publicKeyRegistry: 'CC6EJCBEULJGHNQQROKLXD6M6IKFW6LN7IHTVUEFQQWZDDLCMNPWXIH4',
    bootnodeUrl: 'https://bootnode.dev-nethermind.xyz',
    pools: [
      {
        // XLM pool with a block-list policy.
        id: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
        tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        policyFlags: ['blocklist'],
        assetKind: 'native',
      },
      {
        // XLM pool with a block-list policy and a global view key (traceable).
        id: 'CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42',
        tokenContractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        policyFlags: ['blocklist'],
        assetKind: 'native',
        gvkMode: 'traceable',
      },
    ],
  },
  // mainnet: no entry — see the comment above.
};

/**
 * The SPP config for `network`, or `null` when that network has no deployment
 * (mainnet). Resolved per call so it tracks the runtime network override.
 */
export function getSppConfig(network: VeilNetworkName = getNetworkName()): SppNetworkConfig | null {
  return SPP_NETWORKS[network] ?? null;
}

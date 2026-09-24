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
 * runtime network switch (`setActiveNetwork` in `lib/network.ts`) takes effect
 * without module-level state going stale.
 */

import { getNetworkName, type VeilNetworkName } from '../network'

/**
 * Build-time switch for the privacy feature, off unless a build opts in with
 * `NEXT_PUBLIC_PRIVACY_FEATURE_FLAG=1` (or `true`). `NEXT_PUBLIC_` is spelled
 * out literally for the same reason `lib/multisigConfig.ts` spells its
 * variables out: Next.js inlines `NEXT_PUBLIC_*` into the client bundle by
 * matching the literal member expression, and a computed key is not
 * substituted.
 */
function privacyFlagOn(): boolean {
  return (
    process.env.NEXT_PUBLIC_PRIVACY_FEATURE_FLAG === '1' ||
    process.env.NEXT_PUBLIC_PRIVACY_FEATURE_FLAG === 'true'
  )
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
  if (network === 'mainnet') return false
  return privacyFlagOn()
}

/** One entry of SPP's `pools` array in `deployments/testnet/deployments.json`. */
export type SppPool = {
  /** `poolContractId` — the pool's own contract. */
  id: string
  /** `tokenContractId` — the token contract the pool moves. */
  tokenContractId: string
  /** `policyFlags` — the compliance policy the pool was deployed with. */
  policyFlags: readonly string[]
  /** `asset.kind` — whether the pool's base asset is native XLM. */
  assetKind: 'native' | 'soroban'
  /** `gvkMode`, present only when the pool is global-view-key traceable. */
  gvkMode?: 'traceable'
}

/** The SPP deployment the wallet should talk to on one network, if any. */
export type SppNetworkConfig = {
  /** `asp_membership` — ASP contract holding the approved-key Merkle tree. */
  aspMembership: string
  /** `asp_non_membership` — ASP contract holding the blocked-key tree. */
  aspNonMembership: string
  /** `verifiers` — the on-chain Groth16 verifier contracts. */
  verifiers: {
    /** `verifiers.B` — block-list / allow-list pools without a global view key. */
    standard: string
    /** `verifiers.B_gvk_T` — traceable global-view-key pools. */
    traceable: string
  }
  /** `public_key_registry` — Stellar address → SPP public keys. */
  publicKeyRegistry: string
  /** Nethermind's hosted events archive for sync past the 7-day RPC window. */
  bootnodeUrl: string
  /** `pools` — the canonical pools for this network. */
  pools: readonly SppPool[]
}

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
}

/**
 * The SPP config for `network`, or `null` when that network has no deployment
 * (mainnet). Resolved per call so it tracks the runtime network switch.
 */
export function getSppConfig(network: VeilNetworkName = getNetworkName()): SppNetworkConfig | null {
  return SPP_NETWORKS[network] ?? null
}

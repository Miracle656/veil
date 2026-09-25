/**
 * Stellar Private Payments (SPP) Upstream Deployment Drift Detector (#796).
 *
 * Compares our pinned contract IDs in `frontend/wallet/lib/privacy/config.ts`
 * against Nethermind's canonical `deployments/testnet/deployments.json`.
 */

import { SPP_NETWORKS, type SppNetworkConfig, type SppPool } from './config'

export const SPP_UPSTREAM_DEPLOYMENTS_URL =
  'https://raw.githubusercontent.com/NethermindEth/stellar-private-payments/main/deployments/testnet/deployments.json'

export interface SppDriftEntry {
  key: string
  pinnedValue: string
  upstreamValue: string
}

export type SppDriftCheck =
  | { status: 'in-sync'; drifts: [] }
  | { status: 'drift-detected'; drifts: SppDriftEntry[]; diffSummary: string }
  | { status: 'upstream-unreachable'; error: string; statusCode?: number }

/**
 * Raw JSON format expected from Nethermind's deployments/testnet/deployments.json.
 */
export interface UpstreamDeploymentsJson {
  asp_membership?: string
  aspMembership?: string
  asp_non_membership?: string
  aspNonMembership?: string
  verifiers?: {
    B?: string
    standard?: string
    B_gvk_T?: string
    traceable?: string
    [key: string]: unknown
  }
  public_key_registry?: string
  publicKeyRegistry?: string
  bootnode_url?: string
  bootnodeUrl?: string
  pools?: Array<{
    id?: string
    poolContractId?: string
    tokenContractId?: string
    policyFlags?: string[]
    asset?: { kind?: string }
    assetKind?: string
    gvkMode?: string
    [key: string]: unknown
  }>
  [key: string]: unknown
}

/**
 * Compares pinned SPP network config field-by-field with upstream deployments.json.
 */
export function compareSppDeployments(
  pinned: SppNetworkConfig,
  upstream: UpstreamDeploymentsJson,
): SppDriftEntry[] {
  const drifts: SppDriftEntry[] = []

  // 1. ASP Membership
  const upstreamAspMem = upstream.asp_membership ?? upstream.aspMembership
  if (upstreamAspMem && upstreamAspMem !== pinned.aspMembership) {
    drifts.push({
      key: 'aspMembership',
      pinnedValue: pinned.aspMembership,
      upstreamValue: upstreamAspMem,
    })
  }

  // 2. ASP Non-Membership
  const upstreamAspNonMem = upstream.asp_non_membership ?? upstream.aspNonMembership
  if (upstreamAspNonMem && upstreamAspNonMem !== pinned.aspNonMembership) {
    drifts.push({
      key: 'aspNonMembership',
      pinnedValue: pinned.aspNonMembership,
      upstreamValue: upstreamAspNonMem,
    })
  }

  // 3. Verifiers
  const upstreamStandardVerifier =
    upstream.verifiers?.B ?? upstream.verifiers?.standard
  if (
    upstreamStandardVerifier &&
    upstreamStandardVerifier !== pinned.verifiers.standard
  ) {
    drifts.push({
      key: 'verifiers.standard',
      pinnedValue: pinned.verifiers.standard,
      upstreamValue: String(upstreamStandardVerifier),
    })
  }

  const upstreamTraceableVerifier =
    upstream.verifiers?.B_gvk_T ?? upstream.verifiers?.traceable
  if (
    upstreamTraceableVerifier &&
    upstreamTraceableVerifier !== pinned.verifiers.traceable
  ) {
    drifts.push({
      key: 'verifiers.traceable',
      pinnedValue: pinned.verifiers.traceable,
      upstreamValue: String(upstreamTraceableVerifier),
    })
  }

  // 4. Public Key Registry
  const upstreamRegistry =
    upstream.public_key_registry ?? upstream.publicKeyRegistry
  if (upstreamRegistry && upstreamRegistry !== pinned.publicKeyRegistry) {
    drifts.push({
      key: 'publicKeyRegistry',
      pinnedValue: pinned.publicKeyRegistry,
      upstreamValue: upstreamRegistry,
    })
  }

  // 5. Pools
  if (Array.isArray(upstream.pools)) {
    for (let i = 0; i < pinned.pools.length; i++) {
      const pinnedPool = pinned.pools[i]
      const upstreamPool = upstream.pools[i]
      if (!upstreamPool) {
        drifts.push({
          key: `pools[${i}].id`,
          pinnedValue: pinnedPool.id,
          upstreamValue: '<missing in upstream>',
        })
        continue
      }

      const upstreamPoolId = upstreamPool.poolContractId ?? upstreamPool.id
      if (upstreamPoolId && upstreamPoolId !== pinnedPool.id) {
        drifts.push({
          key: `pools[${i}].id`,
          pinnedValue: pinnedPool.id,
          upstreamValue: upstreamPoolId,
        })
      }

      const upstreamTokenId = upstreamPool.tokenContractId
      if (upstreamTokenId && upstreamTokenId !== pinnedPool.tokenContractId) {
        drifts.push({
          key: `pools[${i}].tokenContractId`,
          pinnedValue: pinnedPool.tokenContractId,
          upstreamValue: upstreamTokenId,
        })
      }
    }

    if (upstream.pools.length > pinned.pools.length) {
      drifts.push({
        key: 'pools.length',
        pinnedValue: String(pinned.pools.length),
        upstreamValue: String(upstream.pools.length),
      })
    }
  }

  return drifts
}

/**
 * Formats a list of drift entries into a readable diff summary.
 */
export function formatDriftDiff(drifts: SppDriftEntry[]): string {
  if (drifts.length === 0) return 'No SPP config drift detected. All pinned IDs match upstream.'

  const lines = [
    'SPP Configuration Drift Detected (NethermindEth/stellar-private-payments):',
    '========================================================================',
    ...drifts.map(
      (d) =>
        `- ${d.key}:\n    pinned:   ${d.pinnedValue}\n    upstream: ${d.upstreamValue}`,
    ),
    '========================================================================',
  ]
  return lines.join('\n')
}

/**
 * Fetches upstream testnet deployments and compares against our pinned testnet config.
 */
export async function checkSppDrift(
  pinned: SppNetworkConfig = SPP_NETWORKS.testnet!,
  fetchFn: typeof fetch = globalThis.fetch,
  url: string = SPP_UPSTREAM_DEPLOYMENTS_URL,
): Promise<SppDriftCheck> {
  if (!pinned) {
    return {
      status: 'upstream-unreachable',
      error: 'No pinned testnet SPP configuration found in SPP_NETWORKS',
    }
  }

  let res: Response
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' } })
  } catch (err) {
    return {
      status: 'upstream-unreachable',
      error: `Network error connecting to upstream deployments: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (!res.ok) {
    return {
      status: 'upstream-unreachable',
      error: `Upstream returned HTTP ${res.status} ${res.statusText}`,
      statusCode: res.status,
    }
  }

  let data: UpstreamDeploymentsJson
  try {
    data = (await res.json()) as UpstreamDeploymentsJson
  } catch (err) {
    return {
      status: 'upstream-unreachable',
      error: `Failed to parse upstream JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const drifts = compareSppDeployments(pinned, data)
  if (drifts.length === 0) {
    return { status: 'in-sync', drifts: [] }
  }

  return {
    status: 'drift-detected',
    drifts,
    diffSummary: formatDriftDiff(drifts),
  }
}

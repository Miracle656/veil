/**
 * Stellar Private Payments (SPP) upstream deployment drift detector (#796).
 *
 * Compares the testnet config we pin in `frontend/wallet/lib/privacy/config.ts`
 * against Nethermind's canonical `deployments/testnet/deployments.json`.
 *
 * This module is the single implementation of that comparison. The unit tests
 * exercise it directly, and the scheduled workflow runs it through jest
 * (`__tests__/drift.live.test.ts`), so what CI executes is what the tests cover.
 * Do not add a second copy elsewhere (a script, a workflow step): the copies
 * drift apart, which is exactly the failure this file exists to catch.
 */

import { SPP_NETWORKS, type SppNetworkConfig } from './config'

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

/** One entry of `pools` in upstream's deployments.json. */
export interface UpstreamPool {
  poolContractId?: string
  id?: string
  tokenContractId?: string
  policyFlags?: string[]
  asset?: { kind?: string }
  assetKind?: string
  gvkMode?: string
  /** Upstream can switch a pool off without removing it. */
  enabled?: boolean
  [key: string]: unknown
}

/**
 * Raw JSON format of Nethermind's deployments/testnet/deployments.json. Both the snake_case names
 * upstream publishes and camelCase aliases are accepted.
 *
 * Upstream does not currently publish a bootnode URL, so `bootnode_url` is optional here and is only
 * compared when it appears.
 */
export interface UpstreamDeploymentsJson {
  network?: string
  deployer?: string
  admin?: string
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
  pools?: UpstreamPool[]
  [key: string]: unknown
}

const MISSING_UPSTREAM = '<missing in upstream>'

function poolId(pool: UpstreamPool): string | undefined {
  return pool.poolContractId ?? pool.id
}

/** Order-insensitive rendering of a policy-flag list, so reordering is not drift. */
function flagsKey(flags: readonly string[]): string {
  return [...flags].sort().join(',')
}

/**
 * Compares pinned SPP network config with upstream deployments.
 *
 * Contract IDs changing is loud (the client fails at once). The quiet and more dangerous drift is a
 * pool whose policy, asset kind or traceability changes while its IDs stay the same: it keeps working
 * and silently changes what the user's anonymity set is. So those are compared too.
 *
 * Pools are matched by contract id, never by array position, so an upstream reorder or insertion can
 * neither hide nor invent drift. "A pool we pin has gone" and "upstream has a pool we do not pin" are
 * reported as different keys.
 */
export function compareSppDeployments(
  pinned: SppNetworkConfig,
  upstream: UpstreamDeploymentsJson,
): SppDriftEntry[] {
  const drifts: SppDriftEntry[] = []

  // A field upstream no longer publishes is drift, not a pass: silently skipping a renamed or removed
  // field would make this check report "in sync" forever.
  const compareScalar = (key: string, pinnedValue: string, upstreamValue: unknown) => {
    if (upstreamValue === undefined || upstreamValue === null) {
      drifts.push({ key, pinnedValue, upstreamValue: MISSING_UPSTREAM })
    } else if (String(upstreamValue) !== pinnedValue) {
      drifts.push({ key, pinnedValue, upstreamValue: String(upstreamValue) })
    }
  }

  compareScalar('deployer', pinned.deployer, upstream.deployer)
  compareScalar('admin', pinned.admin, upstream.admin)
  compareScalar(
    'aspMembership',
    pinned.aspMembership,
    upstream.asp_membership ?? upstream.aspMembership,
  )
  compareScalar(
    'aspNonMembership',
    pinned.aspNonMembership,
    upstream.asp_non_membership ?? upstream.aspNonMembership,
  )
  compareScalar(
    'verifiers.standard',
    pinned.verifiers.standard,
    upstream.verifiers?.B ?? upstream.verifiers?.standard,
  )
  compareScalar(
    'verifiers.traceable',
    pinned.verifiers.traceable,
    upstream.verifiers?.B_gvk_T ?? upstream.verifiers?.traceable,
  )
  compareScalar(
    'publicKeyRegistry',
    pinned.publicKeyRegistry,
    upstream.public_key_registry ?? upstream.publicKeyRegistry,
  )

  // Only when upstream publishes one: the file does not today, so there is nothing to compare against,
  // and demanding it would report permanent false drift.
  const upstreamBootnode = upstream.bootnode_url ?? upstream.bootnodeUrl
  if (upstreamBootnode !== undefined && upstreamBootnode !== pinned.bootnodeUrl) {
    drifts.push({
      key: 'bootnodeUrl',
      pinnedValue: pinned.bootnodeUrl,
      upstreamValue: String(upstreamBootnode),
    })
  }

  if (!Array.isArray(upstream.pools)) {
    drifts.push({
      key: 'pools',
      pinnedValue: `${pinned.pools.length} pools`,
      upstreamValue: MISSING_UPSTREAM,
    })
    return drifts
  }

  const upstreamPools = upstream.pools
  const pinnedIds = new Set(pinned.pools.map((p) => p.id))

  for (const pinnedPool of pinned.pools) {
    const upstreamPool = upstreamPools.find((p) => poolId(p) === pinnedPool.id)
    if (!upstreamPool) {
      drifts.push({
        key: 'pools.pinnedMissingUpstream',
        pinnedValue: pinnedPool.id,
        upstreamValue: '<not present upstream>',
      })
      continue
    }

    const at = (field: string) => `pools[${pinnedPool.id}].${field}`

    compareScalar(at('tokenContractId'), pinnedPool.tokenContractId, upstreamPool.tokenContractId)

    const upstreamFlags = upstreamPool.policyFlags
    if (!Array.isArray(upstreamFlags)) {
      drifts.push({
        key: at('policyFlags'),
        pinnedValue: flagsKey(pinnedPool.policyFlags),
        upstreamValue: MISSING_UPSTREAM,
      })
    } else if (flagsKey(upstreamFlags) !== flagsKey(pinnedPool.policyFlags)) {
      drifts.push({
        key: at('policyFlags'),
        pinnedValue: flagsKey(pinnedPool.policyFlags),
        upstreamValue: flagsKey(upstreamFlags),
      })
    }

    compareScalar(at('assetKind'), pinnedPool.assetKind, upstreamPool.asset?.kind ?? upstreamPool.assetKind)

    // No gvkMode means "not traceable" on both sides.
    const pinnedGvk = pinnedPool.gvkMode ?? 'none'
    const upstreamGvk = upstreamPool.gvkMode ?? 'none'
    if (pinnedGvk !== upstreamGvk) {
      drifts.push({ key: at('gvkMode'), pinnedValue: pinnedGvk, upstreamValue: upstreamGvk })
    }

    if (upstreamPool.enabled === false) {
      drifts.push({ key: at('enabled'), pinnedValue: 'enabled', upstreamValue: 'disabled' })
    }
  }

  // Pools upstream has that we do not pin. A disabled one is not actionable, so it is not drift.
  for (const upstreamPool of upstreamPools) {
    const id = poolId(upstreamPool)
    if (id && !pinnedIds.has(id) && upstreamPool.enabled !== false) {
      drifts.push({
        key: 'pools.unpinnedUpstream',
        pinnedValue: '<not pinned>',
        upstreamValue: id,
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
      (d) => `- ${d.key}:\n    pinned:   ${d.pinnedValue}\n    upstream: ${d.upstreamValue}`,
    ),
    '========================================================================',
    'Action: update frontend/wallet/lib/privacy/config.ts from upstream (and bump the commit hash',
    'in its comment), or confirm the change is intended.',
  ]
  return lines.join('\n')
}

/** `AbortSignal.timeout` where the runtime has it (Node 18+; not every test DOM does). */
function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal
    ? AbortSignal.timeout(ms)
    : undefined
}

/**
 * Fetches upstream testnet deployments and compares against our pinned testnet config.
 */
export async function checkSppDrift(
  pinned: SppNetworkConfig | undefined = SPP_NETWORKS.testnet,
  fetchFn: typeof fetch = globalThis.fetch,
  url: string = SPP_UPSTREAM_DEPLOYMENTS_URL,
  timeoutMs = 15_000,
): Promise<SppDriftCheck> {
  if (!pinned) {
    return {
      status: 'upstream-unreachable',
      error: 'No pinned testnet SPP configuration found in SPP_NETWORKS',
    }
  }

  let res: Response
  try {
    res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(timeoutMs),
    })
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

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
 * Is the newest published SDK older than the proving keys the pools now verify against?
 *
 * Address drift is only half of "does privacy work". The other half is that a
 * Groth16 proof is made with a *proving key* and checked against a *verifying
 * key*, and the two are generated together from one circuit. Change the circuit
 * and both are regenerated; a proof from the old pair cannot verify against the
 * new one, which is the whole point of the scheme rather than a bug in it.
 *
 * Upstream regenerates `deployments/testnet/circuit_keys/` and redeploys the
 * verifiers in the same commit, but republishing the npm package is a separate
 * act that can lag — on 2026-10-05 it had lagged by a month and 22 commits,
 * while this file's address check stayed green the whole time. Config in sync
 * does not mean privacy works.
 *
 * Compares the *latest published* version rather than whatever is installed: if
 * even the newest release predates the circuit keys, there is no version anyone
 * could install that would work, which is the actionable fact.
 */
export const SPP_SDK_PACKAGE = 'stellar-private-payments'

export const SPP_NPM_REGISTRY_URL = `https://registry.npmjs.org/${SPP_SDK_PACKAGE}`

/** Commits touching the generated proving/verifying keys, newest first. */
export const SPP_CIRCUIT_KEYS_COMMITS_URL =
  'https://api.github.com/repos/NethermindEth/stellar-private-payments/commits' +
  '?path=deployments/testnet/circuit_keys&per_page=1'

export interface SppSdkFreshness {
  /** Newest version on npm. */
  latestVersion: string
  /** When npm published it (ISO 8601). */
  latestPublishedAt: string
  /** When upstream last regenerated the circuit keys (ISO 8601). */
  circuitKeysUpdatedAt: string
}

export type SppSdkCheck =
  | { status: 'in-sync'; freshness: SppSdkFreshness }
  | { status: 'sdk-stale'; freshness: SppSdkFreshness; drift: SppDriftEntry; summary: string }
  | { status: 'upstream-unreachable'; error: string }

/**
 * A drift entry when the published SDK predates the circuit keys, else null.
 *
 * Equal timestamps pass: a package published in the same second as the commit
 * is the release *of* that commit, and treating that as stale would make the
 * check impossible to satisfy.
 */
export function compareSppSdkFreshness(freshness: SppSdkFreshness): SppDriftEntry | null {
  const published = Date.parse(freshness.latestPublishedAt)
  const keys = Date.parse(freshness.circuitKeysUpdatedAt)

  // An unparseable date is reported rather than silently treated as fresh: a
  // check that cannot read its inputs must not answer "all good".
  if (Number.isNaN(published) || Number.isNaN(keys)) {
    return {
      key: 'sdk.freshness',
      pinnedValue: `npm ${freshness.latestVersion} published ${freshness.latestPublishedAt}`,
      upstreamValue: `circuit keys updated ${freshness.circuitKeysUpdatedAt} (unreadable date)`,
    }
  }

  if (published >= keys) return null

  const days = Math.floor((keys - published) / 86_400_000)
  return {
    key: 'sdk.proverKeysPredateCircuits',
    pinnedValue: `npm ${SPP_SDK_PACKAGE}@${freshness.latestVersion}, published ${freshness.latestPublishedAt}`,
    upstreamValue: `circuit keys regenerated ${freshness.circuitKeysUpdatedAt} — ${days} day(s) newer than any published SDK`,
  }
}

/** Renders the stale-SDK finding, with what it means for the app. */
export function formatSdkStaleness(drift: SppDriftEntry): string {
  return [
    'SPP SDK is older than the deployed circuits:',
    '========================================================================',
    `- ${drift.key}:`,
    `    newest published: ${drift.pinnedValue}`,
    `    upstream:         ${drift.upstreamValue}`,
    '========================================================================',
    'Proofs built by the published SDK use proving keys that no longer pair with',
    'the verifying keys in the deployed verifier contracts, so shield / private',
    'send / unshield cannot succeed however correct the pinned addresses are.',
    '',
    'Action: this one is upstream to fix — ask NethermindEth/stellar-private-payments',
    'to republish the npm package for the current deployment. Until then, treat the',
    'privacy flows as non-functional on testnet rather than merely untested.',
  ].join('\n')
}

/**
 * Fetches npm and GitHub, and reports whether the published SDK can work at all.
 *
 * Deliberately separate from {@link checkSppDrift}: an npm or GitHub outage must
 * not be able to mask address drift, and vice versa.
 */
export async function checkSppSdkFreshness(
  fetchFn: typeof fetch = globalThis.fetch,
  timeoutMs = 15_000,
): Promise<SppSdkCheck> {
  const getJson = async (url: string): Promise<unknown> => {
    const res = await fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(timeoutMs),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} from ${url}`)
    return res.json()
  }

  let freshness: SppSdkFreshness
  try {
    const registry = (await getJson(SPP_NPM_REGISTRY_URL)) as {
      'dist-tags'?: { latest?: string }
      time?: Record<string, string>
    }
    const latestVersion = registry['dist-tags']?.latest
    const latestPublishedAt = latestVersion ? registry.time?.[latestVersion] : undefined
    if (!latestVersion || !latestPublishedAt) {
      return { status: 'upstream-unreachable', error: `npm returned no latest version for ${SPP_SDK_PACKAGE}` }
    }

    const commits = (await getJson(SPP_CIRCUIT_KEYS_COMMITS_URL)) as Array<{
      commit?: { author?: { date?: string }; committer?: { date?: string } }
    }>
    const circuitKeysUpdatedAt = commits?.[0]?.commit?.author?.date ?? commits?.[0]?.commit?.committer?.date
    if (!circuitKeysUpdatedAt) {
      return { status: 'upstream-unreachable', error: 'GitHub returned no commits for the circuit-keys path' }
    }

    freshness = { latestVersion, latestPublishedAt, circuitKeysUpdatedAt }
  } catch (err) {
    return {
      status: 'upstream-unreachable',
      error: `Could not read SDK freshness: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  const drift = compareSppSdkFreshness(freshness)
  if (!drift) return { status: 'in-sync', freshness }
  return { status: 'sdk-stale', freshness, drift, summary: formatSdkStaleness(drift) }
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

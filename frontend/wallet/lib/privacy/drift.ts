/**
 * SPP deployment drift checker (V207 — issue #796).
 *
 * Compares Veil's pinned SPP config (`lib/privacy/config.ts`) against upstream
 * `deployments/testnet/deployments.json` from NethermindEth/stellar-private-payments.
 *
 * Distinguishes between:
 *  - in_sync: All contract IDs match upstream.
 *  - drift: Upstream redeployed and contract IDs differ (reported with old and new values).
 *  - unreachable: Upstream GitHub is temporarily down/unreachable (distinguishable from drift).
 */

import type { SppNetworkConfig } from './config'

export interface SppUpstreamDeployments {
  network?: string
  deployer?: string
  admin?: string
  asp_membership?: string
  asp_non_membership?: string
  verifiers?: {
    B?: string
    B_gvk_T?: string
    [key: string]: string | undefined
  }
  public_key_registry?: string
  pools?: Array<{
    poolContractId?: string
    tokenContractId?: string
    policyFlags?: string[]
    asset?: { kind?: string }
    gvkMode?: string
    [key: string]: any
  }>
  [key: string]: any
}

export interface SppDriftEntry {
  field: string
  pinned: string
  upstream: string
}

export type SppDriftResult =
  | { status: 'in_sync'; diffs: [] }
  | { status: 'drift'; diffs: SppDriftEntry[] }

export type SppFetchResult =
  | { status: 'ok'; data: SppUpstreamDeployments }
  | { status: 'unreachable'; error: string }

export const UPSTREAM_RAW_URL =
  'https://raw.githubusercontent.com/NethermindEth/stellar-private-payments/main/deployments/testnet/deployments.json'

export const UPSTREAM_API_URL =
  'https://api.github.com/repos/NethermindEth/stellar-private-payments/contents/deployments/testnet/deployments.json'

/**
 * Compares pinned config against upstream deployments field by field.
 * Acceptance criterion: A changed pool, verifier, ASP or registry id is reported with old and new values.
 */
export function diffSppDeployments(
  pinned: SppNetworkConfig,
  upstream: SppUpstreamDeployments,
): SppDriftResult {
  const diffs: SppDriftEntry[] = []

  if (upstream.asp_membership && upstream.asp_membership !== pinned.aspMembership) {
    diffs.push({
      field: 'aspMembership',
      pinned: pinned.aspMembership,
      upstream: upstream.asp_membership,
    })
  }

  if (upstream.asp_non_membership && upstream.asp_non_membership !== pinned.aspNonMembership) {
    diffs.push({
      field: 'aspNonMembership',
      pinned: pinned.aspNonMembership,
      upstream: upstream.asp_non_membership,
    })
  }

  if (upstream.verifiers?.B && upstream.verifiers.B !== pinned.verifiers.standard) {
    diffs.push({
      field: 'verifiers.standard',
      pinned: pinned.verifiers.standard,
      upstream: upstream.verifiers.B,
    })
  }

  if (upstream.verifiers?.B_gvk_T && upstream.verifiers.B_gvk_T !== pinned.verifiers.traceable) {
    diffs.push({
      field: 'verifiers.traceable',
      pinned: pinned.verifiers.traceable,
      upstream: upstream.verifiers.B_gvk_T,
    })
  }

  if (upstream.public_key_registry && upstream.public_key_registry !== pinned.publicKeyRegistry) {
    diffs.push({
      field: 'publicKeyRegistry',
      pinned: pinned.publicKeyRegistry,
      upstream: upstream.public_key_registry,
    })
  }

  if (Array.isArray(upstream.pools)) {
    if (upstream.pools.length !== pinned.pools.length) {
      diffs.push({
        field: 'pools.length',
        pinned: String(pinned.pools.length),
        upstream: String(upstream.pools.length),
      })
    }
    const maxLen = Math.min(upstream.pools.length, pinned.pools.length)
    for (let i = 0; i < maxLen; i++) {
      const up = upstream.pools[i]
      const pin = pinned.pools[i]
      if (up.poolContractId && up.poolContractId !== pin.id) {
        diffs.push({
          field: `pools[${i}].id`,
          pinned: pin.id,
          upstream: up.poolContractId,
        })
      }
      if (up.tokenContractId && up.tokenContractId !== pin.tokenContractId) {
        diffs.push({
          field: `pools[${i}].tokenContractId`,
          pinned: pin.tokenContractId,
          upstream: up.tokenContractId,
        })
      }
    }
  }

  if (diffs.length === 0) {
    return { status: 'in_sync', diffs: [] }
  }
  return { status: 'drift', diffs }
}

/**
 * Fetches upstream deployments with a timeout and fallback to GitHub API.
 * Acceptance criterion: An unreachable upstream is distinguishable from a real drift.
 */
export async function fetchUpstreamDeployments(
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = 10_000,
): Promise<SppFetchResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let res: Response | null = null
    try {
      res = await fetchFn(UPSTREAM_RAW_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': 'veil-drift-sentry' },
      })
    } catch {
      res = await fetchFn(UPSTREAM_API_URL, {
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github.raw+json',
          'User-Agent': 'veil-drift-sentry',
        },
      })
    }

    if (!res || !res.ok) {
      return {
        status: 'unreachable',
        error: `HTTP ${res?.status ?? 'unknown'}: ${res?.statusText ?? 'failed to fetch'}`,
      }
    }

    const data = (await res.json()) as SppUpstreamDeployments
    if (!data || typeof data !== 'object') {
      return {
        status: 'unreachable',
        error: 'Malformed JSON payload received from upstream',
      }
    }
    return { status: 'ok', data }
  } catch (err) {
    return {
      status: 'unreachable',
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Formats a clean markdown report showing the old and new values.
 */
export function formatDriftReport(diffs: SppDriftEntry[]): string {
  if (diffs.length === 0) {
    return 'SPP testnet config is in sync with upstream.'
  }

  const lines = [
    '## SPP testnet config drift detected',
    '',
    `Detected ${diffs.length} field(s) where pinned config differs from NethermindEth/stellar-private-payments:`,
    '',
    '| Field | Pinned (Veil) | Upstream (Nethermind) |',
    '|---|---|---|',
  ]

  for (const d of diffs) {
    lines.push(`| \`${d.field}\` | \`${d.pinned}\` | \`${d.upstream}\` |`)
  }

  lines.push('')
  lines.push('### Required action')
  lines.push('Update `frontend/wallet/lib/privacy/config.ts` to match the upstream contract IDs.')

  return lines.join('\n')
}

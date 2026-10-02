#!/usr/bin/env node
/**
 * SPP deployment drift checker (V207 — issue #796).
 *
 * Compares Veil's pinned SPP config (`frontend/wallet/lib/privacy/config.ts`)
 * against upstream `deployments/testnet/deployments.json` from
 * NethermindEth/stellar-private-payments.
 *
 * Distinguishes between:
 *  - in_sync (exit 0): All contract IDs match upstream.
 *  - drift (exit 1): Upstream redeployed and contract IDs differ (reported with old and new values).
 *  - unreachable (exit 2, or 0 with --warn-only): Upstream network/fetch failure, distinguished from real drift.
 *
 * Usage:
 *   node scripts/check-spp-drift.mjs              # exit 1 on drift, exit 2 on unreachable
 *   node scripts/check-spp-drift.mjs --warn-only  # report drift/unreachable but exit 0
 *   node scripts/check-spp-drift.mjs --json       # machine-readable JSON output
 *   node scripts/check-spp-drift.mjs --dry-run-issue # test issue creation payload formatting
 */

import { readFileSync, appendFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CONFIG_PATH = resolve(ROOT, 'frontend/wallet/lib/privacy/config.ts')

const UPSTREAM_RAW_URL =
  'https://raw.githubusercontent.com/NethermindEth/stellar-private-payments/main/deployments/testnet/deployments.json'

const UPSTREAM_API_URL =
  'https://api.github.com/repos/NethermindEth/stellar-private-payments/contents/deployments/testnet/deployments.json'

// Pure fallback validator if @stellar/stellar-sdk is unresolvable
let strKeyValidator = (id) => typeof id === 'string' && /^C[A-Z2-7]{55}$/.test(id)
try {
  const sdk = await import('@stellar/stellar-sdk').catch(() =>
    import('../frontend/wallet/node_modules/@stellar/stellar-sdk/lib/index.js')
  )
  if (sdk?.StrKey?.isValidContract) {
    strKeyValidator = (id) => sdk.StrKey.isValidContract(id)
  }
} catch {}

export function isValidContractId(id) {
  return strKeyValidator(id)
}

function parseArgs() {
  const args = process.argv.slice(2)
  return {
    warnOnly: args.includes('--warn-only'),
    json: args.includes('--json'),
    dryRunIssue: args.includes('--dry-run-issue'),
  }
}

function setGithubOutput(key, value) {
  const outputFile = process.env.GITHUB_OUTPUT
  if (outputFile) {
    try {
      appendFileSync(outputFile, `${key}=${value}\n`, 'utf8')
    } catch {}
  }
}

/**
 * Extracts pinned testnet SPP configuration from config.ts source text.
 * Scoped strictly to the testnet block to be immune to reformatting, comments,
 * or future mainnet entries.
 */
export function extractPinnedConfig(sourceText) {
  const testnetBlockMatch = sourceText.match(/testnet:\s*\{([\s\S]*?)\n\s*\},?\s*(?:\n\s*\}|\/\/)/)
  const block = testnetBlockMatch ? testnetBlockMatch[1] : sourceText

  const aspMembership = block.match(/aspMembership:\s*['"]([A-Z0-9]{56})['"]/)?.[1]
  const aspNonMembership = block.match(/aspNonMembership:\s*['"]([A-Z0-9]{56})['"]/)?.[1]
  const standard = block.match(/standard:\s*['"]([A-Z0-9]{56})['"]/)?.[1]
  const traceable = block.match(/traceable:\s*['"]([A-Z0-9]{56})['"]/)?.[1]
  const publicKeyRegistry = block.match(/publicKeyRegistry:\s*['"]([A-Z0-9]{56})['"]/)?.[1]

  const poolIds = [...block.matchAll(/id:\s*['"]([A-Z0-9]{56})['"]/g)].map((m) => m[1])
  const tokenContractIds = [...block.matchAll(/tokenContractId:\s*['"]([A-Z0-9]{56})['"]/g)].map(
    (m) => m[1],
  )

  const pools = poolIds.map((id, index) => ({
    id,
    tokenContractId: tokenContractIds[index] || '',
  }))

  return {
    aspMembership: aspMembership || '',
    aspNonMembership: aspNonMembership || '',
    verifiers: {
      standard: standard || '',
      traceable: traceable || '',
    },
    publicKeyRegistry: publicKeyRegistry || '',
    pools,
  }
}

/**
 * Compares pinned config against upstream deployments JSON.
 * Validates upstream values with StrKey to prevent accepting corrupted IDs.
 */
export function diffSppDeployments(pinned, upstream, validator = isValidContractId) {
  const diffs = []

  function check(field, pinnedVal, upstreamVal) {
    if (!upstreamVal) return
    if (!validator(upstreamVal)) {
      diffs.push({
        field,
        pinned: pinnedVal,
        upstream: upstreamVal,
        error: `Upstream contract ID '${upstreamVal}' fails StrKey.isValidContract validation`,
      })
      return
    }
    if (upstreamVal !== pinnedVal) {
      diffs.push({
        field,
        pinned: pinnedVal,
        upstream: upstreamVal,
      })
    }
  }

  check('aspMembership', pinned.aspMembership, upstream.asp_membership)
  check('aspNonMembership', pinned.aspNonMembership, upstream.asp_non_membership)
  check('verifiers.standard', pinned.verifiers?.standard, upstream.verifiers?.B)
  check('verifiers.traceable', pinned.verifiers?.traceable, upstream.verifiers?.B_gvk_T)
  check('publicKeyRegistry', pinned.publicKeyRegistry, upstream.public_key_registry)

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
      check(`pools[${i}].id`, pin?.id, up?.poolContractId)
      check(`pools[${i}].tokenContractId`, pin?.tokenContractId, up?.tokenContractId)
    }
  }

  const status = diffs.length === 0 ? 'in_sync' : 'drift'
  return { status, diffs }
}

export function formatDriftReport(diffs) {
  if (!diffs || diffs.length === 0) {
    return '[IN_SYNC] Pinned SPP testnet config is in sync with upstream NethermindEth/stellar-private-payments.'
  }
  const lines = [
    '## Notice: SPP testnet deployment config has drifted from upstream',
    '',
    `Detected ${diffs.length} field(s) where pinned config differs from NethermindEth/stellar-private-payments:`,
    '',
    '| Field | Pinned (Veil) | Upstream (Nethermind) | Status |',
    '|---|---|---|---|',
  ]
  for (const d of diffs) {
    const statusNote = d.error ? `⚠️ Invalid StrKey: ${d.error}` : 'Changed'
    lines.push(`| \`${d.field}\` | \`${d.pinned}\` | \`${d.upstream}\` | ${statusNote} |`)
  }
  lines.push('', '### Required action', 'Update `frontend/wallet/lib/privacy/config.ts` to match the upstream contract IDs.')
  return lines.join('\n')
}

export async function fetchUpstreamDeployments(fetchImpl = fetch, timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let res = null
    try {
      res = await fetchImpl(UPSTREAM_RAW_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': 'veil-drift-sentry' },
      })
    } catch {
      res = await fetchImpl(UPSTREAM_API_URL, {
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

    const data = await res.json()
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

async function main() {
  const { warnOnly, json, dryRunIssue } = parseArgs()

  if (dryRunIssue) {
    console.log('[DRY-RUN] Verifying drift report and issue-creation markdown generation:')
    const simulatedDiffs = [
      {
        field: 'pools[0].id',
        pinned: 'CBEDPYMAEPQ6JR7WKWXRM6CFHHJLKA5RHPRRLSD4UZXZRGNMBXOT2GOT',
        upstream: 'CADS665GRBHOMPE7GY5XYTFT2J5JKRZN6ILYMJ5ZO62GU4YPL3PYIN42',
      },
    ]
    const report = formatDriftReport(simulatedDiffs)
    console.log(report)
    console.log('[DRY-RUN] Execution completed successfully.')
    process.exit(0)
  }

  let sourceText
  try {
    sourceText = readFileSync(CONFIG_PATH, 'utf8')
  } catch (err) {
    console.error(`Failed to read pinned config at ${CONFIG_PATH}: ${err.message}`)
    process.exit(1)
  }

  const pinned = extractPinnedConfig(sourceText)
  const fetchResult = await fetchUpstreamDeployments()

  if (fetchResult.status === 'unreachable') {
    setGithubOutput('status', 'unreachable')
    if (json) {
      console.log(JSON.stringify({ status: 'unreachable', error: fetchResult.error }))
    } else {
      console.log(`[UNREACHABLE] Upstream NethermindEth/stellar-private-payments is unreachable: ${fetchResult.error}`)
    }
    if (warnOnly) {
      console.log('[WARN-ONLY] Exiting cleanly as requested for PR / warn-only mode.')
      process.exit(0)
    }
    process.exit(2)
  }

  const { status, diffs } = diffSppDeployments(pinned, fetchResult.data)

  if (diffs.length === 0) {
    setGithubOutput('status', 'in_sync')
    if (json) {
      console.log(JSON.stringify({ status: 'in_sync', diffs: [] }))
    } else {
      console.log('[IN_SYNC] Pinned SPP testnet config matches upstream exactly.')
    }
    process.exit(0)
  }

  // Drift detected
  setGithubOutput('status', 'drift')
  if (json) {
    console.log(JSON.stringify({ status: 'drift', diffs }, null, 2))
  } else {
    console.log(formatDriftReport(diffs))
  }

  if (warnOnly) {
    process.exit(0)
  }
  process.exit(1)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

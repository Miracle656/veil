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

function parseArgs() {
  const args = process.argv.slice(2)
  return {
    warnOnly: args.includes('--warn-only'),
    json: args.includes('--json'),
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

export function extractPinnedConfig(sourceText) {
  const aspMembership = sourceText.match(/aspMembership:\s*'([^']+)'/)?.[1]
  const aspNonMembership = sourceText.match(/aspNonMembership:\s*'([^']+)'/)?.[1]
  const standard = sourceText.match(/standard:\s*'([^']+)'/)?.[1]
  const traceable = sourceText.match(/traceable:\s*'([^']+)'/)?.[1]
  const publicKeyRegistry = sourceText.match(/publicKeyRegistry:\s*'([^']+)'/)?.[1]

  const poolIds = [...sourceText.matchAll(/id:\s*'([A-Z0-9]{56})'/g)].map((m) => m[1])
  const tokenContractIds = [...sourceText.matchAll(/tokenContractId:\s*'([A-Z0-9]{56})'/g)].map(
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

export function diffSppDeployments(pinned, upstream) {
  const diffs = []

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

  return diffs
}

export async function fetchUpstreamDeployments(timeoutMs = 10_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    let res = null
    try {
      res = await fetch(UPSTREAM_RAW_URL, {
        signal: controller.signal,
        headers: { 'User-Agent': 'veil-drift-sentry' },
      })
    } catch {
      res = await fetch(UPSTREAM_API_URL, {
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
  const { warnOnly, json } = parseArgs()

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

  const diffs = diffSppDeployments(pinned, fetchResult.data)

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
    console.log('## SPP testnet config drift detected')
    console.log()
    console.log(`Detected ${diffs.length} field(s) where pinned config differs from NethermindEth/stellar-private-payments:`)
    console.log()
    console.log('| Field | Pinned (Veil) | Upstream (Nethermind) |')
    console.log('|---|---|---|')
    for (const d of diffs) {
      console.log(`| \`${d.field}\` | \`${d.pinned}\` | \`${d.upstream}\` |`)
    }
    console.log()
    console.log('### Required action')
    console.log('Update `frontend/wallet/lib/privacy/config.ts` to match the upstream contract IDs.')
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

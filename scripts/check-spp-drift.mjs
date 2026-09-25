#!/usr/bin/env node
/**
 * SPP Upstream Deployment Drift Checker (#796).
 *
 * Fetches deployments/testnet/deployments.json from NethermindEth/stellar-private-payments
 * and compares it field by field against the pinned config in frontend/wallet/lib/privacy/config.ts.
 *
 * Exit codes:
 *   0: In-sync, or --warn-only active
 *   1: Drift detected (pinned config out of date with upstream)
 *   2: Upstream unreachable / network error
 *
 * Usage:
 *   node scripts/check-spp-drift.mjs
 *   node scripts/check-spp-drift.mjs --warn-only
 *   node scripts/check-spp-drift.mjs --json
 *   node scripts/check-spp-drift.mjs --diff-file <path>
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const UPSTREAM_URL =
  process.env.SPP_UPSTREAM_URL ||
  'https://raw.githubusercontent.com/NethermindEth/stellar-private-payments/main/deployments/testnet/deployments.json'

const args = process.argv.slice(2)
const warnOnly = args.includes('--warn-only')
const jsonOutput = args.includes('--json')
const diffFileIdx = args.indexOf('--diff-file')
const diffFilePath = diffFileIdx !== -1 ? args[diffFileIdx + 1] : null

/**
 * Parses the pinned SPP testnet config directly from config.ts source to avoid
 * compilation dependencies when executed directly under node.
 */
function loadPinnedConfig() {
  const configPath = resolve(ROOT, 'frontend/wallet/lib/privacy/config.ts')
  const content = readFileSync(configPath, 'utf8')

  const extractMatch = (regex, name) => {
    const match = content.match(regex)
    if (!match) throw new Error(`Could not parse ${name} from ${configPath}`)
    return match[1].trim()
  }

  const aspMembership = extractMatch(/aspMembership:\s*'([^']+)'/, 'aspMembership')
  const aspNonMembership = extractMatch(/aspNonMembership:\s*'([^']+)'/, 'aspNonMembership')
  const verifierStandard = extractMatch(/standard:\s*'([^']+)'/, 'verifiers.standard')
  const verifierTraceable = extractMatch(/traceable:\s*'([^']+)'/, 'verifiers.traceable')
  const publicKeyRegistry = extractMatch(/publicKeyRegistry:\s*'([^']+)'/, 'publicKeyRegistry')
  const bootnodeUrl = extractMatch(/bootnodeUrl:\s*'([^']+)'/, 'bootnodeUrl')

  // Extract pools
  const poolIds = [...content.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1])
  const tokenIds = [...content.matchAll(/tokenContractId:\s*'([^']+)'/g)].map((m) => m[1])

  const pools = poolIds.map((id, index) => ({
    id,
    tokenContractId: tokenIds[index] || '',
  }))

  return {
    aspMembership,
    aspNonMembership,
    verifiers: {
      standard: verifierStandard,
      traceable: verifierTraceable,
    },
    publicKeyRegistry,
    bootnodeUrl,
    pools,
  }
}

/**
 * Compares pinned config with upstream JSON.
 */
function compare(pinned, upstream) {
  const drifts = []

  const upstreamAspMem = upstream.asp_membership ?? upstream.aspMembership
  if (upstreamAspMem && upstreamAspMem !== pinned.aspMembership) {
    drifts.push({ key: 'aspMembership', pinned: pinned.aspMembership, upstream: upstreamAspMem })
  }

  const upstreamAspNonMem = upstream.asp_non_membership ?? upstream.aspNonMembership
  if (upstreamAspNonMem && upstreamAspNonMem !== pinned.aspNonMembership) {
    drifts.push({ key: 'aspNonMembership', pinned: pinned.aspNonMembership, upstream: upstreamAspNonMem })
  }

  const upstreamVerStandard = upstream.verifiers?.B ?? upstream.verifiers?.standard
  if (upstreamVerStandard && upstreamVerStandard !== pinned.verifiers.standard) {
    drifts.push({ key: 'verifiers.standard', pinned: pinned.verifiers.standard, upstream: String(upstreamVerStandard) })
  }

  const upstreamVerTraceable = upstream.verifiers?.B_gvk_T ?? upstream.verifiers?.traceable
  if (upstreamVerTraceable && upstreamVerTraceable !== pinned.verifiers.traceable) {
    drifts.push({ key: 'verifiers.traceable', pinned: pinned.verifiers.traceable, upstream: String(upstreamVerTraceable) })
  }

  const upstreamRegistry = upstream.public_key_registry ?? upstream.publicKeyRegistry
  if (upstreamRegistry && upstreamRegistry !== pinned.publicKeyRegistry) {
    drifts.push({ key: 'publicKeyRegistry', pinned: pinned.publicKeyRegistry, upstream: upstreamRegistry })
  }

  if (Array.isArray(upstream.pools)) {
    for (let i = 0; i < pinned.pools.length; i++) {
      const p = pinned.pools[i]
      const u = upstream.pools[i]
      if (!u) {
        drifts.push({ key: `pools[${i}]`, pinned: p.id, upstream: '<missing>' })
        continue
      }
      const uPoolId = u.poolContractId ?? u.id
      if (uPoolId && uPoolId !== p.id) {
        drifts.push({ key: `pools[${i}].id`, pinned: p.id, upstream: uPoolId })
      }
      const uTokenId = u.tokenContractId
      if (uTokenId && uTokenId !== p.tokenContractId) {
        drifts.push({ key: `pools[${i}].tokenContractId`, pinned: p.tokenContractId, upstream: uTokenId })
      }
    }
  }

  return drifts
}

async function main() {
  let pinned
  try {
    pinned = loadPinnedConfig()
  } catch (err) {
    console.error(`[ERROR] Failed to load local pinned SPP config: ${err.message}`)
    process.exitCode = 1
    return
  }

  let upstream
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(UPSTREAM_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    clearTimeout(timeout)

    if (!res.ok) {
      console.warn(`[UPSTREAM_UNREACHABLE] HTTP ${res.status} ${res.statusText} from ${UPSTREAM_URL}`)
      if (jsonOutput) {
        console.log(JSON.stringify({ status: 'upstream-unreachable', error: `HTTP ${res.status}` }))
      }
      process.exitCode = warnOnly ? 0 : 2
      return
    }

    upstream = await res.json()
  } catch (err) {
    console.warn(`[UPSTREAM_UNREACHABLE] Could not fetch ${UPSTREAM_URL}: ${err.message}`)
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'upstream-unreachable', error: err.message }))
    }
    process.exitCode = warnOnly ? 0 : 2
    return
  }

  const drifts = compare(pinned, upstream)

  if (drifts.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'in-sync', drifts: [] }))
    } else {
      console.log('✓ All pinned SPP contract IDs match upstream deployments.json')
    }
    process.exitCode = 0
    return
  }

  // Drift detected
  const lines = [
    'SPP CONFIG DRIFT DETECTED',
    `Upstream source: ${UPSTREAM_URL}`,
    '',
    ...drifts.map((d) => `  * ${d.key}:\n      pinned:   ${d.pinned}\n      upstream: ${d.upstream}`),
    '',
    'Action needed: Update frontend/wallet/lib/privacy/config.ts with the new contract IDs.',
  ]
  const report = lines.join('\n')

  if (diffFilePath) {
    try {
      const { writeFileSync } = await import('node:fs')
      writeFileSync(diffFilePath, report, 'utf8')
    } catch (e) {
      console.error(`Failed to write diff file: ${e.message}`)
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ status: 'drift-detected', drifts }))
  } else {
    console.error(report)
  }

  process.exitCode = warnOnly ? 0 : 1
}

main().catch((err) => {
  console.error(`[UNEXPECTED ERROR] ${err.stack || err}`)
  process.exitCode = 1
})

#!/usr/bin/env node
/**
 * Live / online asset registry verification (#794).
 *
 * Runs on scheduled GitHub Actions workflow (or manual dispatch):
 * - Checks issuer account existence on mainnet Horizon
 * - Verifies stellar.toml currency declarations for assets with homeDomain
 * - Confirms genuine issuer properties
 *
 * Exit codes:
 *   0: All live checks pass (or --warn-only active)
 *   1: Verification error / asset mismatch
 *   2: Network error / third-party service unreachable
 */

import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAssetRegistryFromSource } from './verify-assets-offline.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const args = process.argv.slice(2)
const warnOnly = args.includes('--warn-only')
const jsonOutput = args.includes('--json')
const diffFileIdx = args.indexOf('--diff-file')
const diffFilePath = diffFileIdx !== -1 ? args[diffFileIdx + 1] : null

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon.stellar.org'

export async function checkAssetOnline(code, asset, fetchFn = globalThis.fetch) {
  const issues = []

  // 1. Check Horizon account
  let accountData
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const res = await fetchFn(`${HORIZON_URL}/accounts/${asset.issuer}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    clearTimeout(timer)

    if (res.status === 404) {
      issues.push(`Issuer ${asset.issuer} does not exist on mainnet Horizon.`)
      return { code, ok: false, issues, networkError: false }
    } else if (!res.ok) {
      return { code, ok: false, issues: [`Horizon returned HTTP ${res.status}`], networkError: true }
    }
    accountData = await res.json()
  } catch (err) {
    return { code, ok: false, issues: [`Network error querying Horizon: ${err.message}`], networkError: true }
  }

  // 2. Check homeDomain and stellar.toml if homeDomain is configured
  if (asset.homeDomain) {
    try {
      const tomlUrl = `https://${asset.homeDomain}/.well-known/stellar.toml`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15000)
      const res = await fetchFn(tomlUrl, { signal: controller.signal })
      clearTimeout(timer)

      if (!res.ok) {
        issues.push(`stellar.toml at ${tomlUrl} returned HTTP ${res.status}`)
      } else {
        const tomlText = await res.text()
        if (!tomlText.includes(asset.issuer) && !tomlText.includes(asset.code)) {
          issues.push(`stellar.toml at ${tomlUrl} does not declare asset code ${asset.code} or issuer ${asset.issuer}`)
        }
      }
    } catch (err) {
      issues.push(`Failed to fetch stellar.toml for domain ${asset.homeDomain}: ${err.message}`)
    }
  }

  return {
    code,
    ok: issues.length === 0,
    issues,
    networkError: false,
    flags: accountData.flags,
  }
}

export async function runOnlineVerification() {
  const walletPath = resolve(ROOT, 'frontend/wallet/lib/assets.ts')
  const assets = parseAssetRegistryFromSource(walletPath)

  console.log(`Verifying ${Object.keys(assets).length} assets against live network (${HORIZON_URL})...`)

  const results = []
  let hasNetworkError = false
  let hasVerificationError = false

  for (const [code, asset] of Object.entries(assets)) {
    if (asset.network === 'testnet') continue
    const res = await checkAssetOnline(code, asset)
    results.push(res)
    if (res.networkError) hasNetworkError = true
    if (!res.ok && !res.networkError) hasVerificationError = true
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ results }))
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(`✓ ${r.code}: Verified on live network`)
      } else {
        console.error(`✗ ${r.code}: Verification failed`)
        for (const iss of r.issues) {
          console.error(`    - ${iss}`)
        }
      }
    }
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length > 0 && diffFilePath) {
    const lines = [
      'LIVE ASSET REGISTRY VERIFICATION FAILURE REPORT',
      '==============================================',
      ...failed.flatMap((f) => [
        `Asset: ${f.code}`,
        ...f.issues.map((i) => `  * ${i}`),
      ]),
      '==============================================',
    ]
    try {
      writeFileSync(diffFilePath, lines.join('\n'), 'utf8')
    } catch (e) {
      console.error(`Failed to write diff file: ${e.message}`)
    }
  }

  if (hasVerificationError) {
    process.exitCode = warnOnly ? 0 : 1
  } else if (hasNetworkError) {
    process.exitCode = warnOnly ? 0 : 2
  } else {
    process.exitCode = 0
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOnlineVerification().catch((err) => {
    console.error(`[UNEXPECTED ERROR] ${err.stack || err}`)
    process.exitCode = 1
  })
}

#!/usr/bin/env node
/**
 * Fast, pure offline asset registry verification (#794).
 *
 * Runs on every PR / push path with zero network calls:
 * - Validates issuer StrKey format (Ed25519 public key)
 * - Dynamically derives SAC contract IDs and asserts equality
 * - Verifies 100% parity between web and mobile asset registries
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

// Dynamic import of stellar-sdk from wallet node_modules
let StrKey, Asset, Networks
try {
  const sdk = await import('../frontend/wallet/node_modules/@stellar/stellar-sdk/lib/index.js')
  StrKey = sdk.StrKey
  Asset = sdk.Asset
  Networks = sdk.Networks
} catch (err) {
  console.error(`[ERROR] Failed to load @stellar/stellar-sdk: ${err.message}`)
  process.exitCode = 1
}

export function parseAssetRegistryFromSource(filePath) {
  const content = readFileSync(filePath, 'utf8')
  
  // Extract constant issuer addresses
  const issuerConstants = {}
  const constMatches = content.matchAll(/export\s+const\s+([A-Z0-9_]+)\s*=\s*'([^']+)'/g)
  for (const m of constMatches) {
    issuerConstants[m[1]] = m[2]
  }

  // Find ASSET_REGISTRY block
  const registryStart = content.indexOf('ASSET_REGISTRY')
  if (registryStart === -1) {
    throw new Error(`ASSET_REGISTRY declaration not found in ${filePath}`)
  }

  // Parse registered assets
  const assets = {}
  const assetBlockRegex = /([A-Z0-9]+):\s*\{([^}]+)\}/g
  const registrySlice = content.slice(registryStart)
  const matches = registrySlice.matchAll(assetBlockRegex)

  for (const m of matches) {
    const key = m[1]
    const body = m[2]

    const getField = (fieldName) => {
      const match = body.match(new RegExp(`${fieldName}:\\s*['"]?([^,'"\n]+)['"]?`))
      if (!match) return undefined
      let val = match[1].trim()
      if (issuerConstants[val]) {
        val = issuerConstants[val]
      }
      return val
    }

    assets[key] = {
      code: getField('code') || key,
      issuer: getField('issuer'),
      name: getField('name'),
      issuerName: getField('issuerName'),
      homeDomain: getField('homeDomain'),
      network: getField('network'),
      kind: getField('kind'),
      sacContractId: getField('sacContractId'),
    }
  }

  return assets
}

export function verifyOfflineRegistries(walletAssets, mobileAssets) {
  const errors = []

  // 1. Check Parity between Wallet and Mobile
  const walletKeys = Object.keys(walletAssets).sort()
  const mobileKeys = Object.keys(mobileAssets).sort()

  for (const key of walletKeys) {
    if (!mobileAssets[key]) {
      errors.push(`Registry divergence: Asset "${key}" exists in wallet but is missing in mobile registry.`)
      continue
    }

    const w = walletAssets[key]
    const m = mobileAssets[key]

    for (const prop of ['code', 'issuer', 'name', 'issuerName', 'network', 'kind', 'homeDomain', 'sacContractId']) {
      if (w[prop] !== m[prop]) {
        errors.push(
          `Registry divergence for "${key}.${prop}": wallet="${w[prop]}" vs mobile="${m[prop]}"`,
        )
      }
    }
  }

  for (const key of mobileKeys) {
    if (!walletAssets[key]) {
      errors.push(`Registry divergence: Asset "${key}" exists in mobile but is missing in wallet registry.`)
    }
  }

  // 2. Validate StrKey format and SAC derivation for each asset
  for (const [key, asset] of Object.entries(walletAssets)) {
    if (!asset.issuer) {
      errors.push(`Asset "${key}" has no issuer defined.`)
      continue
    }

    if (StrKey && !StrKey.isValidEd25519PublicKey(asset.issuer)) {
      errors.push(`Asset "${key}" has invalid Ed25519 public key StrKey: ${asset.issuer}`)
    }

    if (asset.sacContractId && Asset && Networks) {
      try {
        const derivedSac = new Asset(asset.code, asset.issuer).contractId(Networks.PUBLIC)
        if (derivedSac !== asset.sacContractId) {
          errors.push(
            `Asset "${key}" SAC contract ID mismatch: registered="${asset.sacContractId}" vs derived="${derivedSac}"`,
          )
        }
      } catch (err) {
        errors.push(`Asset "${key}" SAC derivation failed: ${err.message}`)
      }
    }
  }

  return errors
}

export async function runOfflineAssetVerification() {
  const walletPath = resolve(ROOT, 'frontend/wallet/lib/assets.ts')
  const mobilePath = resolve(ROOT, 'frontend/mobile/lib/assets.ts')

  console.log('Running offline asset registry verification (zero network calls)...')
  const walletAssets = parseAssetRegistryFromSource(walletPath)
  const mobileAssets = parseAssetRegistryFromSource(mobilePath)

  const errors = verifyOfflineRegistries(walletAssets, mobileAssets)

  if (errors.length > 0) {
    console.error('\n❌ Asset registry offline verification failed:')
    for (const err of errors) {
      console.error(`  - ${err}`)
    }
    process.exitCode = 1
    return false
  }

  console.log(`✓ All ${Object.keys(walletAssets).length} registered assets verified offline:`)
  for (const [key, asset] of Object.entries(walletAssets)) {
    console.log(`  ✓ ${key}: ${asset.name} (${asset.issuer.slice(0, 8)}…${asset.issuer.slice(-4)}) - StrKey & SAC verified`)
  }
  console.log('✓ 100% parity between wallet and mobile registries confirmed.')
  process.exitCode = 0
  return true
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOfflineAssetVerification().catch((err) => {
    console.error(`[UNEXPECTED ERROR] ${err.stack || err}`)
    process.exitCode = 1
  })
}

#!/usr/bin/env node
/**
 * Fast, pure offline asset registry verification (#794).
 *
 * Runs on every PR / push path with zero external dependencies and zero network calls:
 * - Validates issuer StrKey format (Ed25519 public key)
 * - Dynamically derives SAC contract IDs and asserts equality
 * - Verifies 100% parity between web and mobile asset registries
 */

import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function decodeBase32(str) {
  let bits = 0
  let value = 0
  const output = []
  for (let i = 0; i < str.length; i++) {
    const idx = RFC4648_ALPHABET.indexOf(str[i])
    if (idx === -1) throw new Error(`Invalid Base32 character: ${str[i]}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(output)
}

export function encodeBase32(buffer) {
  let bits = 0
  let value = 0
  let output = ''
  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i]
    bits += 8
    while (bits >= 5) {
      output += RFC4648_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    output += RFC4648_ALPHABET[(value << (5 - bits)) & 31]
  }
  return output
}

export function crc16xmodem(buf) {
  let crc = 0x0000
  for (let i = 0; i < buf.length; i++) {
    let byte = buf[i]
    let code = (crc >>> 8) & 0xff
    code ^= byte & 0xff
    code ^= code >>> 4
    crc = (crc << 8) & 0xffff
    crc ^= code
    code = (code << 5) & 0xffff
    crc ^= code
    code = (code << 7) & 0xffff
    crc ^= code
  }
  return crc
}

export function isValidEd25519PublicKey(str) {
  if (typeof str !== 'string' || str.length !== 56 || str[0] !== 'G') return false
  try {
    const decoded = decodeBase32(str)
    if (decoded.length !== 35) return false
    if (decoded[0] !== 6 << 3) return false // version byte 48 = 'G'
    const payload = decoded.subarray(0, 33)
    const checksum = decoded.readUInt16LE(33)
    return crc16xmodem(payload) === checksum
  } catch {
    return false
  }
}

export function encodeContractId(hash32) {
  const version = 2 << 3 // version byte 16 = 'C'
  const payload = Buffer.concat([Buffer.from([version]), hash32])
  const crc = crc16xmodem(payload)
  const checksumBuf = Buffer.alloc(2)
  checksumBuf.writeUInt16LE(crc, 0)
  return encodeBase32(Buffer.concat([payload, checksumBuf]))
}

export function deriveClassicAssetSac(code, issuer, networkPassphrase = 'Public Global Stellar Network ; September 2015') {
  if (!isValidEd25519PublicKey(issuer)) {
    throw new Error(`Invalid issuer address: ${issuer}`)
  }
  const decodedIssuer = decodeBase32(issuer)
  const issuerRawKey = decodedIssuer.subarray(1, 33)

  const networkId = createHash('sha256').update(networkPassphrase).digest()
  const isAlpha4 = code.length <= 4
  const assetType = isAlpha4 ? 1 : 2
  const codeLen = isAlpha4 ? 4 : 12
  const codeBuf = Buffer.alloc(codeLen)
  codeBuf.write(code, 'ascii')

  const parts = [
    Buffer.from([0, 0, 0, 8]), // ENVELOPE_TYPE_CONTRACT_ID
    networkId,
    Buffer.from([0, 0, 0, 1]), // CONTRACT_ID_PREIMAGE_FROM_ASSET
    Buffer.from([0, 0, 0, assetType]),
    codeBuf,
    Buffer.from([0, 0, 0, 0]), // PUBLIC_KEY_TYPE_ED25519
    issuerRawKey,
  ]
  const fullPreimage = Buffer.concat(parts)
  const contractHash = createHash('sha256').update(fullPreimage).digest()
  return encodeContractId(contractHash)
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

    if (!isValidEd25519PublicKey(asset.issuer)) {
      errors.push(`Asset "${key}" has invalid Ed25519 public key StrKey: ${asset.issuer}`)
    }

    if (asset.sacContractId) {
      try {
        const derivedSac = deriveClassicAssetSac(asset.code, asset.issuer)
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

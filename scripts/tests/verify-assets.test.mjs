import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseAssetRegistryFromSource,
  verifyOfflineRegistries,
} from '../verify-assets-offline.mjs'
import { checkAssetOnline } from '../verify-assets-online.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../..')

describe('offline asset registry verification', () => {
  const walletPath = resolve(ROOT, 'frontend/wallet/lib/assets.ts')
  const mobilePath = resolve(ROOT, 'frontend/mobile/lib/assets.ts')

  test('parses asset registry from real wallet and mobile sources', () => {
    const walletAssets = parseAssetRegistryFromSource(walletPath)
    const mobileAssets = parseAssetRegistryFromSource(mobilePath)

    assert(walletAssets.USDT0, 'walletAssets should contain USDT0')
    assert(walletAssets.USDC, 'walletAssets should contain USDC')
    assert(walletAssets.USDY, 'walletAssets should contain USDY')

    assert(mobileAssets.USDT0, 'mobileAssets should contain USDT0')
    assert(mobileAssets.USDC, 'mobileAssets should contain USDC')
    assert(mobileAssets.USDY, 'mobileAssets should contain USDY')
  })

  test('passes offline verification on current in-sync codebase', () => {
    const walletAssets = parseAssetRegistryFromSource(walletPath)
    const mobileAssets = parseAssetRegistryFromSource(mobilePath)

    const errors = verifyOfflineRegistries(walletAssets, mobileAssets)
    assert.equal(errors.length, 0, `Expected 0 errors, got: ${errors.join('; ')}`)
  })

  test('detects registry divergence when mobile is missing an asset', () => {
    const mockWallet = {
      USDT0: {
        code: 'USDT0',
        issuer: 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q',
        name: 'Tether USD',
        sacContractId: 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF',
      },
    }
    const mockMobile = {}

    const errors = verifyOfflineRegistries(mockWallet, mockMobile)
    assert(errors.some((e) => e.includes('missing in mobile registry')))
  })

  test('detects invalid StrKey issuer address', () => {
    const mockWallet = {
      TEST: {
        code: 'TEST',
        issuer: 'NOT_A_VALID_STRKEY_ADDRESS',
        name: 'Test Asset',
      },
    }
    const mockMobile = { ...mockWallet }

    const errors = verifyOfflineRegistries(mockWallet, mockMobile)
    assert(errors.some((e) => e.includes('invalid Ed25519 public key StrKey')))
  })

  test('detects mismatched SAC contract ID', () => {
    const mockWallet = {
      USDT0: {
        code: 'USDT0',
        issuer: 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q',
        name: 'Tether USD',
        sacContractId: 'CWRONGSACCONTRACTIDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      },
    }
    const mockMobile = { ...mockWallet }

    const errors = verifyOfflineRegistries(mockWallet, mockMobile)
    assert(errors.some((e) => e.includes('SAC contract ID mismatch')))
  })
})

describe('online asset verification', () => {
  test('handles simulated horizon 404', async () => {
    const mockFetch = async () => ({
      status: 404,
      ok: false,
    })

    const res = await checkAssetOnline(
      'USDT0',
      { issuer: 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q' },
      mockFetch,
    )
    assert.equal(res.ok, false)
    assert(res.issues[0].includes('does not exist on mainnet Horizon'))
  })

  test('handles simulated network failure', async () => {
    const mockFetch = async () => {
      throw new Error('Connection refused')
    }

    const res = await checkAssetOnline(
      'USDT0',
      { issuer: 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q' },
      mockFetch,
    )
    assert.equal(res.ok, false)
    assert.equal(res.networkError, true)
    assert(res.issues[0].includes('Network error querying Horizon'))
  })
})

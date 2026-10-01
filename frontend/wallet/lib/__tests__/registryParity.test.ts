// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

/**
 * #792 — the web wallet's side of the registry parity check.
 *
 * Mirrors `frontend/mobile/lib/__tests__/registryParity.test.ts` (the full
 * check, lookups included) so an edit to `lib/assets.ts` here fails in the
 * wallet's own test run, not only in the mobile job. If this fails, make the
 * same change in `frontend/mobile/lib/assets.ts`. Do not "fix" it here.
 */

import { Asset, Networks } from '@stellar/stellar-sdk'
import * as wallet from '../assets'

// The mobile registry module also reads the stored wallet key through
// AsyncStorage, a React Native module the web wallet does not install. The
// registry itself never touches it.
jest.mock('@react-native-async-storage/async-storage', () => ({ getItem: jest.fn() }), { virtual: true })
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mobile = require('../../../mobile/lib/assets') as typeof wallet

const USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'

describe('wallet and mobile asset registries are identical — edit both lib/assets.ts together', () => {
  it('list the same assets', () => {
    expect(Object.keys(wallet.ASSET_REGISTRY).sort()).toEqual(Object.keys(mobile.ASSET_REGISTRY).sort())
  })

  it.each(Object.keys(wallet.ASSET_REGISTRY))('hold the same %s entry, field for field', (code) => {
    expect(wallet.ASSET_REGISTRY[code]).toEqual(mobile.ASSET_REGISTRY[code])
  })

  it('export the same pinned issuers and SAC', () => {
    expect(wallet.USDY_MAINNET_ISSUER).toBe(mobile.USDY_MAINNET_ISSUER)
    expect(wallet.USDT0_MAINNET_ISSUER).toBe(mobile.USDT0_MAINNET_ISSUER)
    expect(wallet.USDT0_MAINNET_SAC).toBe(mobile.USDT0_MAINNET_SAC)
  })

  it.each(['mainnet', 'testnet'] as const)('resolve the same issuers on %s', (network) => {
    for (const code of Object.keys(wallet.ASSET_REGISTRY)) {
      expect([code, mobile.getAssetIssuer(code, network)]).toEqual([code, wallet.getAssetIssuer(code, network)])
    }
  })

  it('pin USDT0 to its genuine issuer, with the SAC derived rather than pasted', () => {
    const derived = new Asset('USDT0', USDT0_ISSUER).contractId(Networks.PUBLIC)
    expect(derived).toBe('CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF')
    for (const registry of [wallet, mobile]) {
      expect(registry.ASSET_REGISTRY['USDT0']).toMatchObject({ issuer: USDT0_ISSUER, sacContractId: derived })
    }
  })
})

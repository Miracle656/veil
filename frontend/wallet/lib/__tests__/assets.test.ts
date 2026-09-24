import { Asset, Networks } from '@stellar/stellar-sdk'
import {
  ASSET_REGISTRY,
  USDT0_MAINNET_ISSUER,
  USDT0_MAINNET_SAC_CONTRACT_ID,
  getRegisteredAsset,
  getAssetIssuer,
  isRegisteredIssuer,
} from '../assets'

describe('USDT0 asset registry (#787)', () => {
  it('dynamically derives the SAC contract ID from asset and issuer on public network', () => {
    const derivedSac = new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC)
    expect(derivedSac).toBe(USDT0_MAINNET_SAC_CONTRACT_ID)
    expect(derivedSac).toBe(ASSET_REGISTRY.USDT0.contractId)
  })

  it('registers USDT0 with the canonical issuer and without a homeDomain', () => {
    const usdt0 = ASSET_REGISTRY.USDT0
    expect(usdt0).toBeDefined()
    expect(usdt0.code).toBe('USDT0')
    expect(usdt0.issuer).toBe('GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q')
    expect(usdt0.kind).toBe('stablecoin')
    expect(usdt0.network).toBe('mainnet')
    expect(usdt0.homeDomain).toBeUndefined()
  })

  it('offers USDT0 on mainnet only, returning null on testnet', () => {
    expect(getRegisteredAsset('USDT0', 'mainnet')).toBeDefined()
    expect(getRegisteredAsset('USDT0', 'testnet')).toBeNull()

    expect(getAssetIssuer('USDT0', 'mainnet')).toBe(USDT0_MAINNET_ISSUER)
    expect(getAssetIssuer('USDT0', 'testnet')).toBeNull()
  })

  it('verifies genuine USDT0 issuer and rejects impostor issuers', () => {
    // Genuine issuer
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(true)
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'testnet')).toBe(false)

    // Impostors with fake domains or matching asset codes
    const impostors = [
      'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK', // quantumsystem.cc
      'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT', // stellarusdtzero.com
      'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT', // usd-t0.com
      'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3', // cryptos.litemint.store
    ]

    for (const impostor of impostors) {
      expect(isRegisteredIssuer('USDT0', impostor, 'mainnet')).toBe(false)
    }
  })
})

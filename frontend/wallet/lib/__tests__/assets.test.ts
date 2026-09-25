// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Asset, Networks } from '@stellar/stellar-sdk'
import {
  ASSET_REGISTRY,
  USDT0_MAINNET_ISSUER,
  USDT0_MAINNET_SAC,
  getAssetIssuer,
  getRegisteredAsset,
  isRegisteredIssuer,
} from '../assets'

describe('Verified Asset Registry - USDT0 (Issue #787)', () => {
  it('USDT0 resolves to exactly the pinned issuer on mainnet', () => {
    const asset = getRegisteredAsset('USDT0')
    expect(asset).not.toBeNull()
    expect(asset?.code).toBe('USDT0')
    expect(asset?.issuer).toBe(USDT0_MAINNET_ISSUER)
    expect(asset?.issuer).toBe('GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q')
    expect(asset?.network).toBe('mainnet')
    expect(asset?.kind).toBe('stablecoin')
    expect(asset?.homeDomain).toBeUndefined()
  })

  it('derives the SAC contract ID dynamically from issuer and asserts equality with stored value', () => {
    // Acceptance criterion: A test derives the SAC rather than asserting a pasted literal
    const derivedContractId = new Asset('USDT0', USDT0_MAINNET_ISSUER).contractId(Networks.PUBLIC)
    expect(derivedContractId).toBe(USDT0_MAINNET_SAC)
    expect(derivedContractId).toBe('CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF')
    expect(ASSET_REGISTRY.USDT0.sacContractId).toBe(derivedContractId)
  })

  it('does not offer USDT0 on testnet', () => {
    // Acceptance criterion: Nothing offers USDT0 on testnet
    expect(getRegisteredAsset('USDT0', 'testnet')).toBeNull()
    expect(getAssetIssuer('USDT0', 'testnet')).toBeNull()
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'testnet')).toBe(false)
  })

  it('offers USDT0 on mainnet', () => {
    expect(getRegisteredAsset('USDT0', 'mainnet')?.issuer).toBe(USDT0_MAINNET_ISSUER)
    expect(getAssetIssuer('USDT0', 'mainnet')).toBe(USDT0_MAINNET_ISSUER)
    expect(isRegisteredIssuer('USDT0', USDT0_MAINNET_ISSUER, 'mainnet')).toBe(true)
  })

  it('rejects trustlines with code USDT0 and any impostor issuer', () => {
    // Acceptance criterion: A trustline with code USDT0 and any other issuer is not treated as USDT0
    const IMPOSTOR_ISSUERS = [
      'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK', // quantumsystem.cc
      'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT', // stellarusdtzero.com
      'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT', // usd-t0.com
      'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3', // cryptos.litemint.store
      'GA7GNGYVJHF7LTI6OO4FAD2JEQBIQWRBIZOLEZSJJHMNAY6UUZERU526', // stellar-reserve.com
      'GAVRQZHG726XIHZKP3MODI3DOUP7IIQ6CC6OJX4JJD7PXRV4FJ3WE77O', // tokenize.litemint.store
      'GDBDGR2U3KVHUGJ5SVALIAPT7FBPSYWD25XTF4JPHTPBKFH2SHOOHZFF',
    ]

    for (const impostor of IMPOSTOR_ISSUERS) {
      expect(isRegisteredIssuer('USDT0', impostor, 'mainnet')).toBe(false)
    }
  })
})

import { beforeAll, describe, expect, it, jest } from '@jest/globals'
import { Networks, StrKey } from '@stellar/stellar-sdk'
import {
  ALL_REGISTERED_ASSETS,
  USDT0_MAINNET_ISSUER,
  classifyBalances,
  classifyHolding,
  deriveSac,
  describeAsset,
  registeredAsset,
} from '../assets.js'

jest.unstable_mockModule('@soroswap/sdk', () => ({
  SoroswapSDK: jest.fn(),
  SupportedNetworks: { MAINNET: 'mainnet' },
  SupportedProtocols: {},
  TradeType: {},
}))

let resolveAsset: typeof import('../price.js').resolveAsset

// Derived from USDT0_MAINNET_ISSUER via deriveSac
const USDT0_MAINNET_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF'

// Impostor issuers of an asset also called USDT0 (mainnet Horizon, 2026-09-24).
const FAKE_A = 'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK'
const FAKE_B = 'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT'

describe('pinned USDT0 constants', () => {
  it('are checksum-valid, not just the right shape', () => {
    expect(StrKey.isValidEd25519PublicKey(USDT0_MAINNET_ISSUER)).toBe(true)
    expect(StrKey.isValidContract(USDT0_MAINNET_SAC)).toBe(true)
    expect(StrKey.isValidEd25519PublicKey(FAKE_A)).toBe(true)
    expect(StrKey.isValidEd25519PublicKey(FAKE_B)).toBe(true)
  })

  it('derive the pinned SAC from the issuer', () => {
    const usdt0 = registeredAsset('USDT0', 'mainnet')!
    expect(deriveSac(usdt0, Networks.PUBLIC)).toBe(USDT0_MAINNET_SAC)
    expect(usdt0.sac).toBe(USDT0_MAINNET_SAC)
  })
})

/**
 * Exhaustive, so adding an asset cannot skip the check.
 *
 * An invalid issuer has reached a PR four times now, and each time the
 * existing guards let it through: the registry-parity tests only compare the
 * three copies to each other, so an address wrong identically in all three is
 * agreed-upon rather than caught, and the assertions above cover only the
 * constants someone remembered to export. The failure is also inverted and
 * therefore quiet — an unparseable issuer makes the *genuine* asset look like
 * an impersonator, which reads as the verification working.
 *
 * `StrKey` verifies the CRC16-XModem checksum. A regex over length and the
 * base32 alphabet does not, and every bad address so far passed one.
 */
describe('every registered asset', () => {
  it.each(ALL_REGISTERED_ASSETS.map(({ network, asset }) => [network, asset.code, asset] as const))(
    '%s %s has a checksum-valid issuer',
    (_network, _code, asset) => {
      expect(StrKey.isValidEd25519PublicKey(asset.issuer)).toBe(true)
    },
  )

  it.each(
    ALL_REGISTERED_ASSETS.filter(({ asset }) => asset.sac).map(
      ({ network, asset }) => [network, asset.code, asset] as const,
    ),
  )('%s %s has a checksum-valid SAC that derives from its issuer', (network, _code, asset) => {
    expect(StrKey.isValidContract(asset.sac!)).toBe(true)
    // A pasted SAC that does not derive from the issuer is pinned to something
    // other than the asset it claims to be.
    expect(deriveSac(asset, network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET)).toBe(asset.sac)
  })

  it('is non-empty, so the assertions above cannot vacuously pass', () => {
    expect(ALL_REGISTERED_ASSETS.length).toBeGreaterThan(0)
  })
})

describe('classifyHolding', () => {
  it('a real USDT0 is verified and names its issuer', () => {
    const h = classifyHolding('USDT0', USDT0_MAINNET_ISSUER, '12.5000000', 'mainnet')
    expect(h.status).toBe('verified')
    expect(h.message).toContain(USDT0_MAINNET_ISSUER)
  })

  it('a fake USDT0 with the same code is unverified, with its issuer shown', () => {
    const h = classifyHolding('USDT0', FAKE_A, '999.0000000', 'mainnet')
    expect(h.status).toBe('unverified')
    expect(h.issuer).toBe(FAKE_A)
    expect(h.registeredIssuer).toBe(USDT0_MAINNET_ISSUER)
    expect(h.message).toMatch(/UNVERIFIED/)
    expect(h.message).toContain(FAKE_A)
  })

  it('never matches on code alone: case games do not verify either', () => {
    expect(classifyHolding('usdt0', FAKE_B, '1', 'mainnet').status).toBe('unverified')
  })

  it('has no verified USDT0 on testnet', () => {
    expect(classifyHolding('USDT0', USDT0_MAINNET_ISSUER, '1', 'testnet').status).toBe('unlisted')
  })

  it('claims nothing about a code that is not in the registry', () => {
    expect(classifyHolding('SCAM', FAKE_A, '1', 'mainnet').status).toBe('unlisted')
  })
})

describe('classifyBalances', () => {
  it('classifies issued assets from a getBalances result and skips XLM', () => {
    const holdings = classifyBalances(
      {
        XLM: '10.0000000',
        XLM_feepayer: '5.0000000',
        XLM_contract: '5.0000000',
        [`USDT0:${USDT0_MAINNET_ISSUER}`]: '3.0000000',
        [`USDT0:${FAKE_A}`]: '7.0000000',
      },
      'mainnet',
    )
    expect(holdings.map((h) => [h.issuer, h.status])).toEqual([
      [USDT0_MAINNET_ISSUER, 'verified'],
      [FAKE_A, 'unverified'],
    ])
  })
})

describe('describeAsset', () => {
  it('states the issuer and the clawback and freeze property', () => {
    const a = describeAsset('USDT0', 'mainnet')
    expect(a.issuer).toBe(USDT0_MAINNET_ISSUER)
    expect(a.sac).toBe(USDT0_MAINNET_SAC)
    expect(a.issuerControls).toEqual({ clawback: true, freeze: true })
    expect(a.message).toMatch(/claw back/)
    expect(a.message).toMatch(/freeze/)
  })

  it('checks a specific issuer', () => {
    expect(describeAsset(`USDT0:${USDT0_MAINNET_ISSUER}`, 'mainnet').status).toBe('verified')
    const fake = describeAsset(`USDT0:${FAKE_A}`, 'mainnet')
    expect(fake.status).toBe('unverified')
    expect(fake.message).toMatch(/UNVERIFIED/)
  })

  it('says so for an unregistered asset', () => {
    expect(describeAsset('SCAM', 'mainnet').status).toBe('unknown')
  })
})

describe('resolveAsset (via registry)', () => {
  beforeAll(async () => {
    ({ resolveAsset } = await import('../price.js'))
  })

  it('resolves bare USDC from the registry', () => {
    const usdc = registeredAsset('USDC', 'mainnet')
    expect(usdc).not.toBeNull()
    expect(resolveAsset('USDC').horizon).toBe(`USDC:${usdc?.issuer}`)
  })

  it('resolves every mainnet registry asset by its pinned issuer', () => {
    for (const { network, asset } of ALL_REGISTERED_ASSETS) {
      if (network === 'mainnet') {
        expect(resolveAsset(asset.code).horizon).toBe(`${asset.code}:${asset.issuer}`)
      }
    }
  })
})

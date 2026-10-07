import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { isPrivacyEnabled, getSppConfig } from '../privacy/config'
import {
  stroopsToXlm,
  withdrawableAssetCodes,
  xlmToStroops,
} from '../../app/privacy/unshield/amounts'

/**
 * Unshield moves money out of a shielded pool to a public address, so the
 * things worth pinning are the ones that decide whether it can run at all and
 * how much leaves: the mainnet lockout, which pools really exist, and the
 * amount arithmetic.
 */

describe('mainnet lockout', () => {
  it('is off on mainnet whatever the feature flag says', () => {
    // Unconditional, because there is no mainnet SPP deployment to talk to.
    expect(isPrivacyEnabled('mainnet')).toBe(false)
  })

  it('has no mainnet SPP configuration to point at', () => {
    expect(getSppConfig('mainnet')).toBeNull()
  })
})

describe('the pools that actually exist', () => {
  it('pins two testnet pools, both of them XLM', () => {
    const config = getSppConfig('testnet')
    expect(config).not.toBeNull()
    expect(config!.pools).toHaveLength(2)
    for (const pool of config!.pools) expect(pool.assetKind).toBe('native')
  })

  it('offers XLM and nothing else to withdraw', () => {
    // The screen used to offer USDC and EURC from a hand-written list. Neither
    // has a pool, so both were a flow that could only fail — and one of the two
    // issuer addresses in that list was not a valid Stellar address at all.
    expect(withdrawableAssetCodes('testnet')).toEqual(['XLM'])
  })

  it('offers nothing on mainnet', () => {
    expect(withdrawableAssetCodes('mainnet')).toEqual([])
  })
})

describe('amount arithmetic', () => {
  it('converts whole and fractional XLM to stroops', () => {
    expect(xlmToStroops('1')).toBe(10_000_000n)
    expect(xlmToStroops('0.0000001')).toBe(1n)
    expect(xlmToStroops('12.5')).toBe(125_000_000n)
  })

  it('round-trips through the display form', () => {
    for (const value of ['1', '0.0000001', '12.5', '1000000']) {
      expect(stroopsToXlm(xlmToStroops(value)!)).toBe(value)
    }
  })

  it('drops trailing zeros rather than printing them', () => {
    expect(stroopsToXlm(125_000_000n)).toBe('12.5')
    expect(stroopsToXlm(10_000_000n)).toBe('1')
  })

  it('refuses anything that is not a plain decimal amount', () => {
    // parseFloat would accept every one of these and hand back a number that
    // decides how much money leaves a shielded pool.
    for (const junk of ['', '  ', 'abc', '1.2.3', '1e9', '12abc', '-1', '.5', '1.00000001']) {
      expect(xlmToStroops(junk)).toBeNull()
    }
  })

  it('accepts surrounding whitespace, since people paste amounts', () => {
    expect(xlmToStroops('  2.5  ')).toBe(25_000_000n)
  })

  it('handles an amount larger than a double can hold exactly', () => {
    // The reason this is bigint arithmetic and not floating point.
    expect(xlmToStroops('9007199254.7409911')).toBe(90_071_992_547_409_911n)
  })
})

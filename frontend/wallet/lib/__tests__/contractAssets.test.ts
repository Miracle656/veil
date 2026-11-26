/**
 * @jest-environment node
 */

import { mergeAssetBalances } from '../contractAssets'
import type { WalletAsset } from '../walletTypes'

const USDC = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const EURC = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'

const asset = (code: string, issuer: string | null, balance: string): WalletAsset => ({
  code,
  issuer,
  balance,
})

describe('mergeAssetBalances', () => {
  it('sums the same asset held in both places', () => {
    // The whole bug: USDC on the fee-payer was shown, USDC in the contract was
    // not, and the contract is what pays for a name.
    const merged = mergeAssetBalances(
      [asset('USDC', USDC, '12.0000000')],
      [asset('USDC', USDC, '1.0000000')],
    )

    expect(merged).toHaveLength(1)
    expect(merged[0].balance).toBe('13.0000000')
  })

  it('keeps an asset only the contract holds', () => {
    const merged = mergeAssetBalances([], [asset('USDC', USDC, '3.0000000')])
    expect(merged).toEqual([asset('USDC', USDC, '3.0000000')])
  })

  it('keeps an asset only the fee-payer holds', () => {
    const merged = mergeAssetBalances([asset('USDC', USDC, '3.0000000')], [])
    expect(merged).toEqual([asset('USDC', USDC, '3.0000000')])
  })

  it('does not merge the same code from different issuers', () => {
    // Two issuers of "USDC" are two different assets, and treating them as one
    // would overstate a balance in a figure somebody spends against.
    const fake = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    const merged = mergeAssetBalances(
      [asset('USDC', USDC, '5.0000000')],
      [asset('USDC', fake, '5.0000000')],
    )

    expect(merged).toHaveLength(2)
    expect(merged.map((a) => a.balance).sort()).toEqual(['5.0000000', '5.0000000'])
  })

  it('keeps distinct assets apart', () => {
    const merged = mergeAssetBalances(
      [asset('USDC', USDC, '2.0000000')],
      [asset('EURC', EURC, '4.0000000')],
    )

    expect(merged).toHaveLength(2)
    expect(merged.find((a) => a.code === 'USDC')?.balance).toBe('2.0000000')
    expect(merged.find((a) => a.code === 'EURC')?.balance).toBe('4.0000000')
  })

  it('keeps seven decimal places, which is what Stellar carries', () => {
    const merged = mergeAssetBalances(
      [asset('USDC', USDC, '0.0000001')],
      [asset('USDC', USDC, '0.0000002')],
    )
    expect(merged[0].balance).toBe('0.0000003')
  })

  it('returns nothing when neither account holds anything', () => {
    expect(mergeAssetBalances([], [])).toEqual([])
  })
})

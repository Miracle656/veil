// @stellar/stellar-sdk needs TextEncoder at module load; jsdom omits it.
import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  MOVE_FEE_HEADROOM_XLM,
  movableWalletAssets,
  needXlmMessage,
  receiveReadiness,
} from '../moveFromWallet'

const USDC = { code: 'USDC', issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' }
const native = { asset_type: 'native', balance: '5.0000000' }
const usdcLine = {
  asset_type: 'credit_alphanum4',
  asset_code: USDC.code,
  asset_issuer: USDC.issuer,
  balance: '0.0000000',
}

describe('movableWalletAssets', () => {
  it('offers issued assets the wallet actually holds', () => {
    expect(
      movableWalletAssets([{ ...USDC, balance: '2.0000000' }]),
    ).toEqual([{ ...USDC, balance: '2.0000000' }])
  })

  it('leaves out XLM, which has its own button, and empty balances', () => {
    expect(
      movableWalletAssets([
        { code: 'XLM', issuer: null, balance: '3.0000000' },
        { ...USDC, balance: '0.0000000' },
        { ...USDC, balance: 'not a number' },
      ]),
    ).toEqual([])
  })
})

describe('receiveReadiness', () => {
  it('is ready when the spending account already trusts the asset', () => {
    // Even with no spare XLM: nothing new has to be locked.
    expect(receiveReadiness([native, usdcLine], '0', USDC)).toBe('ready')
  })

  it('does not take a trustline for the same code from another issuer', () => {
    const other = { ...usdcLine, asset_issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5' }
    expect(receiveReadiness([native, other], '5', USDC)).toBe('add-trustline')
  })

  it('adds the trustline when there is XLM to lock for it', () => {
    expect(receiveReadiness([native], '0.7', USDC)).toBe('add-trustline')
    expect(receiveReadiness([native], String(0.5 + MOVE_FEE_HEADROOM_XLM), USDC)).toBe('add-trustline')
  })

  it('stops before the network would refuse, when XLM is short', () => {
    // 1.0199900 XLM in an account with no trustlines is 0.0199900 spendable.
    expect(receiveReadiness([native], '0.0199900', USDC)).toBe('need-xlm')
    expect(receiveReadiness([native], '0.5', USDC)).toBe('need-xlm')
    expect(receiveReadiness([native], 'nope', USDC)).toBe('need-xlm')
  })
})

describe('needXlmMessage', () => {
  it('names the asset and says what to do', () => {
    expect(needXlmMessage('USDC')).toBe(
      'Your spending wallet needs about 1 XLM free before it can hold USDC. Add a little XLM, then try again.',
    )
  })
})

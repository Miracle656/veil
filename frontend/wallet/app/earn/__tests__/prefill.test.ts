import { TextDecoder, TextEncoder } from 'util'

Object.assign(globalThis, { TextDecoder, TextEncoder })

import { parseInvestIntent, parseInvestPrefill } from '../prefill'

const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

describe('investment prefill', () => {
  it('parses issuer-pinned intent and route parameters', () => {
    expect(parseInvestIntent({ asset: { code: 'usdy', issuer }, amount: '50' })).toEqual({
      asset: 'USDY',
      issuer,
      amount: '50',
    })
    expect(parseInvestPrefill(`?asset=usdy&issuer=${issuer}&amount=50`)).toEqual({
      asset: 'USDY',
      issuer,
      amount: '50',
    })
  })

  it('ignores malformed intents instead of producing a blank prefill', () => {
    expect(parseInvestIntent({ asset: { code: 'USDY', issuer: 'bad' }, amount: '50' })).toBeUndefined()
    expect(parseInvestPrefill('?asset=USDY&issuer=bad&amount=50')).toBeUndefined()
    expect(parseInvestPrefill(`?asset=USDY&issuer=${issuer}&amount=0`)).toBeUndefined()
  })
})

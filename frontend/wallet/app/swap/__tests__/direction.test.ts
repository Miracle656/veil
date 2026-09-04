import { resolveFlip } from '../direction'

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const XLM = { code: 'XLM', balance: '100.0' }
const USDC = { code: 'USDC', issuer: USDC_ISSUER, balance: '25.0' }

describe('resolveFlip', () => {
  it('flips XLM → USDC into USDC → XLM when both are held', () => {
    const flip = resolveFlip('XLM', 'USDC', [XLM, USDC], USDC_ISSUER)
    expect(flip?.nextSource).toBe(USDC)
    expect(flip?.nextDest.code).toBe('XLM')
  })

  it('carries the network-resolved USDC issuer onto the receive side', () => {
    const flip = resolveFlip('USDC', 'XLM', [XLM, USDC], USDC_ISSUER)
    expect(flip?.nextSource).toBe(XLM)
    expect(flip?.nextDest).toEqual({ code: 'USDC', issuer: USDC_ISSUER, balance: '0' })
  })

  // Regression: the flip used to null out the pay asset whenever the account
  // held no balance in the asset it was about to receive — the ordinary case of
  // buying USDC for the first time — which left the form unable to quote at all.
  it('refuses to flip when the receive asset is not held', () => {
    expect(resolveFlip('XLM', 'USDC', [XLM], USDC_ISSUER)).toBeNull()
  })

  // Regression: the receive picker lists USDC and XLM only, so moving any other
  // held asset onto it left the <select> displaying a value it had no option
  // for, while state said otherwise.
  it('refuses to flip an asset the receive picker does not offer', () => {
    const yXLM = { code: 'yXLM', issuer: USDC_ISSUER, balance: '5.0' }
    expect(resolveFlip('yXLM', 'XLM', [yXLM, XLM], USDC_ISSUER)).toBeNull()
  })

  it('refuses to flip before balances have loaded', () => {
    expect(resolveFlip(undefined, 'USDC', [], USDC_ISSUER)).toBeNull()
  })
})

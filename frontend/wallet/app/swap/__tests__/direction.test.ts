import { parseSwapPrefill, resolveFlip } from '../direction'

const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'
const USDT0_IMPOSTOR = 'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT'
const XLM = { code: 'XLM', balance: '100.0' }
const USDC = { code: 'USDC', issuer: USDC_ISSUER, balance: '25.0' }
/** What the receive picker offers — the page passes swapDestinations(network). */
const DESTINATIONS = [
  { code: 'XLM', issuer: null },
  { code: 'USDC', issuer: USDC_ISSUER },
  { code: 'USDT0', issuer: USDT0_ISSUER },
]
const dest = (code: string, issuer?: string) => (issuer ? { code, issuer, balance: '0' } : { code, balance: '0' })

describe('resolveFlip', () => {
  it('flips XLM → USDC into USDC → XLM when both are held', () => {
    const flip = resolveFlip(XLM, dest('USDC', USDC_ISSUER), [XLM, USDC], DESTINATIONS)
    expect(flip?.nextSource).toBe(USDC)
    expect(flip?.nextDest.code).toBe('XLM')
  })

  it('carries the registered issuer onto the receive side', () => {
    const flip = resolveFlip(USDC, dest('XLM'), [XLM, USDC], DESTINATIONS)
    expect(flip?.nextSource).toBe(XLM)
    expect(flip?.nextDest).toEqual({ code: 'USDC', issuer: USDC_ISSUER, balance: '0' })
  })

  // Regression: the flip used to null out the pay asset whenever the account
  // held no balance in the asset it was about to receive — the ordinary case of
  // buying USDC for the first time — which left the form unable to quote at all.
  it('refuses to flip when the receive asset is not held', () => {
    expect(resolveFlip(XLM, dest('USDC', USDC_ISSUER), [XLM], DESTINATIONS)).toBeNull()
  })

  // Regression: the receive picker lists registered assets only, so moving any
  // other held asset onto it left the <select> displaying a value it had no
  // option for, while state said otherwise.
  it('refuses to flip an asset the receive picker does not offer', () => {
    const yXLM = { code: 'yXLM', issuer: USDC_ISSUER, balance: '5.0' }
    expect(resolveFlip(yXLM, dest('XLM'), [yXLM, XLM], DESTINATIONS)).toBeNull()
  })

  // #793: matching by code would flip a held impostor USDT0 onto the receive
  // side as the real one, or pay out of it when the real one was asked for.
  it('never matches a held impostor by code alone', () => {
    const fake = { code: 'USDT0', issuer: USDT0_IMPOSTOR, balance: '1000.0' }
    expect(resolveFlip(fake, dest('XLM'), [fake, XLM], DESTINATIONS)).toBeNull()
    expect(resolveFlip(XLM, dest('USDT0', USDT0_ISSUER), [XLM, fake], DESTINATIONS)).toBeNull()
  })

  it('refuses to flip before balances have loaded', () => {
    expect(resolveFlip(null, dest('USDC', USDC_ISSUER), [], DESTINATIONS)).toBeNull()
  })
})

describe('parseSwapPrefill', () => {
  it('reads a hand-off from the agent', () => {
    expect(parseSwapPrefill('?from=xlm&to=USDC&amount=10')).toEqual({ from: 'XLM', to: 'USDC', amount: '10' })
  })

  it('drops anything malformed instead of guessing', () => {
    expect(parseSwapPrefill('?from=<script>&to=USDC&amount=1e9')).toEqual({ from: undefined, to: 'USDC', amount: undefined })
    expect(parseSwapPrefill('?amount=-5').amount).toBeUndefined()
    expect(parseSwapPrefill('?amount=0').amount).toBeUndefined()
    expect(parseSwapPrefill('?amount=1.12345678').amount).toBeUndefined() // beyond Stellar's 7 decimals
  })

  it('opens an empty form when there is no hand-off', () => {
    expect(parseSwapPrefill('')).toEqual({ from: undefined, to: undefined, amount: undefined })
  })
})

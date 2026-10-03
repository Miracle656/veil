import { redactEndpoint } from '../redactEndpoint'

describe('redactEndpoint', () => {
  it('masks the path, keeping protocol and host visible', () => {
    expect(redactEndpoint('https://green-provider.quiknode.pro/abc123secretpath/')).toBe(
      'https://green-provider.quiknode.pro/••••••••'
    )
  })

  it('never renders the original path segment', () => {
    const secret = 'abc123secretpath'
    const result = redactEndpoint(`https://green-provider.quiknode.pro/${secret}/`)
    expect(result).not.toContain(secret)
  })

  it('returns protocol + host unchanged when there is no path', () => {
    expect(redactEndpoint('https://soroban-testnet.stellar.org')).toBe('https://soroban-testnet.stellar.org')
  })

  it('returns (set) for an unparseable URL rather than leaking raw input', () => {
    expect(redactEndpoint('not a url')).toBe('(set)')
  })

  it('returns empty string for an empty input', () => {
    expect(redactEndpoint('')).toBe('')
  })
})

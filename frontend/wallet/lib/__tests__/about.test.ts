import { TextEncoder, TextDecoder } from 'util'
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { getNetworkFacts, getContractEntries, getBuildId, explorerAddressUrl } from '../about'

describe('getBuildId', () => {
  const original = process.env.NEXT_PUBLIC_COMMIT_SHA

  afterEach(() => {
    process.env.NEXT_PUBLIC_COMMIT_SHA = original
  })

  it('shortens a full commit SHA', () => {
    process.env.NEXT_PUBLIC_COMMIT_SHA = '1e8bc7c9f3a2b1c0d5e6f7a8b9c0d1e2f3a4b5c6'
    expect(getBuildId()).toBe('1e8bc7c')
  })

  it('falls back to dev when unset', () => {
    delete process.env.NEXT_PUBLIC_COMMIT_SHA
    expect(getBuildId()).toBe('dev')
  })
})

/**
 * Strip the scheme and host, then require that nothing readable is left: either
 * no path at all, or a fully masked one. The earlier form of this check pattern
 * matched for "a slash followed by 4+ non-masked characters", which also matches
 * the `//host` of every https URL — so it failed on the plain, path-less
 * `https://soroban-testnet.stellar.org`. The host has to be removed before the
 * check, not pattern-matched around.
 */
function pathIsHidden(value: string): boolean {
  const rest = value.replace(/^https?:\/\/[^/]+/, '')
  return rest === '' || rest === `/${'•'.repeat(8)}`
}

describe('getNetworkFacts', () => {
  it('never renders an RPC or Horizon URL with its path intact', () => {
    const facts = getNetworkFacts()
    const rpc = facts.find(f => f.key === 'rpc')!
    const horizon = facts.find(f => f.key === 'horizon')!
    expect(pathIsHidden(rpc.value)).toBe(true)
    expect(pathIsHidden(horizon.value)).toBe(true)
    // Guard the guard: a keyed provider URL must not pass this check.
    expect(pathIsHidden('https://green-provider.quiknode.pro/abc123secretpath/')).toBe(false)
  })

  it('includes the active network display name', () => {
    const facts = getNetworkFacts()
    expect(facts.find(f => f.key === 'network')?.value).toBeTruthy()
  })
})

describe('getContractEntries', () => {
  it('includes the factory contract actually configured for the active network', () => {
    const entries = getContractEntries(null)
    expect(entries.some(e => e.key === 'factory')).toBe(true)
  })

  it('omits the wallet row when no address is known', () => {
    const entries = getContractEntries(null)
    expect(entries.some(e => e.key === 'wallet')).toBe(false)
  })

  it('rejects a non-contract address rather than mislabeling it', () => {
    const entries = getContractEntries('not-a-real-address')
    expect(entries.some(e => e.key === 'wallet')).toBe(false)
  })
})

describe('explorerAddressUrl', () => {
  it('returns null for an invalid address rather than building a broken link', () => {
    expect(explorerAddressUrl('not-a-real-address')).toBeNull()
  })
})

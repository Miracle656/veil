/**
 * @jest-environment node
 */
jest.mock('@blend-capital/blend-sdk', () => ({
  PoolV1: {},
  PoolV2: {},
  PoolContractV1: class {},
  PoolContractV2: class {},
  RequestType: {},
}))
jest.mock('@/lib/network', () => ({
  getNetwork: () => ({ name: 'mainnet', rpcUrl: 'https://rpc.invalid', networkPassphrase: 'x' }),
}))

import { readPoolStatus } from '../blend'

describe('readPoolStatus', () => {
  it('returns the status number a loaded pool reports', () => {
    expect(readPoolStatus({ metadata: { status: 3 } })).toBe(3)
    expect(readPoolStatus({ metadata: { status: 0 } })).toBe(0)
  })

  it.each([
    ['no metadata', {}],
    ['no status', { metadata: {} }],
    ['a string', { metadata: { status: '3' } }],
    ['a fraction', { metadata: { status: 1.5 } }],
    ['NaN', { metadata: { status: NaN } }],
  ])('returns null for %s, so the screen says the status is unknown', (_label, pool) => {
    expect(readPoolStatus(pool)).toBeNull()
  })
})

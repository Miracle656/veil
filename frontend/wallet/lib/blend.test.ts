import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// Mock network config so module load does not touch env.
jest.mock('@/lib/network', () => ({
  getNetwork: () => ({
    name: 'mainnet',
    rpcUrl: 'https://soroban-rpc.example.invalid',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  }),
}))

jest.mock('./fees', () => ({
  inclusionFee: () => '100',
}))

const mockPoolV2Load = jest.fn<(...args: unknown[]) => Promise<unknown>>()
const mockPoolV1Load = jest.fn<(...args: unknown[]) => Promise<unknown>>()

jest.mock('@blend-capital/blend-sdk', () => ({
  PoolV2: { load: (...args: unknown[]) => mockPoolV2Load(...args) },
  PoolV1: { load: (...args: unknown[]) => mockPoolV1Load(...args) },
  PoolContractV1: class {},
  PoolContractV2: class {},
  RequestType: { Supply: 2, Withdraw: 3 },
}))

jest.mock('@stellar/stellar-sdk', () => ({
  Account: class {},
  BASE_FEE: '100',
  rpc: { Server: class {}, Api: { isSimulationError: () => false }, assembleTransaction: () => ({ build: () => ({ toXDR: () => '' }) }) },
  TransactionBuilder: class {},
  xdr: { Operation: { fromXDR: () => ({}) } },
}))

describe('blend loadBlendPools', () => {
  beforeEach(() => {
    jest.resetModules()
    mockPoolV2Load.mockReset()
    mockPoolV1Load.mockReset()
    delete process.env.NEXT_PUBLIC_BLEND_POOL_IDS
    delete process.env.NEXT_PUBLIC_BLEND_POOL_IDS_MAINNET
    delete process.env.NEXT_PUBLIC_BLEND_POOL_IDS_TESTNET
  })

  it('returns no pools when nothing is configured on testnet (no Blend deployment there)', async () => {
    // Guards: testnet must report "no pools" rather than querying a mainnet id.
    jest.doMock('@/lib/network', () => ({
      getNetwork: () => ({ name: 'testnet', rpcUrl: 'x', networkPassphrase: 'y' }),
    }))
    const mod = await import('./blend')
    expect(mod.configuredPoolIds()).toEqual([])
    expect(await mod.loadBlendPools()).toEqual([])
    expect(mockPoolV2Load).not.toHaveBeenCalled()
  })

  it('uses the built-in mainnet default when no env var is set', async () => {
    // Guards: mainnet Earn must not show "Coming soon" when the pool is live.
    const mod = await import('./blend')
    expect(mod.configuredPoolIds()).toEqual([
      'CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD',
    ])
  })

  it('splits and trims comma-separated configured pool ids', async () => {
    // Guards: whitespace/empty entries from env must not become bogus pool ids.
    process.env.NEXT_PUBLIC_BLEND_POOL_IDS = ' AAA , ,BBB ,'
    const mod = await import('./blend')
    expect(mod.configuredPoolIds()).toEqual(['AAA', 'BBB'])
  })

  it('computes the average supply APY as a fraction, not a percentage', async () => {
    // Guards: APY is a fraction (0.042 = 4.2%); a factor-of-100 error here
    // would be displayed to users as a real rate.
    mockPoolV2Load.mockResolvedValue({
      id: 'POOL',
      metadata: { name: 'Main', reserveList: ['USDC'] },
      reserves: new Map([
        ['a', { estSupplyApy: 0.04, totalSupply: () => 10n }],
        ['b', { estSupplyApy: 0.05, totalSupply: () => 20n }],
      ]),
    })
    const mod = await import('./blend')
    const pools = await mod.loadBlendPools()
    expect(pools).toHaveLength(1)
    expect(pools[0].supplyApy).toBeCloseTo(0.045, 10)
    expect(pools[0].totalSupply).toBe('30')
  })

  it('reports zero APY (not NaN) for a pool with zero reserves', async () => {
    // Guards: empty pool must render as 0 utilisation, never a NaN rate.
    mockPoolV2Load.mockResolvedValue({
      id: 'POOL',
      metadata: { name: '', reserveList: [] },
      reserves: new Map(),
    })
    const mod = await import('./blend')
    const pools = await mod.loadBlendPools()
    expect(pools[0].supplyApy).toBe(0)
    expect(Number.isNaN(pools[0].supplyApy)).toBe(false)
    expect(pools[0].totalSupply).toBe('0')
  })

  it('omits a pool that is unreachable rather than rendering a figure', async () => {
    // Guards: a failed load must yield no entry, not a plausible fallback rate.
    mockPoolV2Load.mockRejectedValue(new Error('network down'))
    mockPoolV1Load.mockRejectedValue(new Error('network down'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const mod = await import('./blend')
    expect(await mod.loadBlendPools()).toEqual([])
    warn.mockRestore()
  })

  it('falls back to PoolV1 when PoolV2 load fails', async () => {
    // Guards: legacy pools must still be reachable.
    mockPoolV2Load.mockRejectedValue(new Error('not v2'))
    mockPoolV1Load.mockResolvedValue({
      id: 'OLD',
      metadata: { name: 'Old', reserveList: [] },
      reserves: new Map(),
    })
    const mod = await import('./blend')
    const pools = await mod.loadBlendPools()
    expect(pools.map((p) => p.id)).toEqual(['OLD'])
  })
})

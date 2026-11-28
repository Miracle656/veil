jest.mock('@stellar/stellar-sdk', () => ({
  Asset: class {
    constructor(private readonly code: string) {}
    static native() {
      return { contractId: () => 'CXLM' }
    }
    contractId() {
      return `C${this.code}`
    }
  },
  Account: class {},
  BASE_FEE: '100',
  TransactionBuilder: class {},
  xdr: { Operation: { fromXDR: jest.fn() } },
  rpc: {
    Server: class {},
    Api: { isSimulationError: () => false },
    assembleTransaction: jest.fn(),
  },
}))

jest.mock('@/lib/network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    rpcUrl: 'https://rpc.invalid',
    networkPassphrase: 'testnet',
  }),
  getUsdcIssuer: () => 'GISSUER',
}))
jest.mock('../fees', () => ({ inclusionFee: () => '100' }))

const mockPoolV2Load = jest.fn()
const mockPoolV1Load = jest.fn()

jest.mock('@blend-capital/blend-sdk', () => ({
  PoolV2: { load: (...args: unknown[]) => mockPoolV2Load(...args) },
  PoolV1: { load: (...args: unknown[]) => mockPoolV1Load(...args) },
  PoolContractV1: class {},
  PoolContractV2: class {},
  RequestType: { Supply: 2, Withdraw: 3 },
}))

import { loadBlendPools } from '../blend'

function reserve(assetId: string, supplyApy: number, utilization = 0.5) {
  return {
    assetId,
    totalSupply: () => 10_000n,
    estSupplyApy: supplyApy,
    getUtilizationFloat: () => utilization,
  }
}

describe('Blend savings reserve data', () => {
  const originalPoolIds = process.env.NEXT_PUBLIC_BLEND_POOL_IDS_TESTNET

  beforeEach(() => {
    mockPoolV1Load.mockReset()
    mockPoolV2Load.mockReset()
    process.env.NEXT_PUBLIC_BLEND_POOL_IDS_TESTNET = 'CPOOL'
  })

  afterEach(() => {
    if (originalPoolIds === undefined) delete process.env.NEXT_PUBLIC_BLEND_POOL_IDS_TESTNET
    else process.env.NEXT_PUBLIC_BLEND_POOL_IDS_TESTNET = originalPoolIds
  })

  it('keeps APY attached to the reserve that supplies it and excludes unsupported assets', async () => {
    mockPoolV2Load.mockResolvedValue({
      id: 'CPOOL',
      metadata: { name: 'Pool', reserveList: [] },
      reserves: new Map([
        ['CXLM', reserve('CXLM', 0.0123, 0.95)],
        ['CUSDC', reserve('CUSDC', 0.0456, 0.2)],
        ['CEURC', reserve('CEURC', 0.08)],
      ]),
    })

    await expect(loadBlendPools()).resolves.toEqual([{
      id: 'CPOOL',
      name: 'Pool',
      reserves: [
        { assetId: 'CXLM', code: 'XLM', supplyApy: 0.0123, utilization: 0.95 },
        { assetId: 'CUSDC', code: 'USDC', supplyApy: 0.0456, utilization: 0.2 },
      ],
      assets: ['CXLM', 'CUSDC'],
    }])
  })

  it('preserves an unavailable protocol rate as null instead of displaying zero', async () => {
    mockPoolV2Load.mockResolvedValue({
      id: 'CPOOL',
      metadata: { name: 'Pool', reserveList: [] },
      reserves: new Map([['CXLM', reserve('CXLM', Number.NaN, Number.NaN)]]),
    })

    const [pool] = await loadBlendPools()

    expect(pool.reserves[0].supplyApy).toBeNull()
    expect(pool.reserves[0].utilization).toBeNull()
  })
})

/**
 * @jest-environment node
 *
 * Tests for lib/veilIansOwned.ts: fetchOwnedVeilIans.
 * Reading Veil-ians directly from the chain without depending on an indexer.
 */

import { FIGURES, figureImageUrl, figureMetadataUrl } from '../masqueradeFigures'

const mockSimulateRead = jest.fn()
jest.mock('../sorobanRead', () => ({
  simulateRead: (...args: unknown[]) => mockSimulateRead(...args),
}))

const mockGetNetwork = jest.fn()
jest.mock('../network', () => ({
  getNetwork: () => mockGetNetwork(),
}))

const mockMasqueradeContractIdFor = jest.fn()
jest.mock('../masqueradeContractId', () => ({
  masqueradeContractIdFor: (net: string) => mockMasqueradeContractIdFor(net),
}))

import { fetchOwnedVeilIans } from '../veilIansOwned'

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const TEST_ADDRESS = 'GDTESTADDRESSFORVEILIANSOWNEDTESTSUITE000000000000000000000'
const OTHER_ADDRESS = 'GDOTHERADDRESSFORVEILIANSOWNEDTESTSUITE0000000000000000000'

beforeEach(() => {
  jest.clearAllMocks()
  mockGetNetwork.mockReturnValue({
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  })
  mockMasqueradeContractIdFor.mockReturnValue(CONTRACT_ID)
})

describe('fetchOwnedVeilIans', () => {
  it('returns [] when there is no contract id for the network, and makes no read', async () => {
    mockMasqueradeContractIdFor.mockReturnValue(null)

    const result = await fetchOwnedVeilIans(TEST_ADDRESS)

    expect(result).toEqual([])
    expect(mockSimulateRead).not.toHaveBeenCalled()
  })

  it('returns [] when the address is empty', async () => {
    const result = await fetchOwnedVeilIans('')

    expect(result).toEqual([])
    expect(mockSimulateRead).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['not an array (object)', { sold: [1, 2] }],
    ['not an array (string)', '1,2,3'],
    ['empty array', []],
  ])('returns [] when sold() is %s', async (_, soldValue) => {
    mockSimulateRead.mockResolvedValueOnce(soldValue)

    const result = await fetchOwnedVeilIans(TEST_ADDRESS)

    expect(result).toEqual([])
    expect(mockSimulateRead).toHaveBeenCalledTimes(1)
    expect(mockSimulateRead).toHaveBeenCalledWith(
      expect.anything(),
      CONTRACT_ID,
      'sold',
      [],
      expect.any(String),
    )
  })

  it('drops ids that are 0, negative, above FIGURES.length, or not whole numbers, and never calls owner_of for them', async () => {
    // FIGURES.length is 20. Valid ids are integers 1 through 20.
    const invalidAndValid = [0, -1, -10, 21, 999, 1.5, NaN, 'abc', 3]
    mockSimulateRead.mockImplementation(async (_rpc, _contract, method, args) => {
      if (method === 'sold') return invalidAndValid
      if (method === 'owner_of') {
        return TEST_ADDRESS
      }
      return null
    })

    const result = await fetchOwnedVeilIans(TEST_ADDRESS)

    // Only ID 3 should have been queried
    expect(mockSimulateRead).toHaveBeenCalledTimes(2) // 1 sold + 1 owner_of
    const ownerOfCalls = mockSimulateRead.mock.calls.filter((call) => call[2] === 'owner_of')
    expect(ownerOfCalls).toHaveLength(1)
    expect(result).toHaveLength(1)
    expect(result[0].tokenId).toBe('3')
  })

  it('returns only tokens whose owner equals the address', async () => {
    mockSimulateRead.mockImplementation(async (_rpc, _contract, method, args) => {
      if (method === 'sold') return [1, 2, 3]
      if (method === 'owner_of') {
        // ScVal for u32 encodes the id
        const argScVal = args[0]
        const id = argScVal.value()
        if (id === 1) return TEST_ADDRESS
        if (id === 2) return OTHER_ADDRESS
        if (id === 3) return TEST_ADDRESS
      }
      return null
    })

    const result = await fetchOwnedVeilIans(TEST_ADDRESS)

    expect(result.map((t) => t.tokenId)).toEqual(['1', '3'])
    expect(result.every((t) => t.owner === TEST_ADDRESS)).toBe(true)
  })

  it('an owner_of that returns null does not break the others', async () => {
    mockSimulateRead.mockImplementation(async (_rpc, _contract, method, args) => {
      if (method === 'sold') return [1, 2]
      if (method === 'owner_of') {
        const id = args[0].value()
        if (id === 1) return null // Simulation failed or error
        if (id === 2) return TEST_ADDRESS
      }
      return null
    })

    const result = await fetchOwnedVeilIans(TEST_ADDRESS)

    expect(result).toHaveLength(1)
    expect(result[0].tokenId).toBe('2')
    expect(result[0].owner).toBe(TEST_ADDRESS)
  })

  it('the item for id 7 has tokenId: "7", the name Veil-ian #07, and the five attributes from FIGURES[6]', async () => {
    mockSimulateRead.mockImplementation(async (_rpc, _contract, method, args) => {
      if (method === 'sold') return [7]
      if (method === 'owner_of') return TEST_ADDRESS
      return null
    })

    const result = await fetchOwnedVeilIans(TEST_ADDRESS)

    expect(result).toHaveLength(1)
    const item = result[0]
    const figure7 = FIGURES[6]

    expect(item.id).toBe(`${CONTRACT_ID}:7`)
    expect(item.contractId).toBe(CONTRACT_ID)
    expect(item.tokenId).toBe('7')
    expect(item.name).toBe('Veil-ian #07')
    expect(item.symbol).toBe('VEILIAN')
    expect(item.owner).toBe(TEST_ADDRESS)
    expect(item.standard).toBe('CAP-46')
    expect(item.image).toBe(figureImageUrl(7))
    expect(item.tokenUri).toBe(figureMetadataUrl(7))
    expect(item.attributes).toEqual([
      { trait_type: 'Crown', value: figure7.crown },
      { trait_type: 'Aperture', value: figure7.aperture },
      { trait_type: 'Ornament', value: figure7.ornament },
      { trait_type: 'Palette', value: figure7.palette },
      { trait_type: 'Hem', value: figure7.hem },
    ])
  })
})

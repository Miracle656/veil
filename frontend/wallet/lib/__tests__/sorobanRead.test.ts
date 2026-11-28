/**
 * @jest-environment node
 *
 * Tests for lib/sorobanRead.ts: simulateRead and probeAccount.
 * Null means "could not read", never "the answer is nothing."
 */

import { nativeToScVal, rpc as SorobanRpc } from '@stellar/stellar-sdk'
import { probeAccount, simulateRead } from '../sorobanRead'

const CONTRACT_ID = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'

describe('probeAccount', () => {
  it('returns an account with sequence 0', () => {
    const account = probeAccount()
    expect(account.sequenceNumber()).toBe('0')
    expect(account.accountId()).toMatch(/^G[A-Z2-7]{55}$/)
  })
})

describe('simulateRead', () => {
  let mockRpc: { simulateTransaction: jest.Mock }

  beforeEach(() => {
    mockRpc = {
      simulateTransaction: jest.fn(),
    }
  })

  it('returns the decoded value on a successful simulation', async () => {
    const expectedValue = ['sample-token-1', 'sample-token-2']
    const retval = nativeToScVal(expectedValue)

    mockRpc.simulateTransaction.mockResolvedValue({
      result: { retval },
    })

    const result = await simulateRead(
      mockRpc as unknown as SorobanRpc.Server,
      CONTRACT_ID,
      'get_tokens',
      [],
      NETWORK_PASSPHRASE,
    )

    expect(result).toEqual(expectedValue)
    expect(mockRpc.simulateTransaction).toHaveBeenCalledTimes(1)
  })

  it('returns null on a simulation error', async () => {
    mockRpc.simulateTransaction.mockResolvedValue({
      error: 'Host error: contract panicked with code 7',
    })

    const result = await simulateRead(
      mockRpc as unknown as SorobanRpc.Server,
      CONTRACT_ID,
      'panicking_method',
      [],
      NETWORK_PASSPHRASE,
    )

    expect(result).toBeNull()
  })

  it('returns null on a missing retval', async () => {
    mockRpc.simulateTransaction.mockResolvedValue({
      result: {},
    })

    const result = await simulateRead(
      mockRpc as unknown as SorobanRpc.Server,
      CONTRACT_ID,
      'void_method',
      [],
      NETWORK_PASSPHRASE,
    )

    expect(result).toBeNull()
  })

  it('returns null when the RPC call throws', async () => {
    mockRpc.simulateTransaction.mockRejectedValue(new Error('Network connection refused'))

    const result = await simulateRead(
      mockRpc as unknown as SorobanRpc.Server,
      CONTRACT_ID,
      'get_tokens',
      [],
      NETWORK_PASSPHRASE,
    )

    expect(result).toBeNull()
  })
})

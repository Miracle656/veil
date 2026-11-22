import { describe, expect, it, jest } from '@jest/globals'
import {
  AllowanceError,
  assertAllowanceCovers,
  assertFreshAllowance,
  type AllowanceSnapshot,
} from '../allowance.js'

const allowance = (amount: bigint, expiry?: bigint): AllowanceSnapshot => ({ amount, expiry })

describe('assistant payment allowance preflight', () => {
  it('allows a payment exactly at the remaining allowance', () => {
    expect(() => assertAllowanceCovers(allowance(1_000n), 1_000n, 100n)).not.toThrow()
  })

  it('rejects a payment above the remaining allowance', () => {
    expect(() => assertAllowanceCovers(allowance(999n), 1_000n, 100n)).toThrow(AllowanceError)
    expect(() => assertAllowanceCovers(allowance(999n), 1_000n, 100n)).toThrow(
      'above the remaining allowance',
    )
  })

  it('rejects missing and expired allowances', () => {
    expect(() => assertAllowanceCovers(null, 1n, 100n)).toThrow('No allowance is registered')
    expect(() => assertAllowanceCovers(allowance(1_000n, 100n), 1n, 100n)).toThrow(
      'allowance has expired',
    )
  })

  it('rejects invalid payment amounts', () => {
    expect(() => assertAllowanceCovers(allowance(1_000n), 0n, 100n)).toThrow(
      'Payment amount must be positive',
    )
    expect(() => assertAllowanceCovers(allowance(1_000n), -1n, 100n)).toThrow(
      'Payment amount must be positive',
    )
  })

  it('fails closed when the allowance read fails', async () => {
    const reader = { readAllowance: jest.fn<() => Promise<AllowanceSnapshot | null>>() }
    reader.readAllowance.mockRejectedValue(new Error('rpc unavailable'))

    await expect(assertFreshAllowance(reader, 1n, 100n)).rejects.toMatchObject({
      name: 'AllowanceError',
      code: 'allowance_unavailable',
    })
    expect(reader.readAllowance).toHaveBeenCalledTimes(1)
  })
})

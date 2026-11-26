/**
 * The cash-out payload the backend actually requires.
 *
 * Every web cash-out failed validation before reaching the provider:
 *
 *   "bankAccount, bankCode, bankName, accountName, walletAddress and
 *    idempotencyKey are required"
 *
 * The client sent `refundAddress` and no key at all. `walletAddress` is not a
 * rename of `refundAddress` — the backend uses it as the customer reference and
 * as proof of ownership when a key is replayed, while `refundAddress` is merely
 * where a failed payout returns.
 *
 * The key must also be STABLE across retries. The backend never generates one,
 * deliberately: "regenerating it on a retry is precisely how one order becomes
 * two, and the second one also gets paid for."
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import type { CreateOrderParams } from '../offramp'

/** Exactly what the backend checks for, from `wraith/src/api/offramp.ts`. */
const REQUIRED = [
  'bankAccount',
  'bankCode',
  'bankName',
  'accountName',
  'walletAddress',
  'idempotencyKey',
] as const

const ORDER: CreateOrderParams = {
  amountNGN: 5000,
  bankAccount: '8023302683',
  bankCode: '999992',
  bankName: 'OPay',
  accountName: 'A N Other',
  walletAddress: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
  refundAddress: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
  idempotencyKey: 'f2b1c0de-0000-4000-8000-000000000001',
}

describe('CreateOrderParams', () => {
  it.each(REQUIRED)('carries %s, which the backend requires as a string', (field) => {
    expect(typeof (ORDER as unknown as Record<string, unknown>)[field]).toBe('string')
  })

  // The regression: the type made the key optional, so a caller could omit it
  // and only find out from a 400 at the moment of cashing out.
  it('requires the idempotency key at compile time, not at runtime', () => {
    // @ts-expect-error — omitting idempotencyKey must not type-check
    const incomplete: CreateOrderParams = { ...ORDER, idempotencyKey: undefined }
    expect(incomplete).toBeDefined()
  })

  // walletAddress and refundAddress are different fields with different jobs,
  // even when a given client passes the same value for both.
  it('keeps walletAddress and refundAddress as separate fields', () => {
    // @ts-expect-error — refundAddress alone must not satisfy the type
    const onlyRefund: CreateOrderParams = {
      amountNGN: 5000,
      bankAccount: '8023302683',
      bankCode: '999992',
      bankName: 'OPay',
      accountName: 'A N Other',
      refundAddress: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
      idempotencyKey: 'x',
    }
    expect(onlyRefund).toBeDefined()
  })
})

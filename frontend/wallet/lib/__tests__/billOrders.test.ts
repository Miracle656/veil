/**
 * Bill Orders Persistence & Status Resolution Tests for Web Wallet.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  clearBillOrders,
  getBillOrder,
  getBillOrders,
  isTerminalStatus,
  recheckPendingBillOrders,
  saveBillOrder,
  updateBillOrderStatus,
  BILL_ORDERS_KEY,
} from '../billOrders'
import type { BillStatus } from '../ngn'

beforeEach(() => {
  localStorage.clear()
})

describe('bill order persistence & re-query readiness (wallet)', () => {
  it('persists a bill order with enough information to re-query it', () => {
    const order = {
      orderId: 'ord_elec_web_123',
      customerRef: 'veil_4sjjjzwamdoe',
      category: 'electricity' as const,
      provider: 'IKEDC',
      identifier: '10101234567',
      amount: 5000,
      amountCrypto: 3.33,
      asset: 'usdc',
      status: 'pending',
      time: 1729440000000,
    }

    saveBillOrder(order)

    const saved = getBillOrder('ord_elec_web_123')
    expect(saved).not.toBeNull()
    expect(saved?.orderId).toBe('ord_elec_web_123')
    expect(saved?.customerRef).toBe('veil_4sjjjzwamdoe')
    expect(saved?.category).toBe('electricity')
    expect(saved?.amount).toBe(5000)
    expect(saved?.amountCrypto).toBe(3.33)
    expect(saved?.status).toBe('pending')
  })

  it('retrieves a prepaid electricity token after leaving the screen', () => {
    saveBillOrder({
      orderId: 'ord_elec_web_token',
      customerRef: 'veil_user_web',
      category: 'electricity',
      provider: 'EKEDC',
      identifier: '04123456789',
      amount: 10000,
      asset: 'xlm',
      status: 'completed',
      time: Date.now(),
      token: '4532-8901-2345-6789-0123',
    })

    const orders = getBillOrders()
    const elecOrder = orders.find((o) => o.orderId === 'ord_elec_web_token')

    expect(elecOrder).toBeDefined()
    expect(elecOrder?.token).toBe('4532-8901-2345-6789-0123')
  })

  it('strips NIN, BVN, names, and contact details from storage', () => {
    saveBillOrder({
      orderId: 'ord_privacy_wallet',
      customerRef: 'veil_ref_safe',
      category: 'electricity' as const,
      provider: 'IBEDC',
      identifier: '62112345678',
      amount: 3000,
      asset: 'usdc',
      status: 'completed',
      token: '9988-7766-5544-3322',
      nin: '12345678901',
      bvn: '22233344455',
      customerName: 'Chinedu Okonkwo',
      email: 'chinedu@example.com',
    })

    const raw = localStorage.getItem(BILL_ORDERS_KEY) ?? ''
    expect(raw).not.toContain('12345678901')
    expect(raw).not.toContain('22233344455')
    expect(raw).not.toContain('Chinedu')
    expect(raw).not.toContain('chinedu@example.com')
    expect(raw).toContain('62112345678')
  })

  it('re-checks non-terminal orders and resolves after restart', async () => {
    saveBillOrder({
      orderId: 'ord_restart_wallet',
      customerRef: 'veil_ref_restart',
      category: 'electricity',
      provider: 'AEDC',
      identifier: '14123456789',
      amount: 4000,
      status: 'pending',
    })

    const mockGetStatus = jest.fn(async (ref: string, id: string): Promise<BillStatus> => {
      return {
        orderId: id,
        customerRef: ref,
        status: 'completed',
        billCategory: 'electricity',
        amountNgn: 4000,
        amountStableCoin: 2.67,
        wallet: 'GB3JS2AJZ3FKIGVOOPXDEYYR3XOHQA474WGCYAMNFSGX6OW5HGWCKUZW',
        description: 'AEDC Prepaid Electricity',
        token: '7021-4433-8899-1234-5678',
      }
    })

    const resolvedOrders = await recheckPendingBillOrders({ getStatusFn: mockGetStatus })
    const resolved = resolvedOrders.find((o) => o.orderId === 'ord_restart_wallet')

    expect(resolved?.status).toBe('completed')
    expect(resolved?.token).toBe('7021-4433-8899-1234-5678')
  })
})

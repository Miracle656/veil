/**
 * Bill order persistence, token retrieval, and status rechecking for web wallet.
 *
 * Sibling of frontend/mobile/lib/billOrders.ts.
 *
 * ## What We Store
 * - category: BillCategory ('airtime', 'data', 'electricity', 'cabletv', 'betting')
 * - identifier: phone number, meter number, smartcard number, betting user ID
 * - amount: NGN amount
 * - amountCrypto: crypto / stablecoin amount spent
 * - asset: coin used ('usdc', 'xlm')
 * - orderId: Linq order ID
 * - status: 'pending', 'completed', 'failed', etc.
 * - time: Unix timestamp in ms
 * - token: prepaid token where one was returned (especially for electricity)
 * - customerRef: Linq customer reference (needed to re-query /ngn/bills/:orderId)
 * - provider: e.g. 'MTN', 'IKEDC'
 *
 * ## Privacy
 * No personal identity data. A meter number is a customer identifier; a NIN
 * must never appear here at all.
 */

import { walletLocal } from './walletStorage'
import {
  classifyBillStatus,
  getBillStatus,
  type BillCategory,
  type BillStatus,
} from './ngn'

export const BILL_ORDERS_KEY = 'veil_bill_orders'
export const MAX_BILL_ORDERS = 50

export interface PersistedBillOrder {
  orderId: string
  customerRef: string
  category: BillCategory
  provider: string
  identifier: string
  amount: number
  amountCrypto?: number
  asset: string
  status: string
  time: number
  token?: string
}

export type BillOrderInput = {
  orderId: string
  customerRef: string
  category: BillCategory
  provider?: string
  identifier: string
  amount: number
  amountCrypto?: number
  asset?: string
  status?: string
  time?: number
  token?: string
  prepaidToken?: string
  [key: string]: unknown
}

export function sanitizeBillOrder(raw: BillOrderInput): PersistedBillOrder {
  const clean: PersistedBillOrder = {
    orderId: String(raw.orderId),
    customerRef: String(raw.customerRef),
    category: raw.category,
    provider: String(raw.provider ?? ''),
    identifier: String(raw.identifier),
    amount: Number(raw.amount),
    asset: String(raw.asset ?? 'usdc').toLowerCase(),
    status: String(raw.status ?? 'pending'),
    time: typeof raw.time === 'number' && !Number.isNaN(raw.time) ? raw.time : Date.now(),
  }

  if (raw.amountCrypto !== undefined && typeof raw.amountCrypto === 'number' && !Number.isNaN(raw.amountCrypto)) {
    clean.amountCrypto = raw.amountCrypto
  }

  const tokenVal = raw.token ?? raw.prepaidToken
  if (typeof tokenVal === 'string' && tokenVal.trim()) {
    clean.token = tokenVal.trim()
  }

  return clean
}

export function isTerminalStatus(status: string): boolean {
  const outcome = classifyBillStatus(status)
  return outcome === 'done' || outcome === 'failed'
}

export function getBillOrders(): PersistedBillOrder[] {
  try {
    const raw = walletLocal.getItem(BILL_ORDERS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => sanitizeBillOrder(item as BillOrderInput))
      .sort((a, b) => b.time - a.time)
  } catch (err) {
    console.warn('[billOrders] failed to read stored bill orders:', err)
    return []
  }
}

export function saveBillOrder(order: BillOrderInput): PersistedBillOrder {
  const sanitized = sanitizeBillOrder(order)
  const existing = getBillOrders()
  const index = existing.findIndex((o) => o.orderId === sanitized.orderId)

  let updated: PersistedBillOrder[]
  if (index >= 0) {
    if (!sanitized.token && existing[index].token) {
      sanitized.token = existing[index].token
    }
    updated = [...existing]
    updated[index] = { ...existing[index], ...sanitized }
  } else {
    updated = [sanitized, ...existing].slice(0, MAX_BILL_ORDERS)
  }

  walletLocal.setItem(BILL_ORDERS_KEY, JSON.stringify(updated))
  return sanitized
}

export function updateBillOrderStatus(
  orderId: string,
  status: string,
  token?: string,
): PersistedBillOrder | null {
  const existing = getBillOrders()
  const index = existing.findIndex((o) => o.orderId === orderId)
  if (index < 0) return null

  const current = existing[index]
  const updatedOrder: PersistedBillOrder = {
    ...current,
    status,
    ...(token ? { token } : {}),
  }

  existing[index] = updatedOrder
  walletLocal.setItem(BILL_ORDERS_KEY, JSON.stringify(existing))
  return updatedOrder
}

export function getBillOrder(orderId: string): PersistedBillOrder | null {
  const orders = getBillOrders()
  return orders.find((o) => o.orderId === orderId) ?? null
}

export function clearBillOrders(): void {
  walletLocal.removeItem(BILL_ORDERS_KEY)
}

export interface RecheckOptions {
  getStatusFn?: (customerRef: string, orderId: string) => Promise<BillStatus>
}

export async function recheckPendingBillOrders(
  options?: RecheckOptions,
): Promise<PersistedBillOrder[]> {
  const fetchStatus = options?.getStatusFn ?? getBillStatus
  const orders = getBillOrders()
  const pendingOrders = orders.filter((o) => !isTerminalStatus(o.status))

  if (pendingOrders.length === 0) {
    return orders
  }

  let hasUpdates = false
  const updatedOrders = [...orders]

  for (const order of pendingOrders) {
    try {
      const statusRes = await fetchStatus(order.customerRef, order.orderId)
      const newStatus = statusRes.status
      const newToken = statusRes.token ?? statusRes.prepaidToken ?? order.token

      if (newStatus !== order.status || (newToken && newToken !== order.token)) {
        const idx = updatedOrders.findIndex((o) => o.orderId === order.orderId)
        if (idx >= 0) {
          updatedOrders[idx] = {
            ...updatedOrders[idx],
            status: newStatus,
            ...(newToken ? { token: newToken } : {}),
          }
          hasUpdates = true
        }
      }
    } catch (err) {
      console.warn(`[billOrders] re-check failed for order ${order.orderId}:`, err)
    }
  }

  if (hasUpdates) {
    walletLocal.setItem(BILL_ORDERS_KEY, JSON.stringify(updatedOrders))
  }

  return updatedOrders
}

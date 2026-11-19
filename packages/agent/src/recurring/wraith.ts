import type { NairaCoin, TopupCategory, TopupProvider } from './types.js'

/**
 * Wraith bill client matching `frontend/mobile/lib/onramp.ts` and
 * `frontend/mobile/lib/billFlow.ts` so recurring top-ups create orders
 * through wraith the exact same way the airtime screen does.
 */

export interface WraithBillOrder {
  id: string
  customerRef: string
  /** Classic G... deposit address where crypto is sent to fund the bill order. */
  wallet: string
  status: string
}

export interface WraithBillStatus {
  orderId: string
  customerRef: string
  status: string
  billCategory: string
  amountNgn: number
  amountStableCoin: number
  wallet: string
  description?: string
}

export interface CreateWraithBillOrderParams {
  customerRef: string
  billCategory: TopupCategory
  provider: TopupProvider
  /** Recipient phone number. Never logged. */
  customerId: string
  amountNgn: number
  amountStableCoin: number
  rate: number
  coin: NairaCoin
  refundAddress: string
  /** Deterministic idempotency key built from planId and periodIndex. */
  idempotencyKey: string
}

export interface WraithBillClient {
  getBillRate(coin: NairaCoin): Promise<number>
  createBillOrder(params: CreateWraithBillOrderParams): Promise<WraithBillOrder>
  getBillStatus(customerRef: string, orderId: string): Promise<WraithBillStatus>
}

/**
 * Lock the 7-decimal Stellar amount sent to both wraith and the Stellar payment.
 * Matches `lockBillAmountStableCoin` in `frontend/mobile/lib/billFlow.ts`.
 */
export function lockBillAmountStableCoin(amountNgn: number, rate: number): number {
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    throw new Error('amountNgn must be a positive number')
  }
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('rate must be a positive number')
  }
  return Number((amountNgn / rate).toFixed(7))
}

/** Convert a 7-decimal Stellar token amount to integer base units (stroops). */
export function stableCoinToBaseUnits(amountStableCoin: number): bigint {
  return BigInt(Math.round(amountStableCoin * 1e7))
}

/**
 * Map a wraith/Linq bill status string into `'done' | 'failed' | 'pending'`.
 * Matches `classifyBillStatus` in `frontend/mobile/lib/onramp.ts`.
 */
export function classifyBillStatus(status: string): 'done' | 'failed' | 'pending' {
  const s = status.trim().toLowerCase()
  if (/pending|processing|awaiting|queued|initiated|progress/.test(s)) return 'pending'
  if (/complete|success|delivered|settled|disbursed/.test(s)) return 'done'
  if (/fail|refund|revers|cancel|expire|timeout/.test(s)) return 'failed'
  return 'pending'
}

export function createWraithBillClient(
  wraithUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): WraithBillClient {
  const baseUrl = wraithUrl.replace(/\/+$/, '')

  async function call<T>(
    path: string,
    init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    if (!baseUrl) {
      throw new Error('WRAITH_URL is not configured for recurring bill orders.')
    }
    const headers: Record<string, string> = {
      // Mainnet header is always sent explicitly, matching frontend/mobile/lib/onramp.ts.
      'x-network': 'mainnet',
    }
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json'
    }
    if (init.idempotencyKey) {
      headers['Idempotency-Key'] = init.idempotencyKey
    }

    const res = await fetchImpl(`${baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    })

    const text = await res.text()
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!res.ok) {
      const msg = typeof data.error === 'string' ? data.error : `Wraith request failed (HTTP ${res.status})`
      throw new Error(msg)
    }
    return data as T
  }

  return {
    async getBillRate(coin: NairaCoin): Promise<number> {
      const data = await call<{ rate: number }>(`/ngn/onramp/rate?coin=${encodeURIComponent(coin)}`)
      if (typeof data.rate !== 'number' || !Number.isFinite(data.rate) || data.rate <= 0) {
        throw new Error('Wraith returned an unusable NGN rate.')
      }
      return data.rate
    },

    async createBillOrder(params: CreateWraithBillOrderParams): Promise<WraithBillOrder> {
      return call<WraithBillOrder>('/ngn/bills', {
        method: 'POST',
        idempotencyKey: params.idempotencyKey,
        body: {
          customerRef: params.customerRef,
          billCategory: params.billCategory,
          provider: params.provider,
          customerId: params.customerId,
          amountNgn: params.amountNgn,
          amountStableCoin: params.amountStableCoin,
          rate: params.rate,
          coin: params.coin,
          refundAddress: params.refundAddress,
          idempotencyKey: params.idempotencyKey,
        },
      })
    },

    async getBillStatus(customerRef: string, orderId: string): Promise<WraithBillStatus> {
      return call<WraithBillStatus>(
        `/ngn/bills/${encodeURIComponent(orderId)}?customerRef=${encodeURIComponent(customerRef)}`,
      )
    },
  }
}

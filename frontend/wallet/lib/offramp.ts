/**
 * Offramp client — USDC on Stellar to a Nigerian bank account, via Linq.
 *
 * The web port of `frontend/mobile/lib/offramp.ts`. Same wire protocol, same
 * error model; the storage layer is `localStorage` instead of AsyncStorage and
 * the base URL comes from `NEXT_PUBLIC_WRAITH_URL`.
 *
 * Every call goes through Wraith, never to Linq directly. Linq's API key
 * creates orders that pay real naira to real bank accounts, so it cannot be in
 * a browser bundle: anything shipped to a client is extractable, and that key
 * is not read access, it is the ability to spend.
 *
 * A 503 from any of these means the backend has no offramp configured, which is
 * also what a sleeping Render instance looks like from here. Callers treat it
 * as "not available right now" and disable the entry point rather than failing
 * the user halfway through a flow.
 */

const BASE_URL = process.env.NEXT_PUBLIC_WRAITH_URL?.replace(/\/+$/, '') ?? ''
const TIMEOUT_MS = 20_000

/** Remembers whether the offramp answered last time, to avoid a layout jump. */
const AVAILABILITY_KEY = 'veil_offramp_available'
const ACTIVE_ORDER_KEY = 'veil_offramp_active_order'
const DEPOSIT_ADDRESSES_KEY = 'veil_offramp_deposit_addresses'

export class OfframpUnavailable extends Error {}

export interface OfframpRate {
  rate: number
  currency: string
  coin: string
  /** Always true: the binding rate is the one locked into an order. */
  indicative: boolean
}

export interface VerifiedBank {
  accountName: string
  bankName: string
  accountNumber: string
  bankCode: string
}

export interface OfframpOrder {
  id: string
  /** Where the user must send USDC. Created with a trustline already in place. */
  walletAddress: string
  coinType: string
  chain: string
  coin: string
  amountStableCoin: number
  amountNGN: number
  rate: number
  status: string
  replayed?: boolean
}

export interface OfframpStatus {
  id: string
  status: string
  amountStableCoin: number
  amountNGN: number
  depositAddress?: string
  /** 'cache' means the backend could not reach Linq and served its own row. */
  source?: 'linq' | 'cache'
}

/** localStorage is absent during SSR and throws outright in some privacy modes. */
function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!BASE_URL) throw new OfframpUnavailable('No backend configured for offramp.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    if (res.status === 503) throw new OfframpUnavailable(data?.error ?? 'Offramp unavailable')
    if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`)
    return data as T
  } catch (err) {
    if (err instanceof OfframpUnavailable) throw err
    if ((err as Error)?.name === 'AbortError') {
      throw new OfframpUnavailable('The offramp service did not respond.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether the offramp can be offered at all.
 *
 * Gates the entry point: the backend holds the key, so if it is asleep or
 * unconfigured there is no order to create, and the button should say so before
 * the user types an amount.
 */
export async function isOfframpAvailable(): Promise<boolean> {
  try {
    await call<OfframpRate>('/offramp/rate')
    store()?.setItem(AVAILABILITY_KEY, '1')
    return true
  } catch {
    store()?.setItem(AVAILABILITY_KEY, '0')
    return false
  }
}

/**
 * What the offramp looked like last time, for the first paint.
 *
 * Rendering "unavailable" while the first probe is still in flight makes a
 * working feature look broken for a second, and Render cold starts make that
 * second long.
 */
export function lastKnownAvailability(): boolean {
  return store()?.getItem(AVAILABILITY_KEY) === '1'
}

export function getOfframpRate(): Promise<OfframpRate> {
  return call<OfframpRate>('/offramp/rate')
}

export function verifyBankAccount(bankCode: string, accountNumber: string): Promise<VerifiedBank> {
  return call<VerifiedBank>('/offramp/verify-bank', {
    method: 'POST',
    body: { bankCode, accountNumber },
  })
}

export function checkRefundAddress(address: string): Promise<{ valid: boolean; trustsUSDC: boolean }> {
  return call('/offramp/check-address', { method: 'POST', body: { address } })
}

export interface CreateOrderParams {
  amountNGN: number
  bankAccount: string
  bankCode: string
  bankName: string
  accountName: string
  refundAddress: string
  idempotencyKey?: string
}

export async function createOrder(params: CreateOrderParams): Promise<OfframpOrder> {
  return call<OfframpOrder>('/offramp/orders', { method: 'POST', body: params })
}

export function getOrderStatus(orderId: string): Promise<OfframpStatus> {
  return call<OfframpStatus>(`/offramp/orders/${encodeURIComponent(orderId)}`)
}

/**
 * The order this browser is in the middle of.
 *
 * An order has a ten-minute deposit window. Closing the tab must not lose it,
 * or the user comes back to no way of finding out whether their money moved.
 */
export function rememberActiveOrder(orderId: string): void {
  store()?.setItem(ACTIVE_ORDER_KEY, orderId)
}

export function activeOrderId(): string | null {
  return store()?.getItem(ACTIVE_ORDER_KEY) ?? null
}

export function forgetActiveOrder(): void {
  store()?.removeItem(ACTIVE_ORDER_KEY)
}

/**
 * Deposit addresses this browser has paid, so activity can label those payments
 * "Cashed out" rather than "Sent" — otherwise a cash-out reads as if the user
 * paid a stranger.
 *
 * Addresses only, capped at 50. No amounts, no order ids, nothing that says who
 * the user is.
 */
export function rememberDepositAddress(address: string): void {
  const s = store()
  if (!s || !address) return
  const known = knownDepositAddresses()
  if (known.includes(address)) return
  const next = [address, ...known].slice(0, 50)
  try {
    s.setItem(DEPOSIT_ADDRESSES_KEY, JSON.stringify(next))
  } catch {
    /* quota or privacy mode: the label is a nicety, not the feature */
  }
}

export function knownDepositAddresses(): string[] {
  const raw = store()?.getItem(DEPOSIT_ADDRESSES_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

/** Statuses from which nothing further will happen. */
export function isTerminal(status: string): boolean {
  const s = status.toLowerCase()
  return (
    s.includes('disbursed') ||
    s.includes('completed') ||
    s.includes('failed') ||
    s.includes('expired') ||
    s.includes('refunded')
  )
}

export function isFailure(status: string): boolean {
  const s = status.toLowerCase()
  return s.includes('failed') || s.includes('expired') || s.includes('refunded')
}

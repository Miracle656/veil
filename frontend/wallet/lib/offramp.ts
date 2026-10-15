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
  /**
   * Once an order settles these are what actually happened, which is not always
   * what was quoted: the payout follows the deposit that arrived, at the rate at
   * settlement. A receipt must show these, not the estimate.
   */
  amountStableCoin: number
  amountNGN: number
  /** From our own row: the rate locked at creation, and when that was. */
  rate?: number
  createdAt?: string
  /** The provider's own status word, before it was reworded for older apps. */
  providerStatus?: string
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

/**
 * The payout provider is not named to users. The backend already strips it;
 * this covers an older backend deploy, since an installed APK outlives it.
 */
export function withoutProviderName(message: string): string {
  if (/rate.?limit|too many requests/i.test(message)) {
    return "The payout service is busy right now. Try again in a few seconds."
  }
  if (/wallet generation failed/i.test(message)) {
    return "The payout service couldn't set up this order. Try again in a minute."
  }
  if (/LINQ_API_KEY/i.test(message)) return 'Cash-out is not available right now'
  const replaced = message.replace(/linq(?:'s)?/gi, 'the payout service')
  return replaced.charAt(0).toUpperCase() + replaced.slice(1)
}

/**
 * Statuses that mean "not yet", not "no".
 *
 * The backend sleeps. On the hosting tier it runs on, an idle service is
 * stopped and the first request to reach it gets a 503 from the edge — empty
 * body, a fraction of a second — while the container starts. A tester saw
 * exactly this and was told the rails were unavailable; they were about twenty
 * seconds from being up.
 *
 * 502 and 504 are the same situation seen from a different angle: the edge
 * reached a process that was not ready yet, or did not answer in time.
 */
const TRANSIENT_STATUSES = new Set([502, 503, 504])

/** Backoff between attempts. Long enough to cover a cold start, short enough that someone is still watching. */
const RETRY_DELAYS_MS = [800, 2_000, 4_000, 8_000]

/** Everything after the first attempt must fit in this, so a wait is bounded. */
const RETRY_BUDGET_MS = 25_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A waking service answers with an HTML holding page, not JSON. Parsing it
 * throws a SyntaxError that would reach the user as itself.
 */
function parseJson(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function attempt<T>(path: string, init: { method?: string; body?: unknown }): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })
    const data = parseJson(await res.text())
    if (TRANSIENT_STATUSES.has(res.status)) {
      throw new OfframpUnavailable(
        withoutProviderName((data['error'] as string) ?? 'Offramp unavailable'),
      )
    }
    if (!res.ok) {
      throw new Error(withoutProviderName((data['error'] as string) ?? `Request failed (${res.status})`))
    }
    return data as T
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Whether this request may be sent again.
 *
 * A GET always may. A POST may only when it carries an idempotency key, which
 * is what makes the second send the same request rather than a second order —
 * the backend deliberately refuses to generate one for exactly this reason.
 */
function isRepeatable(init: { method?: string; body?: unknown }): boolean {
  const method = (init.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const body = init.body
  return !!body && typeof body === 'object' && typeof (body as { idempotencyKey?: unknown }).idempotencyKey === 'string'
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!BASE_URL) throw new OfframpUnavailable('No backend configured for offramp.')

  const repeatable = isRepeatable(init)
  const startedAt = Date.now()
  let lastError: unknown

  for (let i = 0; ; i++) {
    try {
      return await attempt<T>(path, init)
    } catch (err) {
      lastError = err instanceof OfframpUnavailable
        ? err
        : (err as Error)?.name === 'AbortError'
          ? new OfframpUnavailable('The offramp service did not respond.')
          : err

      // Only a sleeping or unreachable service is worth asking again. A 400 is
      // an answer, and repeating it just makes the user wait for it twice.
      const transient = lastError instanceof OfframpUnavailable
      const delay = RETRY_DELAYS_MS[i]
      if (
        !repeatable
        || !transient
        || delay === undefined
        || Date.now() - startedAt + delay > RETRY_BUDGET_MS
      ) {
        throw lastError
      }
      await sleep(delay)
    }
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
  /**
   * The wallet placing the order. Required by the backend, which uses it as the
   * customer reference and as proof of ownership when an idempotency key is
   * replayed — an order can only be re-read by the wallet that created it.
   *
   * This was missing entirely and only `refundAddress` was sent, so every web
   * cash-out failed validation before it reached the provider.
   */
  walletAddress: string
  /** Where a failed payout returns. Optional to the backend; always sent here. */
  refundAddress: string
  /**
   * Required, and required to be STABLE across retries of the same order.
   *
   * The backend deliberately never generates this: "regenerating it on a retry
   * is precisely how one order becomes two, and the second one also gets paid
   * for." A fresh key per click would defeat the whole mechanism, so the caller
   * holds one for as long as the order details are unchanged.
   */
  idempotencyKey: string
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

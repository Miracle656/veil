/**
 * Buying crypto with naira, through Linq — the web half of the mobile rails.
 *
 * Every call goes through wraith, never to Linq directly: the Linq API key is
 * the ability to create orders that move real naira, and a key shipped to a
 * browser is a key anyone can read. See `wraith/docs/ngn-rails.md`.
 *
 * ## This is mainnet, always, and the header says so
 *
 * Linq has no sandbox — every call moves real money. A Stellar `G…` address is
 * valid on both networks, so an order placed from a testnet session would take
 * real naira out of someone's bank and deliver real crypto to an address their
 * testnet wallet never displays. wraith refuses that, but only if it knows
 * which network we mean: with no `x-network` header it falls back to its own
 * default, which is testnet on the current deployment. So the header is sent
 * explicitly on every call, and the screens refuse on testnet besides.
 *
 * ## No signing happens here
 *
 * Buying never asks the wallet to sign anything. The user is given a Nigerian
 * account number, transfers naira from their own bank app, and Linq delivers
 * the crypto to their classic address. That is also why this works on a wallet
 * that has never been deployed: receiving needs no contract and no passkey.
 *
 * Deliberately a sibling of `frontend/mobile/lib/onramp.ts` rather than a
 * shared module — the two use different storage primitives — but the wire
 * shapes, the key names and the `customerRef` derivation are identical on
 * purpose, so a person who used the app and then the browser is the same
 * customer to Linq.
 */

import { walletLocal } from './walletStorage'
import { getNetworkName } from './network'

const BASE_URL = process.env.NEXT_PUBLIC_WRAITH_URL?.replace(/\/+$/, '') ?? ''

/** Matches wraith's own per-operation ceiling, retries included. */
const TIMEOUT_MS = 40_000

/** Thrown when this deployment has no naira rails configured (wraith answers 503). */
export class NairaUnavailable extends Error {}

/** Thrown when wraith did not answer in time. */
export class NairaTimeout extends Error {}

/**
 * Strip the provider's name out of anything a user will read.
 *
 * "Linq" means nothing to someone buying airtime, and naming a third party in
 * an error invites them to go and ask that third party about our bug.
 */
export function withoutProviderName(message: string): string {
  if (/rate.?limit|too many requests/i.test(message)) {
    return 'The service is busy right now. Try again in a few seconds.'
  }
  if (/LINQ_API_KEY/i.test(message)) return 'Buying with naira is not available right now.'
  const replaced = message.replace(/linq(?:'s)?/gi, 'the naira service')
  return replaced.charAt(0).toUpperCase() + replaced.slice(1)
}

/**
 * Statuses that mean "not yet", not "no".
 *
 * The backend sleeps on its hosting tier. The first request to reach an idle
 * service gets a 503 from the edge — empty body, a fraction of a second —
 * while the container starts. A tester hit exactly that on the rate call and
 * was told the rails were down; they were about twenty seconds from up.
 */
const TRANSIENT_STATUSES = new Set([502, 503, 504])

/** Backoff between attempts: long enough for a cold start, short enough that someone is still watching. */
const RETRY_DELAYS_MS = [800, 2_000, 4_000, 8_000]

/** Everything after the first attempt fits in this, so the wait is bounded. */
const RETRY_BUDGET_MS = 25_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A waking service answers with a holding page, not JSON; parsing it throws. */
function parseJson(text: string): Record<string, unknown> {
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Whether this request may be sent again.
 *
 * A GET always may. A POST may only when it carries an idempotency key — that
 * is what makes a second send the same request rather than a second order.
 */
function isRepeatable(init: { method?: string; body?: unknown }): boolean {
  const method = (init.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const body = init.body
  return !!body && typeof body === 'object'
    && typeof (body as { idempotencyKey?: unknown }).idempotencyKey === 'string'
}

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!BASE_URL) throw new NairaUnavailable('No backend configured for naira rails.')

  const repeatable = isRepeatable(init)
  const startedAt = Date.now()

  for (let i = 0; ; i++) {
    try {
      return await attempt<T>(path, init)
    } catch (err) {
      const transient = err instanceof NairaUnavailable
      const delay = RETRY_DELAYS_MS[i]
      if (
        !repeatable
        || !transient
        || delay === undefined
        || Date.now() - startedAt + delay > RETRY_BUDGET_MS
      ) {
        throw err
      }
      await sleep(delay)
    }
  }
}

async function attempt<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      signal: controller.signal,
      headers: {
        // Never omitted — see this module's header.
        'x-network': 'mainnet',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    })

    const data = parseJson(await res.text())

    if (TRANSIENT_STATUSES.has(res.status)) {
      throw new NairaUnavailable(withoutProviderName((data['error'] as string) ?? 'Naira rails unavailable'))
    }
    if (!res.ok) {
      // `code` is the stable half of the answer — `nin_already_used` and the
      // like. Without it a caller has to match on prose that is both scrubbed
      // here and liable to be reworded by the provider, which is how someone
      // whose NIN is spent gets sent to a screen about their spelling.
      throw Object.assign(
        new Error(withoutProviderName((data['error'] as string) ?? `Request failed (${res.status})`)),
        typeof data['code'] === 'string' && data['code'] ? { code: data['code'] as string } : {},
      )
    }
    return data as T
  } catch (err) {
    if (err instanceof NairaUnavailable) throw err
    if ((err as Error)?.name === 'AbortError') {
      throw new NairaTimeout('The service did not respond in time.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// ─── Who we are to Linq ──────────────────────────────────────────────────────

const CUSTOMER_REF_KEY = 'veil_ngn_customer_ref'
const VERIFIED_KEY = 'veil_ngn_verified'
const KYC_MISMATCH_KEY = 'veil_ngn_kyc_mismatch'
const VERIFY_DETAILS_KEY = 'veil_ngn_details'

/**
 * This wallet's Linq `customerRef`, stable for the life of this browser profile.
 *
 * **Linq enforces one verified customer per NIN.** That makes this value far
 * more load-bearing than it looks: a `customerRef` that changes is not a new
 * reference to the same person, it is a second person Linq has never heard of —
 * and the NIN that would verify them is already spent, with no self-service way
 * to get it back.
 *
 * So it is persisted, not derived on each read. It is seeded from the wallet
 * address the first time only; after that the stored value wins even if the
 * wallet address changes. Do not add any path that regenerates it.
 */
export function getCustomerRef(): string | null {
  const stored = walletLocal.getItem(CUSTOMER_REF_KEY)
  if (stored) return stored

  const wallet = walletLocal.getItem('invisible_wallet_address')
  if (!wallet) return null

  const ref = `veil_${wallet.slice(-12).toLowerCase()}`
  walletLocal.setItem(CUSTOMER_REF_KEY, ref)
  return ref
}

export interface VerifyDetails {
  firstName: string
  lastName: string
  email: string
  phone: string
}

/**
 * The contact details from the first verification screen, kept so a second
 * attempt does not start from an empty form.
 *
 * The NIN is NEVER here. It is personal data under the NDPA, it is sent once
 * and kept by nobody, and a stored copy would outlive the reason it was
 * collected — so the four fields are written by name rather than by spreading
 * whatever object the caller passed.
 */
export function saveVerifyDetails(details: VerifyDetails): void {
  const safe: VerifyDetails = {
    firstName: details.firstName,
    lastName: details.lastName,
    email: details.email,
    phone: details.phone,
  }
  walletLocal.setItem(VERIFY_DETAILS_KEY, JSON.stringify(safe))
}

export function loadVerifyDetails(): VerifyDetails | null {
  const raw = walletLocal.getItem(VERIFY_DETAILS_KEY)
  if (!raw) return null
  try {
    const d = JSON.parse(raw) as Partial<VerifyDetails>
    return {
      firstName: typeof d.firstName === 'string' ? d.firstName : '',
      lastName: typeof d.lastName === 'string' ? d.lastName : '',
      email: typeof d.email === 'string' ? d.email : '',
      phone: typeof d.phone === 'string' ? d.phone : '',
    }
  } catch {
    return null
  }
}

/** Has this person completed the one-time NIN check? */
export function isNairaVerified(): boolean {
  return walletLocal.getItem(VERIFIED_KEY) === 'true'
}

/**
 * Record the result of the one-time check.
 *
 * Only ever called with the answer Linq gave. Never set optimistically: a
 * browser that believes it is verified when Linq disagrees cannot recover,
 * since the one NIN that would verify it has already been spent.
 */
export function setNairaVerified(verified: boolean): void {
  walletLocal.setItem(VERIFIED_KEY, verified ? 'true' : 'false')
}

/**
 * Linq says this reference has not completed KYC, after the browser believed it
 * had. Terminal on purpose: verifying again only re-spends a NIN attempt on a
 * number Linq has already refused, and lands back here.
 */
export function setNairaKycMismatch(mismatch: boolean): void {
  walletLocal.setItem(KYC_MISMATCH_KEY, mismatch ? 'true' : 'false')
}

export function isNairaKycMismatch(): boolean {
  return walletLocal.getItem(KYC_MISMATCH_KEY) === 'true'
}

/**
 * Let a stranded person ask again, once support has re-bound the NIN.
 *
 * `customerRef` is preserved, which is the whole point — a new reference is a
 * new person to Linq and the NIN that would verify them is spent. Verified is
 * cleared as well as the mismatch, because what support re-bound is the NIN, so
 * the NIN has to be submitted again for the binding to land on this reference.
 */
export function resetNairaVerification(): void {
  getCustomerRef()
  walletLocal.removeItem(VERIFIED_KEY)
  walletLocal.removeItem(KYC_MISMATCH_KEY)
}

// ─── Customer ────────────────────────────────────────────────────────────────

export interface NairaCustomer {
  customerRef: string
  verified: boolean
  /** False when the customer already existed — provisioning is idempotent. */
  created: boolean
  /**
   * True when the reference that came back is not the one that was sent.
   *
   * Linq already had this person's email under a different reference and named
   * it; the server adopted it rather than failing. The returned reference is
   * the authoritative one from here on.
   */
  reusedExistingRef?: boolean
}

/**
 * One-time per person, not per order. Safe to call again after a dropped
 * response: Linq returns the existing customer with `created: false`.
 *
 * **The reference that comes back can differ from the one that went in.** If
 * this person's email is already registered under another reference, Linq names
 * it and the server adopts it. We then store that reference, because it is the
 * one their identity is bound to — continuing with ours would mean every later
 * KYC and order is refused, which is exactly the lockout this whole module is
 * written to avoid.
 *
 * This is the one place a stored reference may be replaced. It is not a
 * regenerated reference — it is Linq telling us which one is real.
 */
export async function provisionCustomer(params: {
  customerRef: string
  firstName: string
  lastName: string
  email: string
  phone: string
}): Promise<NairaCustomer> {
  const customer = await call<NairaCustomer>('/ngn/customers', { method: 'POST', body: params })

  if (customer.customerRef && customer.customerRef !== params.customerRef) {
    walletLocal.setItem(CUSTOMER_REF_KEY, customer.customerRef)
  }

  return customer
}

export interface CustomerStatus {
  customerRef: string
  verified: boolean
  status?: string
}

/**
 * Ask Linq whether this reference is already verified, creating nothing.
 *
 * The local `verified` flag is per browser, so someone who verified in the app
 * arrives here looking unverified and is invited into a flow they have already
 * completed — which matters more than it sounds, because a NIN verifies once
 * ever and being asked twice looks like being asked to spend it again.
 *
 * This is a pure read and costs no verification attempt, so the page can ask
 * on load and show the truth rather than the local guess. Rate-limited on
 * wraith's side; call it once per visit, not per render.
 */
export function getCustomerStatus(customerRef: string): Promise<CustomerStatus> {
  return call<CustomerStatus>(
    `/ngn/customers/status?customerRef=${encodeURIComponent(customerRef)}`,
  )
}

export interface KycResult {
  customerRef: string
  verified: boolean
  status: string
}

/** Verify by NIN. **One time, ever** — not per order. */
export function submitKyc(customerRef: string, nin: string): Promise<KycResult> {
  return call<KycResult>('/ngn/customers/kyc', { method: 'POST', body: { customerRef, nin } })
}

// ─── Onramp ──────────────────────────────────────────────────────────────────

export type NairaCoin = 'xlm' | 'usdc'

/**
 * NGN per unit of the asset.
 *
 * The coin is not optional, here or on the wire. The endpoint used to take none
 * and return naira per *dollar*, which the screens divided naira by and called
 * an amount of coin — right for USDC by coincidence, wrong for XLM by the price
 * of XLM. wraith now answers per coin and refuses a request without one.
 *
 * Deliberately uncached: this is the number locked into the order, and XLM
 * floats. Fetch it immediately before creating an order.
 */
export async function getOnrampRate(coin: NairaCoin): Promise<number> {
  const { rate } = await call<{ rate: number }>(
    `/ngn/onramp/rate?coin=${encodeURIComponent(coin)}`,
  )
  if (!(rate > 0)) throw new Error('The service returned an unusable rate.')
  return rate
}

export interface OnrampOrder {
  orderId: string
  customerRef: string
  /** The Nigerian account the user transfers naira into. */
  accountNumber: string
  bankName: string
  /** Shown before the bank app does, so the name is not a surprise. */
  accountName: string
  amountNgn: number
  amountStableCoin: number
  fee: number
  /** ISO-8601. After this the order is dead and the money must not be sent. */
  expiresAt: string
  status: string
}

/**
 * Create an order and get the account to pay.
 *
 * `walletAddress` must be the classic `G…` account, never the `C…` smart
 * wallet: Linq pays by classic operation, which cannot name a contract as a
 * destination. wraith refuses a `C…` before it reaches Linq.
 */
export function createOnrampOrder(params: {
  customerRef: string
  amountStableCoin: number
  walletAddress: string
  rate: number
  coin: NairaCoin
}): Promise<OnrampOrder> {
  return call<OnrampOrder>('/ngn/onramp/orders', { method: 'POST', body: params })
}

const ACTIVE_ORDER_KEY = 'veil_ngn_active_order'

/**
 * The order this browser is in the middle of.
 *
 * An order has a short deposit window and names a Nigerian account to pay. A
 * refresh — or a tab closed on the way to a banking app, which is the normal
 * way this is used — must not lose it, or the user is left having been told to
 * transfer money to an account they can no longer see, with no way to find out
 * whether it arrived. Worse, the obvious recovery is to create a second order,
 * and then there are two live accounts and one payment.
 *
 * The whole order is kept rather than just its id, because `expiresAt` is not
 * in the status response and a restored screen with no countdown cannot say
 * the one thing that matters: whether this account still accepts the payment.
 */
export function rememberOnrampOrder(order: OnrampOrder): void {
  try {
    walletLocal.setItem(ACTIVE_ORDER_KEY, JSON.stringify(order))
  } catch {
    // A full or blocked store must not fail an order that already exists.
  }
}

/**
 * The stored order, or null when there is none, it is unreadable, or its window
 * has closed. An expired order is cleared on the way out: showing a dead one is
 * how someone pays an account that has stopped accepting it.
 */
export function loadOnrampOrder(): OnrampOrder | null {
  const raw = walletLocal.getItem(ACTIVE_ORDER_KEY)
  if (!raw) return null
  try {
    const order = JSON.parse(raw) as OnrampOrder
    if (!order?.orderId || !order?.expiresAt) return null
    if (secondsUntil(order.expiresAt) <= 0) {
      forgetOnrampOrder()
      return null
    }
    return order
  } catch {
    return null
  }
}

export function forgetOnrampOrder(): void {
  walletLocal.removeItem(ACTIVE_ORDER_KEY)
}

export interface OnrampStatus {
  orderId: string
  customerRef: string
  status: string
  amount: number
  amountNgn: number
  bankName: string
  accountNumber: string
  accountName: string
  /** Present only when wraith answered from its own record because Linq was down. */
  stale?: boolean
}

/** Both identifiers are required — an orderId alone is not enough, by design. */
export function getOnrampStatus(customerRef: string, orderId: string): Promise<OnrampStatus> {
  return call<OnrampStatus>(
    `/ngn/onramp/orders/${encodeURIComponent(orderId)}?customerRef=${encodeURIComponent(customerRef)}`,
  )
}

/** Whether the rails are open at all. USDC on purpose — the XLM rate additionally
 *  depends on a live order book, so asking for it would hide the whole naira
 *  entry point whenever pricing XLM failed. */
export async function isNairaAvailable(): Promise<boolean> {
  try {
    await getOnrampRate('usdc')
    return true
  } catch {
    return false
  }
}

/** Buying moves real naira, so it is mainnet-only and there is no test mode. */
export function isNairaNetwork(): boolean {
  return getNetworkName() === 'mainnet'
}

/** Whole seconds until the rate stops being honoured. 0 once it does not. */
export function secondsUntil(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now()
  return ms > 0 ? Math.floor(ms / 1000) : 0
}

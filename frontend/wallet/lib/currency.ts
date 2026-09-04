/**
 * Local-currency display for the wallet — the web port of the mobile app's
 * `lib/currency.ts`, kept deliberately close to it so the two clients show the
 * same figure for the same balance.
 *
 * Veil's product is fiat-facing: the user thinks in their local currency (₦, $,
 * KSh…) while the balance underneath is USDC. Everything upstream — the Lens
 * oracle (`fetchPrice.ts`), the balances — is denominated in USD, so this module
 * owns the one remaining hop: USD → the user's chosen currency, and the
 * formatting of that number.
 *
 * Two rules carried over from mobile:
 *
 *  - **FX is best-effort.** A live rate makes the figure accurate; its absence
 *    must never blank the balance. Every failure path falls back to a bundled
 *    rate, so a screen always shows *a* number — only ever stale, never missing.
 *  - **The selection is module state + localStorage**, exposed through
 *    `useSyncExternalStore`, so `useCurrency()` works anywhere with no provider
 *    and re-renders exactly its subscribers.
 */

import { useSyncExternalStore } from 'react'

export type CurrencyCode = 'USD' | 'NGN' | 'KES' | 'GHS' | 'ZAR' | 'GBP' | 'EUR'

export type Currency = {
  code: CurrencyCode
  /** Symbol shown before the amount. */
  symbol: string
  /** Human label for the picker. */
  label: string
  /**
   * USD → this-currency rate used when the live FX feed is unavailable. Kept
   * deliberately approximate: it exists so a balance renders a plausible local
   * figure offline, not to be a source of truth. The live feed overrides it.
   */
  fallbackRate: number
  /**
   * Decimal places to show. High-denomination currencies drop the cents —
   * "₦1,600,000" reads better than "₦1,600,000.00" — while the majors keep them.
   */
  decimals: number
}

/** Africa-forward (the launch market is Nigeria-first) plus the majors. */
export const CURRENCIES: Record<CurrencyCode, Currency> = {
  USD: { code: 'USD', symbol: '$', label: 'US Dollar', fallbackRate: 1, decimals: 2 },
  NGN: { code: 'NGN', symbol: '₦', label: 'Nigerian Naira', fallbackRate: 1600, decimals: 0 },
  KES: { code: 'KES', symbol: 'KSh', label: 'Kenyan Shilling', fallbackRate: 129, decimals: 0 },
  GHS: { code: 'GHS', symbol: '₵', label: 'Ghanaian Cedi', fallbackRate: 15, decimals: 2 },
  ZAR: { code: 'ZAR', symbol: 'R', label: 'South African Rand', fallbackRate: 18, decimals: 2 },
  GBP: { code: 'GBP', symbol: '£', label: 'British Pound', fallbackRate: 0.79, decimals: 2 },
  EUR: { code: 'EUR', symbol: '€', label: 'Euro', fallbackRate: 0.92, decimals: 2 },
}

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[]

/** The currency used before a stored preference has been read. */
export const DEFAULT_CURRENCY: CurrencyCode = 'USD'

/** localStorage key holding the user's display-currency preference. */
export const CURRENCY_STORAGE_KEY = 'veil_currency'

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && value in CURRENCIES
}

// ── Pure conversion + formatting ─────────────────────────────────────────────

/**
 * Convert a USD amount at a given rate. `null` in either argument yields `null`,
 * so an unpriced balance stays unpriced rather than silently reading as zero.
 */
export function convertUsd(usd: number | null, rate: number | null): number | null {
  if (usd == null || rate == null || !isFinite(usd) || !isFinite(rate)) return null
  return usd * rate
}

/**
 * Format a USD amount as a local-currency string. Returns an em dash for a
 * genuinely unpriced value — never "$0.00", which would read as "you have
 * nothing" when it means "we could not price this".
 */
export function formatFiat(
  usd: number | null,
  code: CurrencyCode,
  rate: number | null,
): string {
  if (usd == null || !isFinite(usd)) return '—'
  const currency = CURRENCIES[code] ?? CURRENCIES[DEFAULT_CURRENCY]
  const effectiveRate = rate ?? currency.fallbackRate
  const local = usd * effectiveRate
  const formatted = local.toLocaleString('en-US', {
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals,
  })
  return `${currency.symbol}${formatted}`
}

// ── Live FX rates (best-effort) ──────────────────────────────────────────────

const FX_BASE_URL = 'https://open.er-api.com/v6/latest/USD'
const FX_TIMEOUT_MS = 5_000

let liveRates: Partial<Record<CurrencyCode, number>> = {}
let ratesFetched = false

/** The USD→code rate: the live one when we have it, else the bundled fallback. */
export function getRate(code: CurrencyCode): number {
  return liveRates[code] ?? CURRENCIES[code].fallbackRate
}

/** Whether a live FX fetch has succeeded this session. */
export function areRatesLive(): boolean {
  return ratesFetched
}

/**
 * Fetch live USD→local rates. Best-effort: any failure (timeout, offline,
 * malformed body) leaves the cache untouched and the app keeps its fallbacks.
 */
export async function refreshFxRates(): Promise<boolean> {
  if (typeof fetch === 'undefined') return false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS)
  try {
    const res = await fetch(FX_BASE_URL, { signal: controller.signal })
    if (!res.ok) return false
    const data = (await res.json()) as { rates?: Record<string, unknown> }
    if (!data.rates || typeof data.rates !== 'object') return false

    const next: Partial<Record<CurrencyCode, number>> = {}
    for (const code of CURRENCY_CODES) {
      const value = data.rates[code]
      if (typeof value === 'number' && isFinite(value) && value > 0) next[code] = value
    }
    if (Object.keys(next).length === 0) return false

    liveRates = next
    ratesFetched = true
    notify()
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

// ── Selected currency (external store) ───────────────────────────────────────

let activeCurrency: CurrencyCode = DEFAULT_CURRENCY
const listeners = new Set<() => void>()
/** Bumped on every change so `useSyncExternalStore` sees a new snapshot. */
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeToCurrency(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getCurrency(): CurrencyCode {
  return activeCurrency
}

let hydrated = false

/**
 * Read the stored preference and kick off a background FX refresh. Idempotent.
 * Safe on the server, where it is a no-op — the caller then renders the default
 * until the client hydrates, which keeps the two markups identical.
 */
export function hydrateCurrency(): void {
  if (hydrated || typeof window === 'undefined') return
  hydrated = true
  try {
    const stored = window.localStorage.getItem(CURRENCY_STORAGE_KEY)
    if (isCurrencyCode(stored) && stored !== activeCurrency) activeCurrency = stored
  } catch {
    // Blocked storage — the default stands.
  }
  notify()
  // A live rate is an upgrade over the fallback, never a blocker for painting.
  void refreshFxRates()
}

/** Set the display currency and persist it. Applied immediately. */
export function setCurrency(code: CurrencyCode): void {
  if (!isCurrencyCode(code) || code === activeCurrency) return
  activeCurrency = code
  try {
    window.localStorage.setItem(CURRENCY_STORAGE_KEY, code)
  } catch {
    // A failed write costs the preference next visit, not the click now.
  }
  notify()
}

/**
 * The active currency and its rate, re-rendering on change.
 *
 * The server snapshot is pinned to the default so the first client render
 * matches the server markup; `hydrateCurrency()` then applies the stored
 * preference. Reading localStorage during render instead would produce a
 * hydration mismatch on every visit with a non-default currency.
 */
export function useCurrency(): { code: CurrencyCode; rate: number; live: boolean } {
  const snapshotVersion = useSyncExternalStore(
    subscribeToCurrency,
    () => version,
    () => 0,
  )
  void snapshotVersion
  const code = typeof window === 'undefined' ? DEFAULT_CURRENCY : activeCurrency
  return { code, rate: getRate(code), live: ratesFetched }
}

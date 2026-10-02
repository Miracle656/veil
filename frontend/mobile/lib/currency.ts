/**
 * Local-currency display for the wallet.
 *
 * Veil's product is fiat-facing: the user thinks in their local currency (₦, $,
 * KSh…) while the balance underneath is USDC. Everything upstream — the Lens
 * oracle (`fetchPrice.ts`), balances — is denominated in USD/USDC, so this
 * module owns the one remaining hop: USD → the user's chosen local currency, and
 * the formatting of that number.
 *
 * Two design rules mirror `fetchPrice.ts` and `theme.ts`:
 *
 *  - **FX is best-effort.** A live rate makes the figure accurate; its absence
 *    must never blank the balance. Every failure path falls back to a bundled
 *    rate so a screen always shows *a* number, and the number is only ever
 *    "stale", never missing.
 *  - **The selected currency is module state + AsyncStorage**, using the same
 *    external-store shape as `theme.ts`, so `useCurrency()` works anywhere with
 *    no provider and re-renders exactly its subscribers.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type CurrencyCode = 'USD' | 'NGN' | 'KES' | 'GHS' | 'ZAR' | 'GBP' | 'EUR';

export type Currency = {
  code: CurrencyCode;
  /** Currency symbol shown before the amount. */
  symbol: string;
  /** Human label for the picker. */
  label: string;
  /**
   * USD → this-currency rate used when the live FX feed is unavailable. Kept
   * deliberately approximate: it exists so the balance renders a plausible local
   * figure offline, not to be a source of truth. The live feed overrides it.
   */
  fallbackRate: number;
  /**
   * Decimal places to show. High-denomination currencies (naira, shilling) drop
   * the cents — "₦1,600,000" reads better than "₦1,600,000.00" — while the
   * majors keep them. Chosen per-currency, not by magnitude, so a large USD
   * figure still shows its cents.
   */
  decimals: number;
};

/**
 * Supported display currencies. Deliberately Africa-forward (the launch market
 * is Nigeria-first) plus the majors people hold dollars against.
 */
export const CURRENCIES: Record<CurrencyCode, Currency> = {
  USD: { code: 'USD', symbol: '$', label: 'US Dollar', fallbackRate: 1, decimals: 2 },
  NGN: { code: 'NGN', symbol: '₦', label: 'Nigerian Naira', fallbackRate: 1600, decimals: 0 },
  KES: { code: 'KES', symbol: 'KSh', label: 'Kenyan Shilling', fallbackRate: 129, decimals: 0 },
  GHS: { code: 'GHS', symbol: '₵', label: 'Ghanaian Cedi', fallbackRate: 15, decimals: 2 },
  ZAR: { code: 'ZAR', symbol: 'R', label: 'South African Rand', fallbackRate: 18, decimals: 2 },
  GBP: { code: 'GBP', symbol: '£', label: 'British Pound', fallbackRate: 0.79, decimals: 2 },
  EUR: { code: 'EUR', symbol: '€', label: 'Euro', fallbackRate: 0.92, decimals: 2 },
};

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

/** The currency used before a stored preference has been read. */
export const DEFAULT_CURRENCY: CurrencyCode = 'USD';

/** AsyncStorage key holding the user's display-currency preference. */
export const CURRENCY_STORAGE_KEY = 'veil_currency';

/** Narrow an arbitrary value to a known currency code. */
export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return typeof value === 'string' && value in CURRENCIES;
}

// ── Pure conversion + formatting ─────────────────────────────────────────────

/**
 * Convert a USD amount to a local amount at a given rate. `null` in either
 * argument yields `null`, so an unpriced balance stays unpriced rather than
 * silently reading as zero.
 */
export function convertUsd(usd: number | null, rate: number | null): number | null {
  if (usd == null || rate == null || !isFinite(usd) || !isFinite(rate)) return null;
  return usd * rate;
}

/**
 * Format a USD amount as a local-currency string.
 *
 * @param usd   The value in USD, or `null` when unpriced.
 * @param code  The target display currency.
 * @param rate  The live USD→code rate, or `null` to use the bundled fallback.
 *
 * Large local figures (≥ 1000, e.g. naira) drop the decimals — nobody reads
 * "₦1,600,000.00" — while small ones keep cents. Returns an em dash for a
 * genuinely unpriced value, never "$0.00".
 */
export function formatFiat(
  usd: number | null,
  code: CurrencyCode,
  rate: number | null,
): string {
  if (usd == null || !isFinite(usd)) return '—';
  const currency = CURRENCIES[code] ?? CURRENCIES[DEFAULT_CURRENCY];
  const effectiveRate = rate ?? currency.fallbackRate;
  const local = usd * effectiveRate;
  const formatted = local.toLocaleString('en-US', {
    minimumFractionDigits: currency.decimals,
    maximumFractionDigits: currency.decimals,
  });
  return `${currency.symbol}${formatted}`;
}

// ── Live FX rates (best-effort) ──────────────────────────────────────────────

const FX_BASE_URL = 'https://open.er-api.com/v6/latest/USD';
const FX_TIMEOUT_MS = 5_000;

/** In-memory cache of live USD→code rates. Empty until a fetch succeeds. */
let liveRates: Partial<Record<CurrencyCode, number>> = {};
let ratesFetched = false;

/**
 * The USD→code rate for a currency: the live rate when we have one, else the
 * bundled fallback. Total — always returns a usable number.
 */
export function getRate(code: CurrencyCode): number {
  return liveRates[code] ?? CURRENCIES[code].fallbackRate;
}

/** Whether a live FX fetch has ever succeeded this session. */
export function areRatesLive(): boolean {
  return ratesFetched;
}

/**
 * Fetch live USD→local rates for the supported currencies. Best-effort: any
 * failure (timeout, offline, malformed body) leaves the cache untouched and the
 * app keeps using fallbacks. Returns whether the fetch updated the cache.
 */
export async function refreshFxRates(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);
  try {
    const res = await fetch(FX_BASE_URL, { signal: controller.signal });
    if (!res.ok) return false;
    const data = (await res.json()) as { rates?: Record<string, unknown> };
    const rates = data.rates;
    if (!rates || typeof rates !== 'object') return false;

    const next: Partial<Record<CurrencyCode, number>> = {};
    for (const code of CURRENCY_CODES) {
      const value = rates[code];
      if (typeof value === 'number' && isFinite(value) && value > 0) {
        next[code] = value;
      }
    }
    if (Object.keys(next).length === 0) return false;

    liveRates = next;
    ratesFetched = true;
    notify();
    return true;
  } catch {
    return false; // AbortError (timeout), network error, or parse error.
  } finally {
    clearTimeout(timer);
  }
}

// ── Selected currency (external store, mirrors theme.ts) ──────────────────────

let activeCurrency: CurrencyCode = DEFAULT_CURRENCY;
let hydrated = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribe to currency / FX-rate changes. Returns an unsubscribe function. */
export function subscribeToCurrency(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The active display currency. Cheap enough to call in a render. */
export function getCurrency(): CurrencyCode {
  return activeCurrency;
}

/** Whether the stored preference has been read yet. */
export function isCurrencyHydrated(): boolean {
  return hydrated;
}

let hydration: Promise<CurrencyCode> | null = null;

/**
 * Load the stored currency preference. Idempotent — repeated calls share one
 * read — and it kicks off a background FX refresh so the first fiat figure is
 * live when the network cooperates.
 */
export function hydrateCurrency(): Promise<CurrencyCode> {
  hydration ??= AsyncStorage.getItem(CURRENCY_STORAGE_KEY)
    .catch(() => null)
    .then((stored) => {
      hydrated = true;
      if (isCurrencyCode(stored) && stored !== activeCurrency) {
        activeCurrency = stored;
      }
      notify();
      // Fire-and-forget: a live rate is an upgrade over the fallback, never a
      // blocker for painting the balance.
      void refreshFxRates();
      return activeCurrency;
    });
  return hydration;
}

// Start reading at import so the preference is usually in place by first paint.
void hydrateCurrency();

/**
 * Set the display currency and persist it. Applied immediately, persisted in the
 * background — a failed write costs the preference next launch, not the tap now.
 */
export async function setCurrency(code: CurrencyCode): Promise<void> {
  if (!isCurrencyCode(code)) throw new Error(`Unknown currency: ${code}`);
  if (code !== activeCurrency) {
    activeCurrency = code;
    notify();
  }
  hydration = Promise.resolve(code);
  hydrated = true;
  await AsyncStorage.setItem(CURRENCY_STORAGE_KEY, code);
}

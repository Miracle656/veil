/**
 * Buying with naira when the person wants USDC.
 *
 * The naira service can only deliver XLM. So "buy USDC" is two steps: buy XLM,
 * then convert it on the Swap screen. Nothing here signs or sends anything;
 * the person confirms the conversion themselves.
 */
import type { NairaCoin } from './ngn'

/** What the person wants to end up holding. */
export type BuyWant = 'usdc' | 'xlm'

/** The only coin the naira service delivers. */
export const DELIVERED_COIN: NairaCoin = 'xlm'

/**
 * XLM left behind when converting: a new account must keep 1 XLM, holding USDC
 * locks 0.5 more, and the rest pays network fees.
 */
export const XLM_KEPT_BACK = 2

const WANT_KEY = 'veil_ngn_buy_want'

export function parseBuyWant(raw: unknown): BuyWant {
  return raw === 'xlm' ? 'xlm' : 'usdc'
}

/** Remembered so someone back from their bank app is still offered the conversion. */
export function rememberBuyWant(want: BuyWant): void {
  try { window.localStorage.setItem(WANT_KEY, want) } catch { /* private window */ }
}

export function loadBuyWant(): BuyWant {
  try { return parseBuyWant(window.localStorage.getItem(WANT_KEY)) } catch { return 'usdc' }
}

/** How much of a delivery to offer for conversion, or null when too little arrived. */
export function convertibleXlm(deliveredXlm: number): string | null {
  if (!Number.isFinite(deliveredXlm)) return null
  const amount = Math.floor((deliveredXlm - XLM_KEPT_BACK) * 100) / 100
  return amount > 0 ? amount.toFixed(2) : null
}

/** The Swap screen, set up to turn the delivered XLM into USDC. */
export function convertPath(deliveredXlm: number): string {
  const amount = convertibleXlm(deliveredXlm)
  return `/swap?from=XLM&to=USDC${amount ? `&amount=${amount}` : ''}`
}

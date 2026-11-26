import { useEffect, useState } from 'react'

// Fixed USDC figures from the approved design — all displayed amounts derive from these.
const BALANCE_USDC = 412.98
const TRANSFER_USDC = 16.08
const YIELD_USDC = 0.07  // approximate daily yield shown on home/balance screens
const LARGE_USDC = 32.15 // agent "swap" example (approx. 2x transfer)
const SMALL_USDC = 3.22  // agent "airtime" example (approx. 0.2x transfer)

type CurrencyInfo = {
  symbol: string
  decimals: number
  fallbackRate: number
}

const CURRENCIES: Record<string, CurrencyInfo> = {
  USD: { symbol: '$',   decimals: 2, fallbackRate: 1 },
  NGN: { symbol: '₦',   decimals: 0, fallbackRate: 1600 },
  KES: { symbol: 'KSh', decimals: 0, fallbackRate: 129 },
  GHS: { symbol: '₵',   decimals: 2, fallbackRate: 15 },
  ZAR: { symbol: 'R',   decimals: 2, fallbackRate: 18 },
  TZS: { symbol: 'TSh', decimals: 0, fallbackRate: 2600 },
  UGX: { symbol: 'USh', decimals: 0, fallbackRate: 3700 },
  RWF: { symbol: 'Fr',  decimals: 0, fallbackRate: 1360 },
  EGP: { symbol: 'E£',  decimals: 2, fallbackRate: 50 },
}

const TZ_CURRENCY: Record<string, string> = {
  'Africa/Lagos': 'NGN',
  'Africa/Kano': 'NGN',
  'Africa/Abuja': 'NGN',
  'Africa/Port_Harcourt': 'NGN',
  'Africa/Nairobi': 'KES',
  'Africa/Mombasa': 'KES',
  'Africa/Accra': 'GHS',
  'Africa/Johannesburg': 'ZAR',
  'Africa/Dar_es_Salaam': 'TZS',
  'Africa/Kampala': 'UGX',
  'Africa/Kigali': 'RWF',
  'Africa/Cairo': 'EGP',
}

function detectCurrencyCode(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return TZ_CURRENCY[tz] ?? 'USD'
  } catch {
    return 'USD'
  }
}

const FX_BASE_URL = 'https://open.er-api.com/v6/latest/USD'
const FX_TIMEOUT_MS = 5_000

async function fetchFxRates(): Promise<Record<string, number>> {
  if (typeof fetch === 'undefined') return {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FX_TIMEOUT_MS)
  try {
    const res = await fetch(FX_BASE_URL, { signal: controller.signal })
    if (!res.ok) return {}
    const data = (await res.json()) as { rates?: Record<string, number> }
    return data.rates && typeof data.rates === 'object' ? data.rates : {}
  } catch {
    return {}
  } finally {
    clearTimeout(timer)
  }
}

function effectiveRate(code: string, liveRates: Record<string, number>): number {
  return liveRates[code] ?? CURRENCIES[code]?.fallbackRate ?? 1
}

function roundBalance(value: number, decimals: number): number {
  if (decimals > 0) return value
  if (value >= 100_000) return Math.round(value / 1000) * 1000
  if (value >= 10_000) return Math.round(value / 100) * 100
  return Math.round(value)
}

function roundAmount(value: number, decimals: number): number {
  if (decimals > 0) return value
  if (value >= 10_000) return Math.round(value / 1000) * 1000
  if (value >= 1_000) return Math.round(value / 100) * 100
  if (value >= 100) return Math.round(value / 10) * 10
  return Math.round(value)
}

function fmt(value: number, info: CurrencyInfo): string {
  const n = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: info.decimals,
    maximumFractionDigits: info.decimals,
  }).format(value)
  return `${info.symbol}${n}`
}

export type RegionalAmounts = {
  symbol: string
  balance: string
  dailyYield: string
  transfer: string
  chips: [string, string, string, string]
  largeAmount: string
  smallAmount: string
}

function buildAmounts(code: string, liveRates: Record<string, number>): RegionalAmounts {
  const info = CURRENCIES[code] ?? CURRENCIES['USD']!
  const rate = effectiveRate(code, liveRates)

  const balanceVal = roundBalance(BALANCE_USDC * rate, info.decimals)
  const yieldVal = info.decimals > 0
    ? Math.round(YIELD_USDC * rate * 100) / 100
    : Math.round(YIELD_USDC * rate)
  const transferVal = roundAmount(TRANSFER_USDC * rate, info.decimals)

  const chip = (factor: number) =>
    fmt(roundAmount(TRANSFER_USDC * rate * factor, info.decimals), info)

  return {
    symbol: info.symbol,
    balance: fmt(balanceVal, info),
    dailyYield: fmt(yieldVal, info),
    transfer: fmt(transferVal, info),
    chips: [chip(0.2), chip(0.4), chip(1), chip(2)],
    largeAmount: fmt(roundAmount(LARGE_USDC * rate, info.decimals), info),
    smallAmount: fmt(roundAmount(SMALL_USDC * rate, info.decimals), info),
  }
}

const USD_AMOUNTS = buildAmounts('USD', {})

/**
 * Resolves the visitor's region from their timezone and returns mockup amounts
 * in the corresponding local currency.
 *
 * The initial state is always USD, matching the server render. After mount the
 * hook swaps to the detected currency, then again once live FX rates arrive.
 * This keeps the first client render identical to the server markup, avoiding
 * hydration mismatches.
 */
export function useRegionalCurrency(): RegionalAmounts {
  const [amounts, setAmounts] = useState<RegionalAmounts>(USD_AMOUNTS)

  useEffect(() => {
    const code = detectCurrencyCode()
    setAmounts(buildAmounts(code, {}))
    void fetchFxRates().then((rates) => {
      if (Object.keys(rates).length > 0) {
        setAmounts(buildAmounts(code, rates))
      }
    })
  }, [])

  return amounts
}

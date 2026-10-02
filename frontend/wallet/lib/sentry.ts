import * as Sentry from '@sentry/nextjs'

const STORAGE_KEY = 'veil_sentry_opt_in'

// Stellar public key: G + 55 base32 chars; secret key: S + 55 base32 chars
const STELLAR_ADDRESS_RE = /\bG[A-Z2-7]{55}\b/g
const STELLAR_SECRET_RE = /\bS[A-Z2-7]{55}\b/g
// Amounts with or without a known asset suffix
const AMOUNT_RE = /\b\d+(\.\d+)?(\s*(XLM|USDC|BTC|ETH|xlm|usdc|btc|eth))?\b(?=\s*(?:XLM|USDC|BTC|ETH|xlm|usdc|btc|eth))/g

export function getSentryOptIn(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(STORAGE_KEY) === 'true'
}

export function setSentryOptIn(value: boolean): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(STORAGE_KEY, String(value))
}

type SentryEvent = Parameters<NonNullable<Parameters<typeof Sentry.init>[0]['beforeSend']>>[0]

function scrubString(s: string): string {
  return s
    .replace(STELLAR_SECRET_RE, '[secret]')
    .replace(STELLAR_ADDRESS_RE, '[address]')
    .replace(/\b\d+(\.\d+)?\s+(XLM|USDC|BTC|ETH|xlm|usdc|btc|eth)\b/g, '[amount]')
}

export function scrubEvent(event: SentryEvent): SentryEvent | null {
  if (event.message) {
    event.message = scrubString(event.message)
  }
  if (event.exception?.values) {
    for (const ex of event.exception.values) {
      if (ex.value) ex.value = scrubString(ex.value)
    }
  }
  return event
}

let initialized = false

export function initSentry(): void {
  if (typeof window === 'undefined') return
  if (!getSentryOptIn()) return
  if (initialized) return
  initialized = true

  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0,
    beforeSend: scrubEvent,
  })
}

export function resetSentryInitForTesting(): void {
  initialized = false
}

/**
 * Point-of-sale helpers: detect an incoming Stellar payment for a charge.
 *
 * The merchant side is plain SEP-7 + Horizon, so these helpers have no wallet
 * dependency and are easy to reason about (and unit test).
 */

/** Subset of a Horizon `payment` operation record we rely on. */
export interface HorizonPayment {
  id: string
  type: string
  to?: string
  amount?: string
  asset_type?: string
  asset_code?: string
  asset_issuer?: string
  created_at?: string
  transaction_hash?: string
  /** Present when the payments call is made with `join=transactions`. */
  transaction?: { memo?: string; memo_type?: string }
}

export interface ChargeTarget {
  destination: string
  amount: string
  /** Omit for native XLM. */
  assetCode?: string
  assetIssuer?: string
  /** ISO timestamp; only payments at/after this are considered. */
  since: string
  /** Optional SEP-7 memo to match against the paying transaction. */
  memo?: string
}

const SEP7_SCHEME = 'web+stellar:'

export interface PayUriParams {
  destination: string
  amount: string
  /** Omit for native XLM. */
  assetCode?: string
  assetIssuer?: string
  memo?: string
  networkPassphrase?: string
}

// RFC 3986-safe encoding (also escapes the sub-delims encodeURIComponent leaves),
// matching what the Veil wallet's SEP-7 builder/parser expects.
function encodeSep7(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

/**
 * Builds a SEP-7 `web+stellar:pay` URI for a charge. The query shape mirrors the
 * Veil wallet's own SEP-7 builder, so the wallet parses it cleanly: a text memo
 * carries no `memo_type`, and native XLM carries no `asset_code`/`asset_issuer`.
 */
export function buildPayUri(params: PayUriParams): string {
  const destination = params.destination.trim()
  if (!/^[GMC][A-Z2-7]{55,68}$/.test(destination)) {
    throw new Error(`Invalid destination address: "${params.destination}"`)
  }
  const amount = params.amount.trim()
  if (!/^\d+(\.\d+)?$/.test(amount) || Number(amount) <= 0) {
    throw new Error(`Enter a positive amount.`)
  }

  const pairs: Array<[string, string]> = [
    ['destination', destination],
    ['amount', amount],
  ]

  const code = params.assetCode?.trim()
  if (code && code.toUpperCase() !== 'XLM') {
    const issuer = params.assetIssuer?.trim()
    if (!issuer) throw new Error('A non-native asset needs an issuer address.')
    pairs.push(['asset_code', code], ['asset_issuer', issuer])
  }

  if (params.memo) pairs.push(['memo', params.memo])
  if (params.networkPassphrase) pairs.push(['network_passphrase', params.networkPassphrase])

  return `${SEP7_SCHEME}pay?${pairs.map(([k, v]) => `${k}=${encodeSep7(v)}`).join('&')}`
}

/** A short, URL-safe memo used to correlate a QR with its payment. */
export function generateMemo(): string {
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase()
  return `POS-${rand}`
}

export function buildHorizonPaymentsUrl(horizonUrl: string, account: string): string {
  const base = horizonUrl.replace(/\/+$/, '')
  return `${base}/accounts/${account}/payments?order=desc&limit=20&join=transactions`
}

function amountsEqual(a: string, b: string): boolean {
  // Horizon amounts are 7-dp strings; compare on the integer stroop value.
  const toStroops = (v: string): bigint | null => {
    if (!/^\d+(\.\d+)?$/.test(v.trim())) return null
    const [whole, frac = ''] = v.trim().split('.')
    return BigInt(whole + frac.padEnd(7, '0').slice(0, 7))
  }
  const sa = toStroops(a)
  const sb = toStroops(b)
  return sa !== null && sb !== null && sa === sb
}

function assetMatches(payment: HorizonPayment, target: ChargeTarget): boolean {
  if (!target.assetCode) {
    return payment.asset_type === 'native'
  }
  return (
    payment.asset_code === target.assetCode &&
    payment.asset_issuer === target.assetIssuer
  )
}

/**
 * Returns the first payment that settles a charge: right destination, asset and
 * amount, created at/after the charge started. When a memo is supplied and the
 * transaction memo is available, it must also match.
 */
export function matchPayment(
  payments: HorizonPayment[],
  target: ChargeTarget,
): HorizonPayment | null {
  for (const payment of payments) {
    if (payment.type !== 'payment') continue
    if (payment.to !== target.destination) continue
    if (!payment.amount || !amountsEqual(payment.amount, target.amount)) continue
    if (!assetMatches(payment, target)) continue
    if (payment.created_at && payment.created_at < target.since) continue
    if (target.memo && payment.transaction?.memo && payment.transaction.memo !== target.memo) {
      continue
    }
    return payment
  }
  return null
}

/** Polls Horizon once and returns a settling payment, or null. */
export async function fetchSettlingPayment(
  horizonUrl: string,
  target: ChargeTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<HorizonPayment | null> {
  const res = await fetchImpl(buildHorizonPaymentsUrl(horizonUrl, target.destination))
  if (!res.ok) {
    throw new Error(`Horizon responded ${res.status}`)
  }
  const body = (await res.json()) as { _embedded?: { records?: HorizonPayment[] } }
  const records = body._embedded?.records ?? []
  return matchPayment(records, target)
}

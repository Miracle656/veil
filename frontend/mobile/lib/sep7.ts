/**
 * SEP-7 "pay" request parsing for the mobile app.
 *
 * Ported from `frontend/wallet/lib/sep7.ts` (same shape and helper names).
 *
 * Scope note: routing an inbound link to a screen is `lib/deepLinks.ts`'s job —
 * it owns the allowlist, host checks and the `web+stellar:` → `/pay` mapping for
 * both cold start and warm resume. This module is the SEP-7 payload layer either
 * side of that: parsing a scanned QR value, and building a pay URI to hand out.
 */

export type Sep7Parsed = {
  destination?: string
  amount?: string
  assetCode?: string
  assetIssuer?: string
  memo?: string
}

const WEB_STELLAR_SCHEME = 'web+stellar:'

function toMaybeString(v: string | null | undefined): string | undefined {
  if (v == null) return undefined
  const t = String(v).trim()
  return t ? t : undefined
}

function fieldsFromParams(params: URLSearchParams): Sep7Parsed {
  return {
    destination: toMaybeString(params.get('destination')),
    amount: toMaybeString(params.get('amount')),
    assetCode: toMaybeString(params.get('asset_code')),
    assetIssuer: toMaybeString(params.get('asset_issuer')),
    memo: toMaybeString(params.get('memo')),
  }
}

/** Parse a `web+stellar:pay?...` URI. Returns `null` if it isn't one. */
export function parseSep7Uri(input: string): Sep7Parsed | null {
  const raw = input.trim()
  if (!raw.toLowerCase().startsWith(WEB_STELLAR_SCHEME)) return null

  // web+stellar:pay?... has no "//" authority, so URL can't parse it directly;
  // coerce it into a parseable form the same way the wallet's lib does.
  let url: URL
  try {
    url = new URL(raw.replace(/^web\+stellar:/i, 'web+stellar://'))
  } catch {
    return null
  }

  const operation = (url.hostname || url.pathname.replace(/^\/+/, '')).toLowerCase()
  if (operation !== 'pay') return null

  return fieldsFromParams(url.searchParams)
}

export function looksLikeStellarAddress(s: string): boolean {
  const v = s.trim()
  return (v.startsWith('G') || v.startsWith('C')) && v.length === 56
}

/** Parse a scanned QR value: either a bare Stellar address or a `web+stellar:` URI. */
export function parseQrValue(value: string): Sep7Parsed | { destination: string } | null {
  const v = value.trim()
  if (!v) return null

  if (looksLikeStellarAddress(v)) return { destination: v }

  return parseSep7Uri(v)
}

export function buildSep7PayUri(opts: {
  destination: string
  amount?: string
  assetCode?: string
  assetIssuer?: string
  memo?: string
}): string {
  const params = new URLSearchParams()
  params.set('destination', opts.destination)
  if (opts.amount) params.set('amount', opts.amount)
  if (opts.assetCode) params.set('asset_code', opts.assetCode)
  if (opts.assetIssuer) params.set('asset_issuer', opts.assetIssuer)
  if (opts.memo) params.set('memo', opts.memo)

  return `${WEB_STELLAR_SCHEME}pay?${params.toString()}`
}

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

export const REGISTERED_ISSUERS: Record<string, string[]> = {
  USDT0: ['GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q'],
  USDC: [
    'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  ],
}

export function isRegisteredIssuer(assetCode: string, issuer: string): boolean {
  const registered = REGISTERED_ISSUERS[assetCode.toUpperCase()]
  if (!registered) return true
  return registered.includes(issuer)
}

function fieldsFromParams(params: URLSearchParams): Sep7Parsed | null {
  const assetCode = toMaybeString(params.get('asset_code'))
  const assetIssuer = toMaybeString(params.get('asset_issuer'))

  if (assetCode !== undefined) {
    const isNative = assetCode.toUpperCase() === 'XLM' && assetIssuer === undefined
    if (!isNative) {
      if (!assetIssuer) return null
      if (!isRegisteredIssuer(assetCode, assetIssuer)) return null
    }
  } else if (assetIssuer !== undefined) {
    return null
  }

  return {
    destination: toMaybeString(params.get('destination')),
    amount: toMaybeString(params.get('amount')),
    assetCode,
    assetIssuer,
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
  if (opts.assetCode && opts.assetCode.toUpperCase() !== 'XLM') {
    if (!opts.assetIssuer) {
      throw new Error(`asset_issuer is required for non-native asset ${opts.assetCode}`)
    }
    if (!isRegisteredIssuer(opts.assetCode, opts.assetIssuer)) {
      throw new Error(`Unregistered asset issuer: "${opts.assetIssuer}"`)
    }
  }

  const params = new URLSearchParams()
  params.set('destination', opts.destination)
  if (opts.amount) params.set('amount', opts.amount)
  if (opts.assetCode) params.set('asset_code', opts.assetCode)
  if (opts.assetIssuer) params.set('asset_issuer', opts.assetIssuer)
  if (opts.memo) params.set('memo', opts.memo)

  return `${WEB_STELLAR_SCHEME}pay?${params.toString()}`
}

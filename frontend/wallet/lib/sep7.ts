export type Sep7Parsed = {
  destination?: string
  amount?: string
  assetCode?: string
  assetIssuer?: string
  memo?: string
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

function decodeComponentSafe(v: string): string {
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '))
  } catch {
    return v
  }
}

function toMaybeString(v: string | null | undefined): string | undefined {
  if (v == null) return undefined
  const t = String(v).trim()
  return t ? t : undefined
}

export function parseSep7Uri(input: string): Sep7Parsed | null {
  const raw = input.trim()
  if (!raw) return null

  // SEP-7: web+stellar:<path>?<params>
  if (!raw.toLowerCase().startsWith('web+stellar:')) return null

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    try {
      url = new URL(raw.replace(/^web\+stellar:/i, 'web+stellar://'))
    } catch {
      return null
    }
  }

  const params = url.searchParams

  const destination = toMaybeString(params.get('destination'))
  const amount = toMaybeString(params.get('amount'))
  const memo = toMaybeString(params.get('memo'))

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
    destination,
    amount,
    assetCode,
    assetIssuer,
    memo,
  }
}

export function looksLikeStellarAddress(s: string): boolean {
  const v = s.trim()
  return (v.startsWith('G') || v.startsWith('C')) && v.length === 56
}

export function parseQrValue(value: string): Sep7Parsed | { destination: string } | null {
  const v = value.trim()
  if (!v) return null

  if (looksLikeStellarAddress(v)) return { destination: v }

  const sep7 = parseSep7Uri(v)
  if (!sep7) return null

  return sep7
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

  return `web+stellar:pay?${params.toString()}`
}


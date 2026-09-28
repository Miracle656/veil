export type Sep7Parsed = {
  destination?: string
  amount?: string
  assetCode?: string
  assetIssuer?: string
  memo?: string
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

  // Some senders omit the scheme separator and only include web+stellar:pay?... so we
  // prepend a scheme that URL can handle reliably.
  // URL requires a scheme; the scheme here is already provided.
  //
  // Example: web+stellar:pay?destination=G...&amount=1.23&asset_code=USD&asset_issuer=...
  let url: URL
  try {
    // URL can parse this directly because it includes a scheme.
    url = new URL(raw)
  } catch {
    // Try fallback by ensuring proper scheme format
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

  // If asset_code exists without asset_issuer we still return code (caller decides).
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
  const params = new URLSearchParams()
  params.set('destination', opts.destination)
  if (opts.amount) params.set('amount', opts.amount)
  if (opts.assetCode) params.set('asset_code', opts.assetCode)
  if (opts.assetIssuer) params.set('asset_issuer', opts.assetIssuer)
  if (opts.memo) params.set('memo', opts.memo)

  return `web+stellar:pay?${params.toString()}`
}


import { Memo } from '@stellar/stellar-sdk'

export type Sep7MemoType = 'MEMO_TEXT' | 'MEMO_ID' | 'MEMO_HASH' | 'MEMO_RETURN'

export type Sep7Parsed = {
  destination?: string
  amount?: string
  assetCode?: string
  assetIssuer?: string
  memo?: string
  memoType?: Sep7MemoType | string
}

function to32ByteHex(value: string): string | null {
  const trimmed = value.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed.toLowerCase()
  }
  try {
    const buf = Buffer.from(trimmed, 'base64')
    if (buf.length === 32) {
      return buf.toString('hex')
    }
  } catch {}
  return null
}

/**
 * Constructs a Stellar SDK Memo based on the SEP-7 memo_type.
 * If memoType is omitted or empty, defaults to MEMO_TEXT behavior as today.
 * If memoType is unknown or malformed, refuses with an error naming the unknown type.
 */
export function buildSep7Memo(memo: string, memoType?: string | null): Memo {
  if (!memoType || memoType.toUpperCase() === 'MEMO_TEXT' || memoType.toLowerCase() === 'text') {
    return Memo.text(memo)
  }

  const normalized = memoType.toUpperCase()
  switch (normalized) {
    case 'MEMO_ID':
    case 'ID': {
      const trimmed = memo.trim()
      if (!/^\d+$/.test(trimmed)) {
        throw new Error(`Invalid MEMO_ID: "${memo}" must be an unsigned integer`)
      }
      return Memo.id(trimmed)
    }
    case 'MEMO_HASH':
    case 'HASH': {
      const hex = to32ByteHex(memo)
      if (!hex) {
        throw new Error(`Invalid MEMO_HASH: "${memo}" must be 32 bytes (hex or base64)`)
      }
      return Memo.hash(hex)
    }
    case 'MEMO_RETURN':
    case 'RETURN': {
      const hex = to32ByteHex(memo)
      if (!hex) {
        throw new Error(`Invalid MEMO_RETURN: "${memo}" must be 32 bytes (hex or base64)`)
      }
      return Memo.return(hex)
    }
    default:
      throw new Error(`Unknown memo_type: "${memoType}"`)
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
  const rawMemoType = toMaybeString(params.get('memo_type'))

  let memoType: Sep7MemoType | undefined = undefined
  if (rawMemoType) {
    const upper = rawMemoType.toUpperCase()
    if (upper === 'MEMO_TEXT' || upper === 'TEXT') {
      memoType = 'MEMO_TEXT'
    } else if (upper === 'MEMO_ID' || upper === 'ID') {
      memoType = 'MEMO_ID'
    } else if (upper === 'MEMO_HASH' || upper === 'HASH') {
      memoType = 'MEMO_HASH'
    } else if (upper === 'MEMO_RETURN' || upper === 'RETURN') {
      memoType = 'MEMO_RETURN'
    } else {
      throw new Error(`Unknown memo_type: "${rawMemoType}"`)
    }
  }

  if (memo && memoType) {
    // Validate that the memo value can be constructed for this memoType
    buildSep7Memo(memo, memoType)
  }


  const assetCode = toMaybeString(params.get('asset_code'))
  const assetIssuer = toMaybeString(params.get('asset_issuer'))

  // If asset_code exists without asset_issuer we still return code (caller decides).
  return {
    destination,
    amount,
    assetCode,
    assetIssuer,
    memo,
    memoType,
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
  memoType?: Sep7MemoType | string
}): string {
  const params = new URLSearchParams()
  params.set('destination', opts.destination)
  if (opts.amount) params.set('amount', opts.amount)
  if (opts.assetCode) params.set('asset_code', opts.assetCode)
  if (opts.assetIssuer) params.set('asset_issuer', opts.assetIssuer)
  if (opts.memo) params.set('memo', opts.memo)
  if (opts.memoType) params.set('memo_type', opts.memoType)

  return `web+stellar:pay?${params.toString()}`
}

/**
 * Safely parse and build a Stellar SDK Memo instance from a memo value and optional memo type.
 *
 * Supports standard SEP-7 memo types:
 * - 'text' / 'MEMO_TEXT' (default): UTF-8 text up to 28 bytes.
 * - 'id' / 'MEMO_ID': Unsigned 64-bit integer string.
 * - 'hash' / 'MEMO_HASH': 32-byte hash (64 hex characters or base64 encoded).
 * - 'return' / 'MEMO_RETURN': 32-byte hash (64 hex characters or base64 encoded).
 *
 * Throws an explicit, user-readable Error if the memo value or type is invalid or unsupported.
 */
export function buildStellarMemo(memo: string, memoType?: string | null): Memo | null {
  const trimmed = memo.trim()
  if (!trimmed) return null

  const rawType = (memoType || 'text').trim()
  const lower = rawType.toLowerCase()
  const normalized = lower.startsWith('memo_') ? lower.slice(5) : lower

  switch (normalized) {
    case 'text': {
      const bytes = new TextEncoder().encode(trimmed)
      if (bytes.length > 28) {
        throw new Error(`Text memo exceeds 28 bytes limit (${bytes.length} bytes).`)
      }
      return Memo.text(trimmed)
    }
    case 'id': {
      if (!/^\d+$/.test(trimmed)) {
        throw new Error('ID memo must be an unsigned 64-bit integer.')
      }
      let val: bigint
      try {
        val = BigInt(trimmed)
      } catch {
        throw new Error('ID memo must be an unsigned 64-bit integer.')
      }
      if (val < 0n || val > 18446744073709551615n) {
        throw new Error('ID memo exceeds 64-bit unsigned integer range.')
      }
      return Memo.id(trimmed)
    }
    case 'hash':
    case 'return': {
      let buf: Buffer
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        buf = Buffer.from(trimmed, 'hex')
      } else {
        try {
          const normalizedB64 = trimmed.replace(/-/g, '+').replace(/_/g, '/')
          const padded = normalizedB64 + '='.repeat((4 - (normalizedB64.length % 4)) % 4)
          buf = Buffer.from(padded, 'base64')
        } catch {
          throw new Error(`${normalized.toUpperCase()} memo must be a valid 32-byte hash (hex or base64).`)
        }
      }
      if (buf.length !== 32) {
        throw new Error(`${normalized.toUpperCase()} memo must decode to 32 bytes (got ${buf.length}).`)
      }
      const hex = buf.toString('hex')
      return normalized === 'hash' ? Memo.hash(hex) : Memo.return(hex)
    }
    default:
      throw new Error(`Unsupported memo type: "${memoType}".`)
  }
}

/**
 * Validate a memo without throwing, returning a human-readable error or null if valid.
 */
export function validateMemo(memo: string, memoType?: string | null): string | null {
  if (!memo || !memo.trim()) return null
  try {
    buildStellarMemo(memo, memoType)
    return null
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err)
  }
}


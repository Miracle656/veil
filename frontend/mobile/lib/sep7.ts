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

import type { Memo } from '@stellar/stellar-sdk'

export type Sep7MemoType = 'MEMO_TEXT' | 'MEMO_ID' | 'MEMO_HASH' | 'MEMO_RETURN'

export type Sep7Parsed = {
  destination?: string
  amount?: string
  assetCode?: string
  assetIssuer?: string
  memo?: string
  memoType?: Sep7MemoType
}

const WEB_STELLAR_SCHEME = 'web+stellar:'

let cachedMemoClass: typeof Memo | null = null
function getMemoClass(): typeof Memo {
  if (!cachedMemoClass) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cachedMemoClass = require('@stellar/stellar-sdk').Memo
  }
  return cachedMemoClass!
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
  const MemoClass = getMemoClass()
  if (!memoType || memoType.toUpperCase() === 'MEMO_TEXT' || memoType.toLowerCase() === 'text') {
    return MemoClass.text(memo)
  }

  const normalized = memoType.toUpperCase()
  switch (normalized) {
    case 'MEMO_ID':
    case 'ID': {
      const trimmed = memo.trim()
      if (!/^\d+$/.test(trimmed)) {
        throw new Error(`Invalid MEMO_ID: "${memo}" must be an unsigned integer`)
      }
      return MemoClass.id(trimmed)
    }
    case 'MEMO_HASH':
    case 'HASH': {
      const hex = to32ByteHex(memo)
      if (!hex) {
        throw new Error(`Invalid MEMO_HASH: "${memo}" must be 32 bytes (hex or base64)`)
      }
      return MemoClass.hash(hex)
    }
    case 'MEMO_RETURN':
    case 'RETURN': {
      const hex = to32ByteHex(memo)
      if (!hex) {
        throw new Error(`Invalid MEMO_RETURN: "${memo}" must be 32 bytes (hex or base64)`)
      }
      return MemoClass.return(hex)
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

function fieldsFromParams(params: URLSearchParams): Sep7Parsed {
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

  const memo = toMaybeString(params.get('memo'))
  if (memo && memoType) {
    buildSep7Memo(memo, memoType)
  }

  return {
    destination: toMaybeString(params.get('destination')),
    amount: toMaybeString(params.get('amount')),
    assetCode: toMaybeString(params.get('asset_code')),
    assetIssuer: toMaybeString(params.get('asset_issuer')),
    memo,
    memoType,
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
  memoType?: Sep7MemoType | string
}): string {
  const params = new URLSearchParams()
  params.set('destination', opts.destination)
  if (opts.amount) params.set('amount', opts.amount)
  if (opts.assetCode) params.set('asset_code', opts.assetCode)
  if (opts.assetIssuer) params.set('asset_issuer', opts.assetIssuer)
  if (opts.memo) params.set('memo', opts.memo)
  if (opts.memoType) params.set('memo_type', opts.memoType)

  return `${WEB_STELLAR_SCHEME}pay?${params.toString()}`
}

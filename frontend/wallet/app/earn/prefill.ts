import { StrKey } from '@stellar/stellar-sdk'

export interface InvestPrefill {
  asset: string
  issuer: string
  amount: string
}

export function parseInvestIntent(value: unknown): InvestPrefill | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = value as Record<string, unknown>
  if (!v.asset || typeof v.asset !== 'object') return undefined
  const asset = v.asset as Record<string, unknown>
  const code = typeof asset.code === 'string' ? asset.code.trim().toUpperCase() : ''
  const issuer = typeof asset.issuer === 'string' ? asset.issuer.trim() : ''
  const amount = typeof v.amount === 'string' ? v.amount.trim() : ''
  if (!/^[A-Z0-9]{1,12}$/.test(code) || !StrKey.isValidEd25519PublicKey(issuer)) return undefined
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) return undefined
  return { asset: code, issuer, amount }
}

export function parseInvestPrefill(search: string): InvestPrefill | undefined {
  const q = new URLSearchParams(search)
  const asset = q.get('asset')?.trim().toUpperCase() ?? ''
  const issuer = q.get('issuer')?.trim() ?? ''
  const amount = q.get('amount')?.trim() ?? ''
  if (!/^[A-Z0-9]{1,12}$/.test(asset) || !StrKey.isValidEd25519PublicKey(issuer)) return undefined
  if (!/^\d+(\.\d{1,7})?$/.test(amount) || Number(amount) <= 0) return undefined
  return { asset, issuer, amount }
}

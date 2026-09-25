import { inclusionFee } from './fees'
import {
  Asset,
  BASE_FEE,
  Operation,
  StellarToml,
  TransactionBuilder,
  type Account,
  type Transaction,
} from '@stellar/stellar-sdk'

/**
 * Trustline management helpers (issue #343).
 *
 * Classic Stellar assets require a trustline before they can be held. These
 * helpers read existing trustlines from a Horizon account, build the
 * passkey-signed `changeTrust` transactions that add or remove them, and look
 * up assets from an anchor's stellar.toml.
 */

/** Subset of a Horizon balance entry we depend on. */
export interface HorizonBalanceLike {
  asset_type: string
  asset_code?: string
  asset_issuer?: string
  balance: string
  limit?: string
}

export interface Trustline {
  code: string
  issuer: string
  balance: string
  limit: string
  assetType: string
}

export interface AnchorAsset {
  code: string
  issuer: string
}

/** Setting a trustline limit to zero removes it (only allowed at zero balance). */
export const REMOVE_TRUSTLINE_LIMIT = '0'

/** Extracts the classic (non-native, non-pool-share) trustlines from balances. */
export function parseTrustlines(balances: HorizonBalanceLike[]): Trustline[] {
  return balances
    .filter(
      (b) =>
        b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12',
    )
    .filter((b) => b.asset_code && b.asset_issuer)
    .map((b) => ({
      code: b.asset_code as string,
      issuer: b.asset_issuer as string,
      balance: b.balance,
      limit: b.limit ?? REMOVE_TRUSTLINE_LIMIT,
      assetType: b.asset_type,
    }))
}

/** True when the account already trusts `code:issuer`. */
export function hasTrustline(
  balances: HorizonBalanceLike[],
  code: string,
  issuer: string,
): boolean {
  return balances.some((b) => b.asset_code === code && b.asset_issuer === issuer)
}

/** Each classic trustline locks exactly 0.5 XLM of ledger base reserve. */
export const TRUSTLINE_RESERVE_XLM = 0.5

export interface TrustlineReserveImpact {
  reserveCost: number
  currentSpendable: number
  projectedSpendable: number
  canAfford: boolean
}

/**
 * Calculates the reserve cost and remaining spendable XLM before adding trustlines.
 */
export function calculateSpendableAfterTrustline(
  spendableXlm: string | number,
  additionalTrustlines = 1,
): TrustlineReserveImpact {
  const current = Math.max(0, Number(spendableXlm) || 0)
  const reserveCost = additionalTrustlines * TRUSTLINE_RESERVE_XLM
  const projected = Math.max(0, current - reserveCost)
  const canAfford = current >= reserveCost
  return {
    reserveCost,
    currentSpendable: current,
    projectedSpendable: Number((Math.floor(projected * 1e7) / 1e7).toFixed(7)),
    canAfford,
  }
}

/**
 * A trustline can only be removed when its balance is exactly zero — Stellar
 * rejects a `changeTrust` to zero while the holder still owns the asset.
 */
export function canRemoveTrustline(trustline: Trustline): boolean {
  return Number(trustline.balance) === 0
}

/**
 * Explains why a trustline removal is refused if the balance is non-zero.
 */
export function getRemovalRefusalReason(trustline: Trustline): string | null {
  const bal = Number(trustline.balance)
  if (!Number.isFinite(bal) || bal > 0) {
    return `Cannot remove trustline for ${trustline.code}: balance is ${trustline.balance} (must be 0 to remove and reclaim 0.5 XLM reserve).`
  }
  return null
}

/**
 * Builds a `changeTrust` transaction for `code:issuer`. Pass `remove: true` to
 * delete the trustline; otherwise it is added at the maximum limit (or
 * `limit`, when provided). The returned transaction still needs to be signed.
 */
export function buildChangeTrustTx(params: {
  account: Account
  networkPassphrase: string
  code: string
  issuer: string
  remove?: boolean
  limit?: string
}): Transaction {
  const asset = new Asset(params.code, params.issuer)
  const limit = params.remove ? REMOVE_TRUSTLINE_LIMIT : params.limit

  return new TransactionBuilder(params.account, {
    fee: inclusionFee(),
    networkPassphrase: params.networkPassphrase,
  })
    .addOperation(
      Operation.changeTrust(limit !== undefined ? { asset, limit } : { asset }),
    )
    .setTimeout(30)
    .build()
}

type StellarTomlLike = {
  CURRENCIES?: Array<{ code?: string; issuer?: string }>
}

/** Strips scheme and path so a stellar.toml resolver receives a bare domain. */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim()
}

/**
 * Resolves an anchor's stellar.toml and returns its declared assets. The
 * resolver is injectable so the lookup can be unit-tested without the network.
 */
export async function resolveAnchorAssets(
  domain: string,
  resolver: (domain: string) => Promise<StellarTomlLike> = (d) =>
    StellarToml.Resolver.resolve(d),
): Promise<AnchorAsset[]> {
  const normalized = normalizeDomain(domain)
  if (!normalized) return []

  const toml = await resolver(normalized)
  return (toml.CURRENCIES ?? [])
    .filter((c): c is AnchorAsset => Boolean(c.code && c.issuer))
    .map((c) => ({ code: c.code, issuer: c.issuer }))
}

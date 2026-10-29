/**
 * Per-asset explainer for tokenized sovereign debt ("Stablebonds"), #1060.
 *
 * Shape follows the USDY explainer built in V180: what the asset is, whose debt
 * it is, who issues the token, that the price moves rather than paying out, and
 * that Veil is not the counterparty.
 *
 * Every per-asset word is interpolated from two sources, so no prose is written
 * per asset here:
 *   - the registry (`RegisteredAsset`): code, name, issuer, issuerName,
 *     homeDomain, and `obligor` (the issuing government);
 *   - the issuer's own stellar.toml (`IssuerTomlMetadata`): `desc`,
 *     `anchor_asset`, `anchor_asset_type`, `image`.
 *
 * When the TOML is missing or unreachable the registry facts still produce a
 * complete, honest screen; only the issuer-written description and the stated
 * backing line are omitted, and the screen says so rather than inventing them.
 */

import type { RegisteredAsset } from './assets'
import { PROHIBITED_ADVICE_WORDS } from './usdy'

// Re-exported so a reviewer of this module sees the banned list next to the
// copy it governs. The list itself lives with the USDY explainer.
export { PROHIBITED_ADVICE_WORDS }

/** The issuer-TOML fields the explainer reads; a live `IssuerTomlMetadata` satisfies this. */
export interface BondIssuerMetadata {
  description?: string | null
  imageUrl?: string | null
  anchorAsset?: string | null
  anchorAssetType?: string | null
}

export interface BondExplainer {
  code: string
  name: string
  issuerName: string
  issuerAddress: string
  homeDomain: string | null
  /** Whose debt the token represents, from the registry. */
  obligor: string | null
  /** What the token is anchored to, from the issuer's own TOML. */
  backingAsset: string | null
  backingAssetType: string | null
  /** The issuer's own description, shown verbatim rather than rewritten. */
  description: string | null
  imageUrl: string | null
  /** True only when the issuer's TOML supplied anchor metadata. */
  issuerMetadataAvailable: boolean
  whatItIs: string
  whoIssuesIt: string
  howThePriceWorks: string
  veilsRole: string
  /** The issuer's own site, where their disclosures live. */
  issuerSiteUrl: string | null
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * Builds the explainer for a registered sovereign-debt asset. Pure: it takes
 * the registry entry and whatever the issuer's TOML yielded (or nothing) and
 * returns display copy. It never invents a backing, an issuer or a number.
 */
export function buildBondExplainer(
  asset: RegisteredAsset,
  issuerMeta?: BondIssuerMetadata | null,
): BondExplainer {
  const homeDomain = nonEmpty(asset.homeDomain)
  const obligor = nonEmpty(asset.obligor)
  const backingAsset = nonEmpty(issuerMeta?.anchorAsset)
  const backingAssetType = nonEmpty(issuerMeta?.anchorAssetType)
  const description = nonEmpty(issuerMeta?.description)
  const imageUrl = nonEmpty(issuerMeta?.imageUrl)
  const issuerMetadataAvailable = Boolean(backingAsset || description)

  const backingClause = backingAsset
    ? `The issuer's own stellar.toml says the token is backed by ${backingAsset}` +
      (backingAssetType ? ` (${backingAssetType})` : '') +
      '.'
    : "The issuer's stellar.toml could not be read, so its stated backing is not shown here."

  const whatItIs = obligor
    ? `${asset.name} is a token that represents debt of the ${obligor}. ` +
      `Holding it is exposure to that government's debt — it is not a bank deposit, and it is not a claim on Veil. ` +
      backingClause
    : `${asset.name} is a token issued on Stellar by ${asset.issuerName}. ` + backingClause

  const issuerWhere = homeDomain ? `${asset.issuerName} (${homeDomain})` : asset.issuerName
  const whoIssuesIt =
    `The token is issued on Stellar by ${issuerWhere} at issuer account ${asset.issuer}. ` +
    (obligor
      ? `${asset.issuerName} is the token issuer; the underlying debt is owed by the ${obligor}, and those are two different parties.`
      : `${asset.issuerName} is the token issuer.`)

  const howThePriceWorks =
    'This token does not pay out periodic cash. Its price moves with the market: the price shown on ' +
    'this screen is the level buyers and sellers are currently agreeing on, not a forecast and not a ' +
    'figure Veil sets.'

  const veilsRole =
    'Veil does not issue this token, does not take custody of it, is not the counterparty to your trade, ' +
    'and gives no advice about whether to buy or hold it. This asset needs no approval from Veil, and Veil collects no identity documents for it.'

  return {
    code: asset.code,
    name: asset.name,
    issuerName: asset.issuerName,
    issuerAddress: asset.issuer,
    homeDomain,
    obligor,
    backingAsset,
    backingAssetType,
    description,
    imageUrl,
    issuerMetadataAvailable,
    whatItIs,
    whoIssuesIt,
    howThePriceWorks,
    veilsRole,
    issuerSiteUrl: homeDomain ? `https://${homeDomain}` : null,
  }
}

/** True when the registry marks an asset as tokenized sovereign debt. */
export function isSovereignDebt(asset: RegisteredAsset | null | undefined): boolean {
  return Boolean(asset && asset.kind === 'treasury' && asset.obligor)
}

/** Every user-facing string an explainer renders, for the prohibited-word check. */
export function explainerText(explainer: BondExplainer): string {
  return [
    explainer.name,
    explainer.issuerName,
    explainer.whatItIs,
    explainer.whoIssuesIt,
    explainer.howThePriceWorks,
    explainer.veilsRole,
    explainer.description ?? '',
  ].join(' ')
}

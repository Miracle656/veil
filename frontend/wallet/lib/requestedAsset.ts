/**
 * Decide which asset an inbound payment request (#791) is asking for.
 *
 * A request names an asset by code *and* issuer. The code on its own proves
 * nothing: mainnet has eight different assets called USDT0, and seven of them
 * are worthless impostors, each with its own stellar.toml vouching for itself.
 * So a request is resolved only when the exact `code:issuer` pair is one Veil
 * recognises, and refused, with the reason in words, whenever it is not. It is
 * never resolved by guessing the issuer from the code.
 *
 * Recognised means: listed in the verified registry (`lib/assets.ts`) for the
 * active network, or — for a code the registry does not know at all — an asset
 * the wallet already holds a trustline to. A code the registry *does* know is
 * held to the registry: holding an impostor's trustline does not launder it.
 */

import { StrKey } from '@stellar/stellar-sdk'
import { ASSET_REGISTRY, getRegisteredAsset, isRegisteredIssuer } from './assets'
import { parseScannedValue, Sep7Error, type PrefilledSend } from './paymentRequest'

export type NetworkName = 'mainnet' | 'testnet'

/** An issued asset, identified the only way that is unambiguous. */
export type IssuedAsset = { code: string; issuer: string }

export type RequestedAsset =
  /** `asset: null` is native XLM. */
  | { ok: true; asset: IssuedAsset | null }
  | { ok: false; reason: string }

function refuse(reason: string): RequestedAsset {
  return { ok: false, reason }
}

/**
 * Resolve the asset half of a payment request.
 *
 * @param held assets the wallet already holds, used only for codes the registry
 *   does not list.
 */
export function resolveRequestedAsset(
  assetCode: string | undefined,
  assetIssuer: string | undefined,
  network: NetworkName,
  held: ReadonlyArray<{ code: string; issuer: string | null }> = [],
): RequestedAsset {
  if (!assetCode) {
    if (assetIssuer) {
      return refuse(`This request names an issuer (${assetIssuer}) but no asset, so it cannot be paid.`)
    }
    return { ok: true, asset: null }
  }

  if (!assetIssuer) {
    // Same rule as the SEP-7 parser: a bare `xlm` code with no issuer is native.
    if (assetCode.toUpperCase() === 'XLM') return { ok: true, asset: null }
    return refuse(
      `This request asks for ${assetCode} but does not say who issued it. ` +
      `More than one asset is called ${assetCode}, so Veil will not guess which one is meant.`,
    )
  }

  if (!StrKey.isValidEd25519PublicKey(assetIssuer)) {
    return refuse(`This request's issuer (${assetIssuer}) is not a valid Stellar account.`)
  }

  // Real XLM has no issuer. An "XLM" that names one is someone else's token.
  if (assetCode.toUpperCase() === 'XLM') {
    return refuse(`This request asks for an asset called XLM issued by ${assetIssuer}. That is not Stellar's XLM.`)
  }

  const registered = ASSET_REGISTRY[assetCode.toUpperCase()]
  if (registered) {
    // Asset codes are case-sensitive on Stellar: `usdt0` is a different asset.
    if (assetCode !== registered.code) {
      return refuse(`This request asks for "${assetCode}", which is not ${registered.code}. Asset codes are case-sensitive.`)
    }
    if (!isRegisteredIssuer(assetCode, assetIssuer, network)) {
      if (!getRegisteredAsset(assetCode, network) && assetCode !== 'USDC') {
        return refuse(`${assetCode} is not available on ${network}.`)
      }
      return refuse(
        `Unregistered issuer ${assetIssuer} for ${assetCode}. ` +
        `This is not the ${registered.issuerName} asset — it only shares its name.`,
      )
    }
    return { ok: true, asset: { code: assetCode, issuer: assetIssuer } }
  }

  if (held.some((h) => h.code === assetCode && h.issuer === assetIssuer)) {
    return { ok: true, asset: { code: assetCode, issuer: assetIssuer } }
  }
  return refuse(
    `Unregistered issuer ${assetIssuer} for ${assetCode}. ` +
    `Veil does not recognise this asset and your wallet does not hold it.`,
  )
}

/** The raw `asset_code` / `asset_issuer` of a SEP-7 URI, or null if it is not one. */
function rawAssetParams(value: string): { code?: string; issuer?: string } | null {
  const v = value.trim()
  if (!v.toLowerCase().startsWith('web+stellar:')) return null
  const q = v.indexOf('?')
  if (q === -1) return null
  const params = new URLSearchParams(v.slice(q + 1).split('#')[0])
  return {
    code: params.get('asset_code')?.trim() || undefined,
    issuer: params.get('asset_issuer')?.trim() || undefined,
  }
}

export type ReadPaymentRequest =
  | { ok: true; prefill: PrefilledSend; asset: IssuedAsset | null }
  | { ok: false; reason: string }

/**
 * Parse an untrusted scanned value or link (bare address or SEP-7 URI) and
 * resolve its asset. Malformed input is refused with the parser's explanation.
 */
export function readPaymentRequest(
  value: string,
  network: NetworkName,
  held: ReadonlyArray<{ code: string; issuer: string | null }> = [],
): ReadPaymentRequest {
  // Check the asset before the full parse, so a link that is wrong only about
  // its asset is refused with that reason rather than the parser's terser one.
  const raw = rawAssetParams(value)
  if (raw) {
    const early = resolveRequestedAsset(raw.code, raw.issuer, network, held)
    if (!early.ok) return early
  }

  let prefill: PrefilledSend
  try {
    prefill = parseScannedValue(value)
  } catch (err) {
    if (err instanceof Sep7Error) return { ok: false, reason: `This payment request is invalid: ${err.message}.` }
    throw err
  }
  const resolved = resolveRequestedAsset(prefill.assetCode, prefill.assetIssuer, network, held)
  if (!resolved.ok) return resolved
  return { ok: true, prefill, asset: resolved.asset }
}

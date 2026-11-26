/**
 * Decide which asset an inbound payment request (#791) is asking for — the
 * mobile counterpart of `frontend/wallet/lib/requestedAsset.ts`, with the same
 * rules.
 *
 * A request names an asset by code *and* issuer. The code alone proves
 * nothing: mainnet has eight assets called USDT0 and seven are impostors. So
 * a request resolves only to an exact `code:issuer` Veil recognises — listed
 * in the verified registry for the active network, or, for a code the registry
 * does not know at all, an asset the wallet already holds — and is otherwise
 * refused with the reason in words. It is never resolved by guessing.
 */

import { StrKey } from '@stellar/stellar-sdk';
import { ASSET_REGISTRY, getRegisteredAsset, isRegisteredIssuer } from './assets';

export type IssuedAsset = { code: string; issuer: string };

export type RequestedAsset =
  /** `asset: null` is native XLM. */
  | { ok: true; asset: IssuedAsset | null }
  | { ok: false; reason: string };

function refuse(reason: string): RequestedAsset {
  return { ok: false, reason };
}

export function resolveRequestedAsset(
  assetCode: string | undefined,
  assetIssuer: string | undefined,
  network: 'mainnet' | 'testnet',
  held: ReadonlyArray<{ code: string; issuer: string | null }> = [],
): RequestedAsset {
  if (!assetCode) {
    if (assetIssuer) {
      return refuse(`This request names an issuer (${assetIssuer}) but no asset, so it cannot be paid.`);
    }
    return { ok: true, asset: null };
  }

  if (!assetIssuer) {
    // Same rule as SEP-7: a bare `xlm` code with no issuer is native.
    if (assetCode.toUpperCase() === 'XLM') return { ok: true, asset: null };
    return refuse(
      `This request asks for ${assetCode} but does not say who issued it. ` +
        `More than one asset is called ${assetCode}, so Veil will not guess which one is meant.`,
    );
  }

  if (!StrKey.isValidEd25519PublicKey(assetIssuer)) {
    return refuse(`This request's issuer (${assetIssuer}) is not a valid Stellar account.`);
  }

  // Real XLM has no issuer. An "XLM" that names one is someone else's token.
  if (assetCode.toUpperCase() === 'XLM') {
    return refuse(`This request asks for an asset called XLM issued by ${assetIssuer}. That is not Stellar's XLM.`);
  }

  const registered = ASSET_REGISTRY[assetCode.toUpperCase()];
  if (registered) {
    // Asset codes are case-sensitive on Stellar: `usdt0` is a different asset.
    if (assetCode !== registered.code) {
      return refuse(`This request asks for "${assetCode}", which is not ${registered.code}. Asset codes are case-sensitive.`);
    }
    if (!isRegisteredIssuer(assetCode, assetIssuer, network)) {
      if (!getRegisteredAsset(assetCode, network) && assetCode !== 'USDC') {
        return refuse(`${assetCode} is not available on ${network}.`);
      }
      return refuse(
        `Unregistered issuer ${assetIssuer} for ${assetCode}. ` +
          `This is not the ${registered.issuerName} asset — it only shares its name.`,
      );
    }
    return { ok: true, asset: { code: assetCode, issuer: assetIssuer } };
  }

  if (held.some((h) => h.code === assetCode && h.issuer === assetIssuer)) {
    return { ok: true, asset: { code: assetCode, issuer: assetIssuer } };
  }
  return refuse(
    `Unregistered issuer ${assetIssuer} for ${assetCode}. ` +
      `Veil does not recognise this asset and your wallet does not hold it.`,
  );
}

/** True when the registry alone decides `code` — holdings cannot change the answer. */
export function isRegistryCode(assetCode: string): boolean {
  return assetCode.toUpperCase() in ASSET_REGISTRY;
}

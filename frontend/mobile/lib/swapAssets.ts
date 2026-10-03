/**
 * Mobile port of `frontend/wallet/lib/swapAssets.ts` — same rules, same
 * names; keep the two in step.
 *
 * Which assets a swap may trade, and how each is addressed on every venue
 * (#793).
 *
 * A swap asset is a code AND an issuer. Mainnet has eight assets called USDT0
 * and seven are impostors, so nothing here ever resolves an asset by its code:
 *   - the receive side offers only registered assets, issuer from the registry;
 *   - the pay side refuses a held asset that shares a registered code but not
 *     its registered issuer;
 *   - Soroswap is addressed by the SAC derived from code:issuer — never a
 *     token-list lookup by symbol — and a quote whose route does not start and
 *     end at those contracts is refused;
 *   - the classic DEX is addressed by `new Asset(code, issuer)`, and a path
 *     that pays out anything else is refused.
 */

import { Asset, StrKey } from '@stellar/stellar-sdk';
import { ASSET_REGISTRY, getAssetIssuer, isRegisteredIssuer, type RegisteredAsset } from './assets';

export type NetworkName = 'mainnet' | 'testnet';

/** A tradeable asset. `issuer: null` is native XLM, and only XLM. */
export interface SwapAsset {
  code: string;
  issuer: string | null;
}

/**
 * Issued assets the receive side offers, when registered on the network.
 *
 * USDY is Ondo's yield-bearing dollar (#732). Its issuer comes from
 * `ASSET_REGISTRY` like every other code here — it is registered mainnet-only,
 * so `swapDestinations` drops it on testnet, where the issuer account does not
 * exist and a trustline would fail with op_no_issuer.
 */
export const SWAP_DEST_CODES = ['USDC', 'USDT0', 'USDY'] as const;

export const NATIVE: SwapAsset = { code: 'XLM', issuer: null };

export function swapAssetKey(a: SwapAsset): string {
  return a.issuer ? `${a.code}:${a.issuer}` : 'native';
}

export function sameSwapAsset(a: SwapAsset, b: SwapAsset): boolean {
  return swapAssetKey(a) === swapAssetKey(b);
}

function shortIssuer(issuer: string): string {
  return `${issuer.slice(0, 4)}…${issuer.slice(-4)}`;
}

/** The receive-side options: XLM, then each registered asset live on `network`. */
export function swapDestinations(network: NetworkName): SwapAsset[] {
  const out: SwapAsset[] = [NATIVE];
  for (const code of SWAP_DEST_CODES) {
    const issuer = getAssetIssuer(code, network);
    if (issuer) out.push({ code, issuer });
  }
  return out;
}

export type SwapAssetCheck =
  | { ok: true; asset: SwapAsset; registered: RegisteredAsset | null }
  | { ok: false; reason: string };

/**
 * Whether `a` may be traded. A code the registry knows must carry its
 * registered issuer; any other held asset is tradeable as itself, and is
 * labelled unverified wherever it is shown.
 */
export function checkSwapAsset(a: SwapAsset, network: NetworkName): SwapAssetCheck {
  if (!a.issuer) {
    return a.code === 'XLM'
      ? { ok: true, asset: NATIVE, registered: null }
      : { ok: false, reason: `${a.code} has no issuer, so it cannot be identified.` };
  }
  if (!StrKey.isValidEd25519PublicKey(a.issuer)) {
    return {
      ok: false,
      reason: `${a.code}'s issuer (${a.issuer}) is not a valid Stellar account.`,
    };
  }
  if (a.code.toUpperCase() === 'XLM') {
    return { ok: false, reason: `An asset called XLM issued by ${a.issuer} is not Stellar's XLM.` };
  }
  const registered = ASSET_REGISTRY[a.code.toUpperCase()];
  if (registered) {
    if (a.code === registered.code && !getAssetIssuer(a.code, network)) {
      return { ok: false, reason: `${a.code} is not available on ${network}.` };
    }
    if (a.code === registered.code && isRegisteredIssuer(a.code, a.issuer, network)) {
      return { ok: true, asset: a, registered };
    }
    return {
      ok: false,
      reason:
        `Unregistered issuer ${a.issuer} for ${a.code}. This is not the ${registered.issuerName} asset — ` +
        `it only shares its name — so it cannot be swapped here.`,
    };
  }
  return { ok: true, asset: a, registered: null };
}

/** How a swap asset is named on screen: the issuer is always part of it. */
export function swapAssetLabel(a: SwapAsset, network: NetworkName): string {
  if (!a.issuer) return 'XLM';
  const check = checkSwapAsset(a, network);
  if (check.ok && check.registered)
    return `${a.code} · ${check.registered.issuerName} (${shortIssuer(a.issuer)})`;
  return `${a.code} · unverified (${shortIssuer(a.issuer)})`;
}

/** The classic-DEX form of a swap asset. */
export function classicAsset(a: SwapAsset): Asset {
  return a.issuer ? new Asset(a.code, a.issuer) : Asset.native();
}

/** The Soroban token (SAC) of a swap asset — derived from code:issuer, never looked up. */
export function sorobanTokenId(a: SwapAsset, networkPassphrase: string): string {
  return classicAsset(a).contractId(networkPassphrase);
}

export type SwapRouteInput =
  | { ok: true; from: SwapAsset; to: SwapAsset; tokenIn: string; tokenOut: string }
  | { ok: false; reason: string };

/**
 * Everything a quote is requested with, or why the pair cannot be quoted.
 * Both assets are checked, and a registered asset's derived SAC must equal the
 * one the registry records — a mismatch means the registry or the SDK is
 * wrong, and neither is a reason to guess.
 */
export function swapRouteInput(
  from: SwapAsset,
  to: SwapAsset,
  network: NetworkName,
  networkPassphrase: string
): SwapRouteInput {
  const checks = [checkSwapAsset(from, network), checkSwapAsset(to, network)];
  for (const c of checks) if (!c.ok) return c;
  if (sameSwapAsset(from, to)) return { ok: false, reason: 'Pay and receive are the same asset.' };

  const tokens: string[] = [];
  for (const c of checks) {
    if (!c.ok) continue;
    const token = sorobanTokenId(c.asset, networkPassphrase);
    if (
      network === 'mainnet' &&
      c.registered?.sacContractId &&
      c.registered.sacContractId !== token
    ) {
      return {
        ok: false,
        reason: `${c.asset.code}'s contract derived from its issuer (${token}) does not match the registered one.`,
      };
    }
    tokens.push(token);
  }
  return { ok: true, from, to, tokenIn: tokens[0]!, tokenOut: tokens[1]! };
}

/** The parts of a Soroswap quote that say which assets it trades. */
export interface QuoteAssets {
  assetIn: string;
  assetOut: string;
  routePlan?: Array<{ swapInfo: { path: string[] } }>;
}

/**
 * Why a router quote does not trade the pair that was asked for, or null when
 * it does: the quote's own assets, and every leg of its route, must start at
 * `tokenIn` and end at `tokenOut`.
 */
export function quoteMismatch(
  quote: QuoteAssets,
  tokenIn: string,
  tokenOut: string
): string | null {
  if (quote.assetIn !== tokenIn || quote.assetOut !== tokenOut) {
    return 'The router quoted a different asset pair than the one requested, so the quote was discarded.';
  }
  for (const leg of quote.routePlan ?? []) {
    const path = leg.swapInfo.path;
    if (path.length > 0 && (path[0] !== tokenIn || path[path.length - 1] !== tokenOut)) {
      return "A leg of the router's route starts or ends at a different asset, so the quote was discarded.";
    }
  }
  return null;
}

/** A Horizon strict-send path record, as far as it names its assets. */
export interface PathRecordAssets {
  destination_asset_type: string;
  destination_asset_code?: string;
  destination_asset_issuer?: string;
}

/** Whether a classic-DEX path pays out exactly `to`. */
export function pathPaysOut(record: PathRecordAssets, to: SwapAsset): boolean {
  if (!to.issuer) return record.destination_asset_type === 'native';
  return record.destination_asset_code === to.code && record.destination_asset_issuer === to.issuer;
}

/** "No route from … to …", naming both issuers, for an unroutable pair. */
export function noRouteMessage(from: SwapAsset, to: SwapAsset, network: NetworkName): string {
  return (
    `No route from ${swapAssetLabel(from, network)} to ${swapAssetLabel(to, network)}. ` +
    'Try a different amount or asset — Veil will not substitute another asset.'
  );
}

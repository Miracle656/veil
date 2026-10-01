/**
 * Verified asset registry (V176) mapping short token keys to exact issuer
 * addresses and metadata.
 *
 * A code alone is not an asset: mainnet has eight assets called USDT0 and seven
 * are impostors. Anything that names, badges, prices or classifies an asset
 * must go through `verifiedAsset`, which checks the issuer, not just the code.
 */

/**
 * Portfolio (held-asset) helpers for the mobile wallet — the native counterpart
 * of the web wallet's assets view (`frontend/wallet/app/assets/page.tsx`) and
 * its `parseTrustlines` (`frontend/wallet/lib/trustlines.ts`).
 *
 * The screen only needs to *read* the portfolio, so this stays deliberately
 * smaller than the web module: the pure `parseHeldAssets` extracts every
 * non-native asset the account holds from a set of Horizon balances, and
 * `fetchHeldAssets` loads those balances over Horizon. No trustline writes, no
 * signing — that surface belongs to a later item.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Horizon } from '@stellar/stellar-sdk';

import { getNetwork } from './network';

/** AsyncStorage key holding the active wallet's public key (shared with backupFile). */
export const WALLET_PUBLIC_KEY_KEY = 'invisible_wallet_public_key';

/** Subset of a Horizon balance entry we depend on. */
export interface HorizonBalanceLike {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

/** Verified asset metadata structure. */
export interface RegisteredAsset {
  code: string;
  issuer: string;
  name: string;
  issuerName: string;
  homeDomain?: string;
  network: 'mainnet' | 'testnet' | 'all';
  kind: 'treasury' | 'fund' | 'equity' | 'stablecoin' | 'native';
  reserveXlm?: number;
  sacContractId?: string;
}

export const USDY_MAINNET_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6';
export const USDT0_MAINNET_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q';
export const USDT0_MAINNET_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF';

export const ASSET_REGISTRY: Record<string, RegisteredAsset> = {
  USDY: {
    code: 'USDY',
    issuer: USDY_MAINNET_ISSUER,
    name: 'Ondo US Dollar Yield',
    issuerName: 'Ondo Finance',
    homeDomain: 'ondo.finance',
    // Mainnet only: this issuer account does not exist on testnet, so a
    // changeTrust there fails with op_no_issuer.
    network: 'mainnet',
    kind: 'treasury',
    reserveXlm: 0.5,
  },
  USDC: {
    code: 'USDC',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    name: 'USD Coin',
    issuerName: 'Circle',
    homeDomain: 'circle.com',
    network: 'mainnet',
    kind: 'stablecoin',
    reserveXlm: 0.5,
  },
  USDT0: {
    code: 'USDT0',
    issuer: USDT0_MAINNET_ISSUER,
    name: 'Tether USD',
    issuerName: 'Tether',
    network: 'mainnet',
    kind: 'stablecoin',
    reserveXlm: 0.5,
    sacContractId: USDT0_MAINNET_SAC,
  },
};

export function getRegisteredAsset(code: string, network?: 'mainnet' | 'testnet'): RegisteredAsset | null {
  const asset = ASSET_REGISTRY[code.toUpperCase()] ?? null;
  if (!asset) return null;
  if (network && asset.network !== 'all' && asset.network !== network) {
    return null;
  }
  return asset;
}

export function getAssetIssuer(code: string, network: 'mainnet' | 'testnet' = 'mainnet'): string | null {
  // USDC first: it is registered `network: 'mainnet'`, so a registry lookup
  // for testnet returns null and every branch below becomes unreachable.
  if (code.toUpperCase() === 'USDC' && network === 'testnet') {
    return 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  }
  const asset = getRegisteredAsset(code, network);
  if (!asset) return null;
  if (asset.network === 'mainnet' && network === 'testnet') {
    return null;
  }
  return asset.issuer;
}

/**
 * True when `issuer` is the registered issuer for `code` on `network`. The
 * USDC branch accepts both Circle's mainnet issuer and the SDF test anchor's,
 * matching how prices are quoted — same contract as the web wallet.
 */
export function isRegisteredIssuer(code: string, issuer: string, network: 'mainnet' | 'testnet' = 'mainnet'): boolean {
  // USDC first: it is registered `network: 'mainnet'`, so a registry lookup
  // for testnet returns null and every branch below becomes unreachable.
  if (code.toUpperCase() === 'USDC') {
    return (
      issuer === 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' ||
      issuer === 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    );
  }
  const asset = getRegisteredAsset(code, network);
  if (!asset) return false;
  if (asset.network === 'mainnet' && network === 'testnet') {
    return false;
  }
  return asset.issuer === issuer;
}

/**
 * Soroban SAC contract IDs for registry assets, per network. Keyed by the
 * *registered* code, so a contract ID resolved through this map always belongs
 * to a verified issuer — the whole point of the map. Mainnet values are the
 * canonical SACs (USDT0's also lives in the registry as `sacContractId`);
 * testnet's is the SDF anchor's USDC.
 */
export const KNOWN_SAC_CONTRACT_IDS: Record<'mainnet' | 'testnet', Record<string, string>> = {
  mainnet: {
    USDC: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    USDT0: USDT0_MAINNET_SAC,
  },
  testnet: {
    USDC: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  },
};

/**
 * The Soroban SAC contract ID for a registered asset's issuer, or null when the
 * code is not registered on that network or its SAC is not pinned here.
 * Resolved from constants only — no SDK import (the web counterpart of this
 * module must stay import-free for the parity harness); a new registry entry
 * needs its SAC added to `KNOWN_SAC_CONTRACT_IDS` (or a `sacContractId` on its
 * registry entry) rather than deriving one at runtime. Mirrors
 * `frontend/wallet/lib/assets.ts` — edit both together.
 */
export function sacContractIdForCode(code: string, network: 'mainnet' | 'testnet'): string | null {
  const asset = getRegisteredAsset(code, network);
  if (!asset) return null;
  if (asset.sacContractId && network === 'mainnet') return asset.sacContractId;
  return KNOWN_SAC_CONTRACT_IDS[network][asset.code] ?? null;
}

/**
 * The registry entry for an asset, but only when BOTH its code (exactly — codes
 * are case-sensitive) and its issuer are the registered ones. A code match on
 * its own is not an asset match: mainnet has eight assets called USDT0 and
 * seven are impostors, so anything that names or badges an asset goes through
 * here rather than looking the code up.
 */
export function verifiedAsset(
  code: string,
  issuer: string | null | undefined,
  network: 'mainnet' | 'testnet',
): RegisteredAsset | null {
  if (!issuer) return null;
  const registered = ASSET_REGISTRY[code.toUpperCase()];
  if (!registered || registered.code !== code) return null;
  return isRegisteredIssuer(code, issuer, network) ? registered : null;
}

/** A single non-native asset held by the wallet. */
export interface HeldAsset {
  code: string;
  issuer: string;
  balance: string;
  assetType: string;
  name?: string;
}

/**
 * Extracts the classic (non-native, non-pool-share) assets from a set of
 * Horizon balances — everything the wallet holds beyond XLM. Mirrors the web
 * wallet's `parseTrustlines` so both clients describe a portfolio the same way.
 */
export function parseHeldAssets(balances: HorizonBalanceLike[]): HeldAsset[] {
  return balances
    .filter(
      (b) => b.asset_type === 'credit_alphanum4' || b.asset_type === 'credit_alphanum12',
    )
    .filter((b) => b.asset_code && b.asset_issuer)
    .map((b) => ({
      code: b.asset_code as string,
      issuer: b.asset_issuer as string,
      balance: b.balance,
      assetType: b.asset_type,
    }));
}

/** Reads the active wallet's public key, or `null` when no wallet is stored. */
export async function loadWalletAddress(): Promise<string | null> {
  return AsyncStorage.getItem(WALLET_PUBLIC_KEY_KEY);
}

/** A Horizon 404 means the account isn't funded yet — an empty portfolio, not an error. */
function isAccountNotFound(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || (err instanceof Error && err.name === 'NotFoundError');
}

/**
 * Loads every non-native asset held by `publicKey` from Horizon. An unfunded
 * account (no ledger entry yet) is reported as an empty portfolio rather than
 * an error; any other failure propagates so the screen can surface it.
 */
export async function fetchHeldAssets(publicKey: string): Promise<HeldAsset[]> {
  // Read at call time from the ACTIVE network, not from a module constant: a
  // build-time default froze this to testnet Horizon, so on mainnet the
  // portfolio screen queried the wrong chain and showed an empty portfolio.
  // Each network's own env overrides still apply (see lib/network.ts).
  const server = new Horizon.Server(getNetwork().horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    return parseHeldAssets(account.balances as unknown as HorizonBalanceLike[]);
  } catch (err) {
    if (isAccountNotFound(err)) return [];
    throw err;
  }
}

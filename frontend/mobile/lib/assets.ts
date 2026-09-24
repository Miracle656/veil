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

/** AsyncStorage key holding the active wallet's public key (shared with backupFile). */
export const WALLET_PUBLIC_KEY_KEY = 'invisible_wallet_public_key';

const HORIZON_URL =
  process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() || 'https://horizon-testnet.stellar.org';

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
  homeDomain: string;
  network: 'mainnet' | 'testnet' | 'all';
  kind: 'treasury' | 'fund' | 'equity' | 'stablecoin' | 'native';
  reserveXlm?: number;
}

export const USDY_MAINNET_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6';

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
};

export function getRegisteredAsset(code: string): RegisteredAsset | null {
  return ASSET_REGISTRY[code.toUpperCase()] ?? null;
}

export function getAssetIssuer(code: string, network: 'mainnet' | 'testnet' = 'mainnet'): string | null {
  const asset = getRegisteredAsset(code);
  if (!asset) return null;
  if (code.toUpperCase() === 'USDC' && network === 'testnet') {
    return 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  }
  return asset.issuer;
}

export function isRegisteredIssuer(code: string, issuer: string): boolean {
  const asset = getRegisteredAsset(code);
  if (!asset) return false;
  if (code.toUpperCase() === 'USDC') {
    return (
      issuer === 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN' ||
      issuer === 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    );
  }
  return asset.issuer === issuer;
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
  const server = new Horizon.Server(HORIZON_URL);
  try {
    const account = await server.loadAccount(publicKey);
    return parseHeldAssets(account.balances as unknown as HorizonBalanceLike[]);
  } catch (err) {
    if (isAccountNotFound(err)) return [];
    throw err;
  }
}

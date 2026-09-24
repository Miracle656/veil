/**
 * Portfolio (held-asset) helpers and verified asset registry for the mobile wallet —
 * the native counterpart of the web wallet's assets view (`frontend/wallet/app/assets/page.tsx`).
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
export const USDC_MAINNET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const USDC_TESTNET_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
export const EURC_MAINNET_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';
export const AQUA_MAINNET_ISSUER = 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA';

export const ASSET_REGISTRY: Record<string, RegisteredAsset> = {
  USDC: {
    code: 'USDC',
    issuer: USDC_MAINNET_ISSUER,
    name: 'USD Coin',
    issuerName: 'Circle',
    homeDomain: 'circle.com',
    network: 'mainnet',
    kind: 'stablecoin',
    reserveXlm: 0.5,
  },
  XLM: {
    code: 'XLM',
    issuer: '',
    name: 'Stellar Lumens',
    issuerName: 'Stellar Development Foundation',
    homeDomain: 'stellar.org',
    network: 'mainnet',
    kind: 'native',
  },
  EURC: {
    code: 'EURC',
    issuer: EURC_MAINNET_ISSUER,
    name: 'EUR Coin',
    issuerName: 'Circle',
    homeDomain: 'circle.com',
    network: 'mainnet',
    kind: 'stablecoin',
    reserveXlm: 0.5,
  },
  AQUA: {
    code: 'AQUA',
    issuer: AQUA_MAINNET_ISSUER,
    name: 'Aquarius',
    issuerName: 'Aquarius',
    homeDomain: 'aqua.network',
    network: 'mainnet',
    kind: 'equity',
    reserveXlm: 0.5,
  },
  USDY: {
    code: 'USDY',
    issuer: USDY_MAINNET_ISSUER,
    name: 'Ondo US Dollar Yield',
    issuerName: 'Ondo Finance',
    homeDomain: 'ondo.finance',
    network: 'mainnet',
    kind: 'treasury',
    reserveXlm: 0.5,
  },
};

export function getRegisteredAsset(code: string, issuer?: string | null): RegisteredAsset | null {
  const upperCode = code.toUpperCase();
  const asset = ASSET_REGISTRY[upperCode];
  if (!asset) return null;

  if (issuer === undefined) return asset;

  if (upperCode === 'XLM' || asset.kind === 'native') {
    if (!issuer || issuer === '' || issuer === 'native') return asset;
    return null;
  }

  if (upperCode === 'USDC' && issuer === USDC_TESTNET_ISSUER) {
    return asset;
  }

  return asset.issuer === issuer ? asset : null;
}

export function getAssetIssuer(code: string, network: 'mainnet' | 'testnet' = 'mainnet'): string | null {
  const asset = getRegisteredAsset(code);
  if (!asset) return null;
  if (code.toUpperCase() === 'USDC' && network === 'testnet') {
    return USDC_TESTNET_ISSUER;
  }
  return asset.issuer;
}

export function isRegisteredIssuer(code: string, issuer: string): boolean {
  return getRegisteredAsset(code, issuer) !== null;
}

export function formatAssetLabel(code: string, issuer?: string | null): string {
  const asset = getRegisteredAsset(code, issuer);
  if (asset) return asset.code;

  const shortIssuer = issuer ? `${issuer.slice(0, 4)}…` : 'unknown';
  return `Unverified: ${code.toUpperCase()} (issuer ${shortIssuer})`;
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
 * Horizon balances — everything the wallet holds beyond XLM.
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
 * Loads every non-native asset held by `publicKey` from Horizon.
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

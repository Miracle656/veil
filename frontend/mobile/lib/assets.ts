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
import { Horizon, StrKey } from '@stellar/stellar-sdk';

import { getNetwork } from './network';
import { getFeePayerAddress } from './activity';

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
  kind: 'treasury' | 'fund' | 'equity' | 'stablecoin' | 'governance' | 'native';
  reserveXlm?: number;
  sacContractId?: string;
}

export const USDY_MAINNET_ISSUER = 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6';
export const USDT0_MAINNET_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q';
export const USDT0_MAINNET_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF';

export const EURC_MAINNET_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';
export const AQUA_MAINNET_ISSUER = 'GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA';

export const ASSET_REGISTRY: Record<string, RegisteredAsset> = {
  EURC: {
    code: 'EURC',
    issuer: EURC_MAINNET_ISSUER,
    name: 'Euro Coin',
    issuerName: 'Circle',
    homeDomain: 'circle.com',
    // Verified 2026-10-04: this issuer's Horizon home_domain is circle.com, the
    // same domain the USDC issuer publishes. Circle serves no stellar.toml at
    // that path (404), so the registry pin is the verification, exactly as it
    // is for USDC.
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
    // Verified 2026-10-04 in both directions: the issuer publishes
    // home_domain aqua.network, and that domain's stellar.toml declares AQUA
    // against this exact issuer. The only registry asset that currently
    // verifies both ways.
    //
    // Not a stablecoin — AQUA floats. `fetchPrice` quotes it off the real
    // AQUA/USDC order book like any other issued asset, so nothing here needs
    // a hardcoded rate, and it must never get one.
    network: 'mainnet',
    kind: 'governance',
    reserveXlm: 0.5,
  },
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
    USDC: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
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
/**
 * The issuer controls Horizon reports for an asset's issuing account.
 *
 * These are set on the ISSUER, not on the holder, so they are a property of the
 * asset and the same for everyone who holds it.
 */
export interface HorizonIssuerFlags {
  auth_required?: boolean;
  auth_revocable?: boolean;
  auth_clawback_enabled?: boolean;
  auth_immutable?: boolean;
}

/**
 * What the issuer can do to a balance of this asset, in a sentence, or null
 * when it can do neither.
 *
 * Ported from the web wallet's `getAssetControlDisclosure` so the two cannot
 * drift into saying different things about the same asset. It matters most for
 * USDT0: its issuer has both flags set, and until now the only place mobile
 * said so was a hardcoded line inside the "enable USDT0" banner — which a
 * holder never sees again after they tap it once.
 *
 * The wording puts the fact where it belongs. This is the asset behaving as the
 * asset was designed to, not Veil holding anything back.
 */
export function getAssetControlDisclosure(flags?: HorizonIssuerFlags | null): string | null {
  if (!flags) return null;
  if (flags.auth_revocable && flags.auth_clawback_enabled) {
    return 'The issuer can freeze this balance or take it back, and this is a property of the asset, not of Veil.';
  }
  if (flags.auth_clawback_enabled) {
    return 'The issuer can take this balance back, and this is a property of the asset, not of Veil.';
  }
  if (flags.auth_revocable) {
    return 'The issuer can freeze this balance, and this is a property of the asset, not of Veil.';
  }
  return null;
}

/**
 * The issuing account's flags, or null when Horizon cannot answer.
 *
 * Null means "unknown", and callers show nothing rather than implying the
 * issuer is powerless — the web wallet had a bug of exactly that shape, where a
 * Horizon failure silently dropped the disclosure.
 */
export async function fetchIssuerFlags(issuer: string): Promise<HorizonIssuerFlags | null> {
  if (!issuer) return null;
  try {
    const account = await new Horizon.Server(getNetwork().horizonUrl).loadAccount(issuer);
    return (account.flags as HorizonIssuerFlags) ?? null;
  } catch {
    return null;
  }
}

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
  // A smart wallet's address is a CONTRACT, and Horizon cannot load one — it
  // only knows classic accounts. Asking it about a C-address fails on every
  // attempt, which is why this screen showed the bare word "Unknown" on exactly
  // the wallets it was built for, and kept failing after the retry landed.
  //
  // Trustlines are a property of the classic account regardless: a contract
  // holds issued assets as SAC contract storage and needs no trustline at all.
  // So the account to read is the fee payer, which is what `loadHoldings` has
  // been resolving on the dashboard all along.
  let effective = publicKey;
  if (StrKey.isValidContract(publicKey)) {
    const feePayer = await getFeePayerAddress();
    // No fee payer stored means no classic account exists for this wallet yet,
    // so there are no trustlines to report — empty, not broken.
    if (!feePayer) return [];
    effective = feePayer;
  }

  const server = new Horizon.Server(getNetwork().horizonUrl);

  // Retry once, and say what failed.
  //
  // Android drops one of the several Horizon calls the app fires on mount with
  // a bare error whose only readable field is `name: "Unknown"` — so the
  // trustlines screen rendered the word "Unknown" and nothing else, which told
  // the user and us precisely nothing. `loadHoldings` has retried around this
  // for a while; this path never did.
  let last: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const account = await server.loadAccount(effective);
      return parseHeldAssets(account.balances as unknown as HorizonBalanceLike[]);
    } catch (err) {
      // Definitive, not a transport failure: the account simply is not funded.
      if (isAccountNotFound(err)) return [];
      last = err;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.warn(
    '[assets] loadAccount failed twice:',
    last instanceof Error ? `${last.name}: ${last.message}` : last,
  );
  throw new Error('Could not reach the network to read your assets.');
}

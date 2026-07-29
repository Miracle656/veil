/**
 * Per-token detail data for the mobile wallet — the native counterpart of the
 * web wallet's token route (`frontend/wallet/app/token/[code]/page.tsx`): a
 * single asset's balance and its own transaction history.
 *
 * The route id identifies the asset — `XLM` for native, `CODE:ISSUER` for a
 * classic asset. `parseAssetId` and `filterTokenActivity` are pure so the
 * screen's logic is testable without Horizon; `fetchTokenDetail` wires them to
 * the network.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Horizon } from '@stellar/stellar-sdk';

/** AsyncStorage key holding the active wallet's public key (shared with backupFile). */
export const WALLET_PUBLIC_KEY_KEY = 'invisible_wallet_public_key';

const HORIZON_URL =
  process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() || 'https://horizon-testnet.stellar.org';

/** Reads the active wallet's public key, or `null` when no wallet is stored. */
export async function loadWalletAddress(): Promise<string | null> {
  return AsyncStorage.getItem(WALLET_PUBLIC_KEY_KEY);
}

export interface AssetId {
  code: string;
  /** `null` for native XLM. */
  issuer: string | null;
}

/** Parses a route id (`XLM` or `CODE:ISSUER`) into a code + optional issuer. */
export function parseAssetId(id: string): AssetId {
  const decoded = decodeURIComponent(id);
  const sep = decoded.indexOf(':');
  if (decoded === 'XLM' || sep === -1) return { code: decoded, issuer: null };
  return { code: decoded.slice(0, sep), issuer: decoded.slice(sep + 1) };
}

/** Subset of a Horizon `payment` / `create_account` record we depend on. */
export interface HorizonPaymentLike {
  id: string;
  type: string;
  transaction_hash: string;
  created_at: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  account?: string;
  funder?: string;
  starting_balance?: string;
}

export interface TokenActivity {
  id: string;
  direction: 'sent' | 'received';
  amount: string;
  counterparty: string;
  /** Unix seconds. */
  timestamp: number;
  hash: string;
}

export interface TokenDetail {
  code: string;
  issuer: string | null;
  /** Held balance as a decimal string; '0' when unheld or unfunded. */
  balance: string;
  activity: TokenActivity[];
}

function seconds(createdAt: string): number {
  return Math.floor(new Date(createdAt).getTime() / 1000);
}

/**
 * Keeps only the payments involving `code`/`issuer` and maps them to
 * direction-aware rows for `account`. Native XLM additionally includes the
 * account-funding operation.
 */
export function filterTokenActivity(
  records: HorizonPaymentLike[],
  account: string,
  code: string,
  issuer: string | null,
): TokenActivity[] {
  const out: TokenActivity[] = [];

  for (const op of records) {
    if (op.type === 'create_account' && code === 'XLM') {
      const received = op.account === account;
      out.push({
        id: op.id,
        direction: received ? 'received' : 'sent',
        amount: op.starting_balance ?? '0',
        counterparty: (received ? op.funder : op.account) ?? 'unknown',
        timestamp: seconds(op.created_at),
        hash: op.transaction_hash,
      });
      continue;
    }

    if (op.type === 'payment') {
      const opCode = op.asset_type === 'native' ? 'XLM' : op.asset_code ?? '';
      const matchesCode = opCode === code;
      const matchesIssuer = code === 'XLM' || !issuer || op.asset_issuer === issuer;
      if (!matchesCode || !matchesIssuer) continue;

      const received = op.to === account;
      out.push({
        id: op.id,
        direction: received ? 'received' : 'sent',
        amount: op.amount ?? '0',
        counterparty: (received ? op.from : op.to) ?? 'unknown',
        timestamp: seconds(op.created_at),
        hash: op.transaction_hash,
      });
    }
  }

  return out;
}

/** A Horizon 404 means the account isn't funded yet — empty detail, not an error. */
function isAccountNotFound(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || (err instanceof Error && err.name === 'NotFoundError');
}

/**
 * Loads the balance and per-asset history for `code`/`issuer` held by
 * `publicKey`. An unfunded account reads as a zero balance with no activity.
 */
export async function fetchTokenDetail(
  publicKey: string,
  code: string,
  issuer: string | null,
): Promise<TokenDetail> {
  const server = new Horizon.Server(HORIZON_URL);
  try {
    const [account, payments] = await Promise.all([
      server.loadAccount(publicKey),
      server.payments().forAccount(publicKey).limit(50).order('desc').call(),
    ]);

    const balances = account.balances as Array<{
      asset_type: string;
      asset_code?: string;
      asset_issuer?: string;
      balance: string;
    }>;
    const held =
      code === 'XLM'
        ? balances.find((b) => b.asset_type === 'native')
        : balances.find(
            (b) => b.asset_code === code && (!issuer || b.asset_issuer === issuer),
          );

    return {
      code,
      issuer,
      balance: held?.balance ?? '0',
      activity: filterTokenActivity(
        payments.records as unknown as HorizonPaymentLike[],
        publicKey,
        code,
        issuer,
      ),
    };
  } catch (err) {
    if (isAccountNotFound(err)) return { code, issuer, balance: '0', activity: [] };
    throw err;
  }
}

/**
 * Dashboard data for the mobile wallet — the native counterpart of the balance
 * and activity feed the web dashboard polls (`frontend/wallet/app/dashboard/page.tsx`).
 *
 * The web dashboard reads the contract SAC balance over Soroban RPC and merges
 * a Wraith transfer feed; on mobile we keep it to what Horizon can answer
 * directly for the stored account: its native XLM balance and its recent
 * payments. `mapPayments` is the pure core that turns Horizon payment records
 * into the rows the feed renders, so it can be tested without the network.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Horizon } from '@stellar/stellar-sdk';

/** AsyncStorage key holding the active wallet's public key (shared with backupFile). */
export const WALLET_PUBLIC_KEY_KEY = 'invisible_wallet_public_key';

/** How often the dashboard silently re-fetches balance + activity. */
export const POLL_INTERVAL_MS = 15_000;

const HORIZON_URL =
  process.env['EXPO_PUBLIC_HORIZON_URL']?.trim() || 'https://horizon-testnet.stellar.org';

/** Subset of a Horizon `payment` / `create_account` record we depend on. */
export interface HorizonPaymentLike {
  id: string;
  type: string;
  transaction_hash: string;
  created_at: string;
  // payment
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  // create_account
  account?: string;
  funder?: string;
  starting_balance?: string;
}

export interface ActivityRecord {
  id: string;
  direction: 'sent' | 'received';
  amount: string;
  asset: string;
  counterparty: string;
  /** Unix seconds. */
  timestamp: number;
  hash: string;
}

export interface DashboardData {
  /** Native XLM balance as a decimal string; '0' when the account isn't funded. */
  xlmBalance: string;
  activity: ActivityRecord[];
}

function toRecord(op: HorizonPaymentLike, account: string): ActivityRecord | null {
  const timestamp = Math.floor(new Date(op.created_at).getTime() / 1000);

  if (op.type === 'payment') {
    const received = op.to === account;
    return {
      id: op.id,
      direction: received ? 'received' : 'sent',
      amount: op.amount ?? '0',
      asset: op.asset_type === 'native' ? 'XLM' : op.asset_code ?? 'XLM',
      counterparty: (received ? op.from : op.to) ?? 'unknown',
      timestamp,
      hash: op.transaction_hash,
    };
  }

  if (op.type === 'create_account') {
    const received = op.account === account;
    return {
      id: op.id,
      direction: received ? 'received' : 'sent',
      amount: op.starting_balance ?? '0',
      asset: 'XLM',
      counterparty: (received ? op.funder : op.account) ?? 'unknown',
      timestamp,
      hash: op.transaction_hash,
    };
  }

  // Other operation types (trustlines, swaps, …) aren't payments — skip them.
  return null;
}

/**
 * Turns a page of Horizon payment records into activity rows for `account`,
 * dropping anything that isn't a value transfer.
 */
export function mapPayments(records: HorizonPaymentLike[], account: string): ActivityRecord[] {
  return records
    .map((r) => toRecord(r, account))
    .filter((r): r is ActivityRecord => r !== null);
}

/** Reads the active wallet's public key, or `null` when no wallet is stored. */
export async function loadWalletAddress(): Promise<string | null> {
  return AsyncStorage.getItem(WALLET_PUBLIC_KEY_KEY);
}

/** A Horizon 404 means the account isn't funded yet — empty dashboard, not an error. */
function isAccountNotFound(err: unknown): boolean {
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status === 404 || (err instanceof Error && err.name === 'NotFoundError');
}

/**
 * Loads the account's native XLM balance and recent activity from Horizon. An
 * unfunded account is reported as a zero balance with no activity rather than
 * an error; any other failure propagates so the screen can surface it.
 */
export async function fetchDashboardData(publicKey: string): Promise<DashboardData> {
  const server = new Horizon.Server(HORIZON_URL);
  try {
    const [account, payments] = await Promise.all([
      server.loadAccount(publicKey),
      server.payments().forAccount(publicKey).limit(20).order('desc').call(),
    ]);
    const native = (account.balances as Array<{ asset_type: string; balance: string }>).find(
      (b) => b.asset_type === 'native',
    );
    return {
      xlmBalance: native?.balance ?? '0',
      activity: mapPayments(
        payments.records as unknown as HorizonPaymentLike[],
        publicKey,
      ),
    };
  } catch (err) {
    if (isAccountNotFound(err)) return { xlmBalance: '0', activity: [] };
    throw err;
  }
}

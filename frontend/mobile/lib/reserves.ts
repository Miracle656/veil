/**
 * Reserve calculations and explanations for Stellar accounts (Issue #824).
 *
 * Every Stellar account must lock (2 + subentries) * 0.5 XLM as base reserve.
 * Each trustline added creates a subentry that locks an additional 0.5 XLM.
 * This reserve is locked, not spent, and is released if the trustline is removed.
 */

export const BASE_RESERVE_XLM = 0.5;
export const TRUSTLINE_RESERVE_COST_XLM = 0.5;

export const TRUSTLINE_RESERVE_EXPLANATION =
  'Adding a trustline locks 0.5 XLM of your account reserve. This XLM is locked, not spent, and is released back to your available balance if the trustline is removed.';

export type HorizonAccountLike = {
  subentry_count?: number;
  balances?: Array<{
    asset_type?: string;
    balance?: string;
    selling_liabilities?: string;
  }>;
};

export type AccountReserveBreakdown = {
  /** Total XLM held by the account */
  totalBalance: number;
  /** Actual subentries on the account (trustlines, signers, data entries) */
  subentries: number;
  /** Base account reserve (2 * 0.5 XLM = 1.0 XLM) */
  baseAccountReserve: number;
  /** Subentry reserve (subentries * 0.5 XLM) */
  subentryReserve: number;
  /** Total minimum reserve: (2 + subentries) * 0.5 XLM */
  totalReserve: number;
  /** Available/spendable XLM (balance - reserve - liabilities, min 0) */
  spendable: string;
  /** Human-readable explanation of why this amount is reserved */
  reason: string;
};

/** Native XLM that can actually leave the account, as a decimal string. */
export function spendableNativeXlm(account: HorizonAccountLike): string {
  const native = (account.balances ?? []).find((b) => b.asset_type === 'native');
  if (!native?.balance) return '0';

  const balance = Number(native.balance);
  if (!Number.isFinite(balance)) return '0';

  const subentries = Number(account.subentry_count ?? 0);
  const reserve = (2 + subentries) * 0.5;
  const liabilities = Number(native.selling_liabilities ?? '0') || 0;

  const spendable = balance - reserve - liabilities;
  if (!(spendable > 0)) return '0';

  return (Math.floor(spendable * 1e7) / 1e7).toFixed(7);
}

/**
 * Calculates the exact reserve breakdown for a Stellar account.
 * Derived dynamically from the account's actual subentry count.
 */
export function calculateAccountReserve(account: HorizonAccountLike): AccountReserveBreakdown {
  const native = (account.balances ?? []).find((b) => b.asset_type === 'native');
  const totalBalance = native?.balance ? Number(native.balance) : 0;
  const subentries = Number(account.subentry_count ?? 0);
  const baseAccountReserve = 2 * BASE_RESERVE_XLM; // 1.0 XLM
  const subentryReserve = subentries * BASE_RESERVE_XLM; // subentries * 0.5 XLM
  const totalReserve = baseAccountReserve + subentryReserve;
  const spendable = spendableNativeXlm(account);

  let reason = '';
  if (subentries === 0) {
    reason = '1.0 XLM locked for account base reserve (minimum required to maintain the account on Stellar).';
  } else if (subentries === 1) {
    reason = '1.5 XLM locked: 1.0 XLM account base reserve + 0.5 XLM for 1 trustline/subentry (locked, not spent — released if removed).';
  } else {
    reason = `${totalReserve.toFixed(1)} XLM locked: 1.0 XLM account base reserve + ${subentryReserve.toFixed(1)} XLM for ${subentries} trustlines/subentries (locked, not spent — released if removed).`;
  }

  return {
    totalBalance: Number.isFinite(totalBalance) ? totalBalance : 0,
    subentries,
    baseAccountReserve,
    subentryReserve,
    totalReserve,
    spendable,
    reason,
  };
}

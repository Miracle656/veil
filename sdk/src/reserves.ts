/**
 * Reserve-aware spendable balance calculation.
 *
 * A Stellar account cannot spend down to zero: it must retain (2 + subentries)
 * x the 0.5 XLM base reserve, plus anything already committed as selling
 * liabilities on the DEX.
 *
 * Ignoring that is invisible on testnet, where a Friendbot account holds
 * 10,000 XLM and the reserve is noise. On mainnet, where balances are small and
 * real, a "Max" that offers the full balance builds a transaction that cannot
 * succeed (tx_insufficient_balance) — and the user only finds out after
 * signing.
 *
 * Trustlines and data entries each add a subentry, so the reserve is read from
 * the account rather than assumed.
 */
export type HorizonAccountLike = {
  subentry_count?: number;
  balances?: Array<{
    asset_type?: string;
    balance?: string;
    selling_liabilities?: string;
  }>;
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

  // Truncate rather than round: rounding up re-creates the overspend this
  // function exists to prevent. Stellar amounts carry 7 decimal places.
  return (Math.floor(spendable * 1e7) / 1e7).toFixed(7);
}

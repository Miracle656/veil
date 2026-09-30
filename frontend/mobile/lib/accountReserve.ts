import { Horizon } from '@stellar/stellar-sdk';

import { getNetwork } from './network';

/** Stellar's current base reserve, in XLM, for each account subentry. */
export const BASE_RESERVE_XLM = 0.5;

export type AccountReserve = {
  balance: string;
  subentries: number;
  reservedXlm: number;
  spendableXlm: number;
};

/**
 * Derive the account reserve from Horizon's actual subentry count.
 * The two base account entries are included by the network formula; trustlines
 * and other subentries add one base reserve each. Values are clamped so an
 * unfunded or malformed account response cannot show negative spendable funds.
 */
export function calculateAccountReserve(
  balance: string | number,
  subentries: number,
  baseReserve = BASE_RESERVE_XLM,
): AccountReserve {
  const numericBalance = Number(balance);
  const safeBalance = Number.isFinite(numericBalance) ? Math.max(0, numericBalance) : 0;
  const safeSubentries = Number.isFinite(subentries) ? Math.max(0, Math.floor(subentries)) : 0;
  const reservedXlm = (2 + safeSubentries) * baseReserve;

  return {
    balance: String(balance),
    subentries: safeSubentries,
    reservedXlm,
    spendableXlm: Math.max(0, safeBalance - reservedXlm),
  };
}

function isAccountNotFound(error: unknown): boolean {
  const value = error as { name?: string; response?: { status?: number } };
  return value?.name === 'NotFoundError' || value?.response?.status === 404;
}

/** Read the classic account's current balance and network reserve. */
export async function fetchAccountReserve(address: string): Promise<AccountReserve> {
  const server = new Horizon.Server(getNetwork().horizonUrl);

  try {
    const account = await server.loadAccount(address);
    return calculateAccountReserve(
      account.balances.find((entry) => entry.asset_type === 'native')?.balance ?? '0',
      Number((account as unknown as { subentry_count?: number }).subentry_count ?? 0),
    );
  } catch (error) {
    if (isAccountNotFound(error)) return calculateAccountReserve('0', 0);
    throw error;
  }
}

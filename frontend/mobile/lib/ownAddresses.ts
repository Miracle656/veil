/**
 * The two accounts one Veil user has, read together.
 *
 * A Veil wallet is a pair: the smart wallet (`C…`, signed by the passkey) and
 * the spending account (`G…`, the fee-payer key on the device). Most screens
 * only need the first. A screen that answers "do you hold X" needs both,
 * because the web wallet buys names and Veil-ians AS the spending account for
 * any wallet whose passkey it cannot use (`registerNameAsFeePayer`, veil
 * #1003), and every wallet created on a phone is such a wallet.
 *
 * Asking only the smart wallet is how this app told the holder of the first
 * name ever registered to go and get a name (2026-11-10): the name and the
 * figure were both on the spending account, bought on the web an hour earlier.
 */

import { getFeePayerAddress } from './activity';
import { getWalletAddress } from './walletStore';

export interface OwnAddresses {
  /** The smart wallet. Null when no wallet is open on this device. */
  wallet: string | null;
  /** The spending account. Null when there is no key for one. */
  spending: string | null;
}

export async function getOwnAddresses(): Promise<OwnAddresses> {
  const [wallet, spending] = await Promise.all([
    getWalletAddress().catch(() => null),
    getFeePayerAddress().catch(() => null),
  ]);
  return { wallet, spending };
}

/** Both addresses as a list, without the ones that do not exist. */
export function listOwn(own: OwnAddresses): string[] {
  return [own.wallet, own.spending].filter((a): a is string => Boolean(a));
}

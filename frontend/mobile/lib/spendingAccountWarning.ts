/**
 * Whether to warn that the spending account dies with this phone.
 *
 * A spending account on a random key exists in one keychain. Delete the app
 * and whatever it holds is gone. Until 2026-11-14 the only place the app said
 * so was the fee-payer settings screen, three taps from anywhere a user goes.
 * The dashboard said nothing, and the Receive screen handed that address out
 * as the one to give an employer. A user was paid 31.07 USDC there and lost it.
 *
 * So the warning goes where the address is used, and it stays until the
 * account is no longer at risk. It cannot be dismissed: the thing it describes
 * does not go away by being dismissed.
 */
import type { FeePayerSource } from './feePayerSource';

export type SpendingAccountWarning = {
  /** `danger` is known to be at risk; `check` is unknown and one prompt settles it. */
  level: 'danger' | 'check';
  title: string;
  body: string;
  /** Opens the recovery screen, where the passkey check and the move live. */
  primary: string;
  /** Offered only when the account is known to be at risk. */
  secondary: string | null;
};

/**
 * The warning for this wallet, or null when there is nothing to say.
 *
 * Pure, so every branch is tested without a phone. `walletAddress` is the
 * stored wallet: only a smart wallet (a `C…` address) has a separate spending
 * account. A keypair wallet's own key is the subject of `secretExport.ts`.
 */
export function spendingAccountWarning(
  walletAddress: string | null,
  source: FeePayerSource | null,
): SpendingAccountWarning | null {
  if (!walletAddress || !walletAddress.startsWith('C') || !source) return null;
  if (source === 'random') {
    return {
      level: 'danger',
      title: 'This address is not backed up',
      body:
        'Your spending account lives only on this phone. If you delete Veil or lose the phone, ' +
        'the money in it cannot be recovered, by you or by us. Securing it takes one fingerprint.',
      primary: 'Secure it with my passkey',
      secondary: 'Save the key instead',
    };
  }
  if (source === 'unknown') {
    return {
      level: 'check',
      title: 'Check that this address is backed up',
      body:
        'This wallet was set up before Veil recorded how its spending account was made. One ' +
        'fingerprint check tells you whether it would survive deleting the app.',
      primary: 'Check now',
      secondary: null,
    };
  }
  // prf, credential-id and keypair can all be rebuilt without this phone.
  return null;
}

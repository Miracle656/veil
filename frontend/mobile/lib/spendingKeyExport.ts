/**
 * Revealing the key of a smart wallet's spending account, when nothing else
 * can save it.
 *
 * `lib/secretExport.ts` refuses every smart wallet, on the reasoning that its
 * stored secret is "the fee-payer, a PRF-derived implementation detail". That
 * is true of most wallets and false of the ones that matter here. When a
 * passkey gives no PRF value, the spending account is put on a random key that
 * exists in this phone's keychain and nowhere else. It is also the address the
 * Receive screen hands out, so it is where people get paid.
 *
 * A user lost 31.07 USDC that way on 2026-11-14: random key, app uninstalled,
 * key gone. The encrypted backup would not have saved it, because the backup
 * never contains a private key.
 *
 * The first answer to a random key is to move off it (`retryRecoveryBinding`),
 * which needs the passkey to return a PRF value. Some passkey managers never
 * will. For those wallets, writing the key down is the only way the spending
 * account survives the phone, and this module is what allows it.
 *
 * RULES
 * -----
 * 1. Only a spending account recorded as `random`. A PRF-derived key can be
 *    rebuilt from the passkey, so showing it would add a way to lose money and
 *    take none away. An unrecorded one must be checked with the passkey first.
 * 2. The secret must derive the address being shown, the same proof
 *    `secretExport.ts` requires.
 * 3. The smart wallet itself is untouched by this. Its signing key is in the
 *    passkey and has no secret to show. This reveals the spending account only,
 *    and the screen says so.
 * 4. Nothing is written anywhere. The device-lock gate is the caller's, exactly
 *    as for a keypair wallet.
 */
import { Keypair } from '@stellar/stellar-sdk';

import { getFeePayerInfo } from './feePayerSource';
import { walletKind } from './secretExport';
import { getSignerSecret, getWalletAddress } from './walletStore';

export type SpendingKeyExportState =
  /** Nothing on this network. */
  | { status: 'no-wallet' }
  /** Not a smart wallet: `secretExport.ts` is the module for it. */
  | { status: 'not-a-smart-wallet'; address: string }
  /** The spending key can be rebuilt from the passkey. Nothing needs saving. */
  | { status: 'recoverable'; address: string }
  /** Nobody has checked how this spending key was made. Check first. */
  | { status: 'unchecked'; address: string }
  /** The stored secret is missing or does not derive the spending address. */
  | { status: 'no-secret'; address: string }
  /** Proven: `secret` is the key of the random spending account `address`. */
  | { status: 'revealable'; address: string; secret: string };

export async function resolveSpendingKeyExport(): Promise<SpendingKeyExportState> {
  const wallet = await getWalletAddress();
  if (!wallet) return { status: 'no-wallet' };
  if (walletKind(wallet) !== 'smart') return { status: 'not-a-smart-wallet', address: wallet };

  const info = await getFeePayerInfo();
  if (!info) return { status: 'no-secret', address: wallet };
  if (info.source === 'prf' || info.source === 'credential-id') {
    return { status: 'recoverable', address: info.address };
  }
  if (info.source !== 'random') return { status: 'unchecked', address: info.address };

  const secret = await getSignerSecret();
  if (!secret) return { status: 'no-secret', address: info.address };
  try {
    if (Keypair.fromSecret(secret).publicKey() !== info.address) {
      return { status: 'no-secret', address: info.address };
    }
  } catch {
    return { status: 'no-secret', address: info.address };
  }
  return { status: 'revealable', address: info.address, secret };
}

export const SPENDING_REFUSAL_COPY: Record<
  Exclude<SpendingKeyExportState, { status: 'revealable' }>['status'],
  { title: string; body: string }
> = {
  'no-wallet': {
    title: 'No wallet on this device',
    body: 'Create or import a wallet first. There is nothing to reveal yet.',
  },
  'not-a-smart-wallet': {
    title: 'This is not a passkey wallet',
    body: 'Use “Reveal secret key” in Settings for a keypair wallet.',
  },
  recoverable: {
    title: 'There is no key you need to save',
    body:
      'Your spending account is made from your passkey. Signing in with the same passkey on any ' +
      'phone brings it back, so there is nothing to write down.',
  },
  unchecked: {
    title: 'Check this account with your passkey first',
    body:
      'This wallet was set up before Veil recorded how its spending account was made. Open ' +
      'Settings, then Recovery, and run the passkey check. If the account turns out to live ' +
      'only on this phone, you can save its key here.',
  },
  'no-secret': {
    title: 'No spending key on this device',
    body: 'The key for this spending account is not stored here, so it cannot be shown.',
  },
};

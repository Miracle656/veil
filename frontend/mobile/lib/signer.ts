/**
 * Resolving the wallet signer.
 *
 * The production wallet derives its signer from the device passkey (PRF key,
 * see `lib/backup.ts`) and never persists a secret. That path needs a native
 * passkey module + dev build and does not run in Expo Go.
 *
 * For testnet testing we run a simpler model: the wallet is a plain Stellar
 * keypair whose secret lives in secure storage ({@link getSignerSecret}). This
 * signer signs transactions directly with that key, so every already-wired flow
 * (send, swap, earn) works end-to-end in Expo Go against testnet. When the
 * passkey/smart-wallet path lands it can take precedence here.
 */

import { Keypair } from '@stellar/stellar-sdk';

import type { WalletSigner } from './sendPayment';
import { getSignerSecret } from './walletStore';

export class SignerUnavailableError extends Error {
  constructor(message = 'No wallet key on this device. Create a testnet wallet first.') {
    super(message);
    this.name = 'SignerUnavailableError';
  }
}

/** Build a {@link WalletSigner} from a raw Stellar secret seed. */
export function keypairSigner(secret: string): WalletSigner {
  const kp = Keypair.fromSecret(secret);
  return {
    publicKey: kp.publicKey(),
    sign: (tx) => tx.sign(kp),
  };
}

/**
 * Produce the signer for the active wallet. Reads the stored testnet keypair
 * secret; throws {@link SignerUnavailableError} when none is present.
 */
export async function requireSigner(): Promise<WalletSigner> {
  const secret = await getSignerSecret();
  if (!secret) throw new SignerUnavailableError();
  return keypairSigner(secret);
}

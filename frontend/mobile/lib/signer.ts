/**
 * Resolving the wallet signer — the one native piece the send flow can't do
 * portably yet.
 *
 * On this wallet the signer that authorizes and pays for a transfer is derived
 * from the device passkey (the PRF-based key described in `lib/backup.ts`); the
 * secret is never persisted, so it must be produced live from the passkey each
 * time. React Native has no passkey module wired yet — the web relies on
 * WebAuthn (`navigator.credentials`), which has no React Native equivalent
 * without a native module and config plugin.
 *
 * Until that module lands this fails closed with a clear, typed error. The rest
 * of the send flow (`lib/sendPayment.ts`) is complete and works the instant a
 * real {@link WalletSigner} is returned here — that is the only line to change.
 */

import type { WalletSigner } from './sendPayment';

export class SignerUnavailableError extends Error {
  constructor(message = 'Passkey signing is not available on this device yet.') {
    super(message);
    this.name = 'SignerUnavailableError';
  }
}

/**
 * Produces the passkey-derived signer for the active wallet, or throws
 * {@link SignerUnavailableError} while the mobile passkey module is pending.
 */
export async function requireSigner(): Promise<WalletSigner> {
  throw new SignerUnavailableError();
}

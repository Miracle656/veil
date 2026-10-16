import { retryRecoveryBinding } from './passkeyWallet';
import type { PrfRecoveryState } from './recoveryStatus';

/** Check PRF and safely retry binding only when changing the fee-payer is safe. */
export async function checkPasskeyRecovery(): Promise<PrfRecoveryState> {
  const result = await retryRecoveryBinding();
  return result.bound ? 'ready' : result.issue;
}

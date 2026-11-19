import { retryRecoveryBinding } from './passkeyWallet';
import type { PrfRecoveryState } from './recoveryStatus';

export type PasskeyRecoveryCheckResult = {
  state: PrfRecoveryState;
  shortfallXlm?: number;
};

/** Check PRF and safely retry binding, returning full state and any move shortfall. */
export async function checkPasskeyRecoveryDetails(): Promise<PasskeyRecoveryCheckResult> {
  const result = await retryRecoveryBinding();
  if (result.bound) return { state: 'ready' };
  return {
    state: result.issue,
    shortfallXlm: result.shortfallXlm,
  };
}

/** Check PRF and safely retry binding only when changing the fee-payer is safe. */
export async function checkPasskeyRecovery(): Promise<PrfRecoveryState> {
  const details = await checkPasskeyRecoveryDetails();
  return details.state;
}

import { useCallback, useEffect, useState } from 'react';

import { isPrivacyEnabled } from '../lib/privacy/config';
import { isPrivacyRecoverySupported } from '../lib/privacy/keys';
import { hasUsableWallet } from '../lib/walletStore';

export type PrivacyRecoveryNotice = {
  /** True until the user acknowledges the warning — screens gate confirmation on it. */
  needsAck: boolean;
  /** Record the acknowledgement for this screen visit. */
  acknowledge: () => void;
};

/**
 * Gates a privacy action behind an honest warning (#711).
 *
 * SPP's privacy keys are re-derived from the passkey's PRF output, so a
 * wallet whose spend key is not passkey-bound — a keypair-mode wallet, a
 * random fallback, or a PRF-less passkey such as Samsung Pass — can never
 * recover private balances on another device. The user must be told that
 * BEFORE anything is shielded, not after the notes are stranded.
 *
 * The check runs a PRF ceremony (one biometric prompt) when a passkey wallet
 * exists, and treats any failure as "not supported" — an error must never
 * skip the warning. Feature-off builds and devices with no wallet skip it
 * entirely: nothing to warn about, nothing to prompt for.
 */
export function usePrivacyRecoveryNotice(): PrivacyRecoveryNotice {
  const [warning, setWarning] = useState(false);
  const [ack, setAck] = useState(false);

  useEffect(() => {
    if (!isPrivacyEnabled()) return;
    let alive = true;
    (async () => {
      if (!(await hasUsableWallet().catch(() => false))) return;
      const supported = await isPrivacyRecoverySupported();
      if (alive && !supported) setWarning(true);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const acknowledge = useCallback(() => setAck(true), []);

  return { needsAck: warning && !ack, acknowledge };
}

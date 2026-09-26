import { Buffer } from 'buffer';
import { Keypair } from '@stellar/stellar-sdk';

import { evaluatePrf } from './passkey';
import { getPasskeyId, getSignerSecret } from './walletStore';
import type { PrfRecoveryState } from './recoveryStatus';

const FEE_PAYER_PRF_SALT = new Uint8Array(
  new TextEncoder().encode('invisible-wallet/prf/feepayer/v1')
);

/** Prompt only when the user explicitly asks whether this passkey has PRF. */
export async function checkPasskeyRecovery(): Promise<PrfRecoveryState> {
  const [credentialId, signerSecret] = await Promise.all([getPasskeyId(), getSignerSecret()]);
  if (!credentialId || !signerSecret) return 'missing';
  const result = await evaluatePrf(credentialId, FEE_PAYER_PRF_SALT);
  if (result.outcome !== 'ok' || !result.output) return 'missing';
  const derived = Keypair.fromRawEd25519Seed(Buffer.from(result.output.subarray(0, 32)));
  return derived.secret() === signerSecret ? 'ready' : 'missing';
}

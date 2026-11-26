import { Keypair } from '@stellar/stellar-sdk'
import { deriveFeePayerKeypair as sdkDeriveFeePayerKeypair } from '@veil/sdk'
import { walletLocal } from '@/lib/walletStorage'

/**
 * Re-exported from `@veil/sdk`.
 *
 * SECURITY: the credential ID this derives from is NOT a secret (see
 * docs/NON_PRF_FEE_PAYER_EXPOSURE.md and docs/adr/0003-fee-payer-key-from-webauthn-prf.md).
 * It is stored in cleartext in localStorage (`invisible_wallet_key_id`) and passed
 * in `publicKey.allowCredentials` on every assertion.
 *
 * The resulting key is therefore not passkey-bound — anyone who can read the
 * credential ID can reconstruct it with no biometric prompt.
 *
 * Current Architecture:
 * - Passkey-bound wallets derive fee-payer keys via WebAuthn PRF (`prf-raw` / `prf-hkdf`).
 * - New non-PRF wallets generate a random keypair (`mode: 'random'`) rather than
 *   deriving a spending key from the public credential ID.
 * - This function is retained strictly for backward compatibility: probing on-chain
 *   to ensure pre-existing legacy fee-payer accounts are not stranded.
 * - Do not add new callers that use this for spending keys or anything that guards value.
 *
 * The full caveat lives on the SDK implementation; it is repeated here because
 * this is the import path the wallet actually uses.
 */
export { deriveFeePayerKeypair } from '@veil/sdk'

/**
 * Convenience: derive the fee-payer from the credential ID stored in localStorage.
 * Returns null if no credential ID is stored.
 */
export async function deriveStoredFeePayer(): Promise<Keypair | null> {
  const keyId = walletLocal.getItem('invisible_wallet_key_id')
  if (!keyId) return null
  return sdkDeriveFeePayerKeypair(keyId)
}

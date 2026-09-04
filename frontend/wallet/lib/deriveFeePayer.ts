import { Keypair } from '@stellar/stellar-sdk'
import { deriveFeePayerKeypair as sdkDeriveFeePayerKeypair } from '@veil/sdk'
import { walletLocal } from '@/lib/walletStorage'

/**
 * Re-exported from `@veil/sdk`.
 *
 * SECURITY: the credential ID this derives from is not a secret, so the
 * resulting key is not passkey-bound — anyone who can read the credential ID
 * can reconstruct it. The full caveat lives on the SDK implementation; it is
 * repeated here because this is the import path the wallet actually uses, and
 * a re-export line is an easy place for a warning to disappear.
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

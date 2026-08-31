import { Keypair } from '@stellar/stellar-sdk'
import { deriveFeePayerKeypair as sdkDeriveFeePayerKeypair } from '@veil/sdk'
import { walletLocal } from '@/lib/walletStorage'

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

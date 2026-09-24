import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { appConfig } from './config'

const FEE_PAYER_SECRET_KEY = 'veil_fee_payer_secret'

/**
 * The fee payer is an ordinary Stellar account that pays network fees. It does
 * not control the wallet — the passkey does — so a throwaway keypair kept in
 * localStorage is fine for a testnet starter.
 *
 * A production app would derive it from the passkey (see the SDK's PRF helpers)
 * or sponsor fees server-side rather than leaving a secret in the browser.
 */
export function readFeePayerSecret(): string | null {
  return localStorage.getItem(FEE_PAYER_SECRET_KEY)
}

export function saveFeePayerSecret(secret: string): void {
  localStorage.setItem(FEE_PAYER_SECRET_KEY, secret)
}

/**
 * Return a funded fee payer, creating and funding one on first use.
 * On testnet, Friendbot does the funding; on mainnet you must fund it yourself.
 */
export async function ensureFundedFeePayer(): Promise<Keypair> {
  const existing = readFeePayerSecret()
  if (existing) return Keypair.fromSecret(existing)

  const feePayer = Keypair.random()
  saveFeePayerSecret(feePayer.secret())

  if (appConfig.friendbotUrl) {
    const response = await fetch(`${appConfig.friendbotUrl}?addr=${feePayer.publicKey()}`)
    if (!response.ok) {
      throw new Error('Friendbot funding failed — wait a moment and try again.')
    }
    return feePayer
  }

  const horizon = new Horizon.Server(appConfig.horizonUrl)
  await horizon.loadAccount(feePayer.publicKey()).catch(() => {
    throw new Error(
      `No Friendbot configured. Fund ${feePayer.publicKey()} with XLM, then try again.`,
    )
  })
  return feePayer
}

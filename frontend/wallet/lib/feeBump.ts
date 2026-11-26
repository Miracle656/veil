import { inclusionFee } from './fees'
import {
  BASE_FEE,
  Keypair,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk'

export type FeeBumpSponsor = {
  secret: string
  baseFee?: string
}

export type BuildFeeBumpParams = {
  innerTransaction: Transaction
  networkPassphrase: string
  sponsor: FeeBumpSponsor
}

export function buildSponsoredFeeBumpTransaction({
  innerTransaction,
  networkPassphrase,
  sponsor,
}: BuildFeeBumpParams): FeeBumpTransaction {
  const sponsorKeypair = Keypair.fromSecret(sponsor.secret)
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsorKeypair.publicKey(),
    sponsor.baseFee ?? inclusionFee(),
    innerTransaction,
    networkPassphrase,
  )

  feeBump.sign(sponsorKeypair)
  return feeBump
}

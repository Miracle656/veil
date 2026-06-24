import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
  xdr,
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
    sponsor.baseFee ?? BASE_FEE,
    innerTransaction,
    networkPassphrase,
  )

  feeBump.sign(sponsorKeypair)
  return feeBump
}

export type SponsoredReserveParams = {
  sponsorPublicKey: string
  sponsoredAccountId: string
  operations: xdr.Operation[]
}

export function withSponsoredFutureReserves({
  sponsorPublicKey,
  sponsoredAccountId,
  operations,
}: SponsoredReserveParams): xdr.Operation[] {
  return [
    Operation.beginSponsoringFutureReserves({
      sponsoredId: sponsoredAccountId,
      source: sponsorPublicKey,
    }),
    ...operations,
    Operation.endSponsoringFutureReserves({
      source: sponsoredAccountId,
    }),
  ]
}

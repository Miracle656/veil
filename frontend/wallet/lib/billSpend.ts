import { Asset, Horizon, Keypair, Operation, TransactionBuilder } from '@stellar/stellar-sdk'
import { getAssetIssuer, USDC_MAINNET_ISSUER } from '@/lib/assets'
import { inclusionFee } from '@/lib/fees'
import { getNetwork } from '@/lib/network'
import type { NairaCoin } from '@/lib/ngn'
import { requirePasskey } from '@/lib/passkeyAuth'
import { fetchPlatformFee, type PlatformFee } from '@/lib/platformFee'
import { spendableNativeXlm } from '@/lib/reserves'

const Server = Horizon.Server

interface HorizonBalance {
  asset_type: string
  asset_code?: string
  asset_issuer?: string
  balance: string
}

/**
 * Preview what platform fee would be charged for this bill payment, if any.
 *
 * Exists so the confirmation step can show the exact fee before prompting the passkey.
 * A fee the user only learns about after signing is a surprise, so the number shown
 * is the number taken.
 *
 * Returns null if the fee is disabled, unavailable, or if the fee-payer balance
 * would not cover the payment plus the fee (a fee is never allowed to break the payment).
 */
export async function previewBillSpendFee(params: {
  amount: string | number
  coin: NairaCoin
  feePayerAddress: string | null
}): Promise<PlatformFee | null> {
  const { amount, coin, feePayerAddress } = params
  const amountNumber = Number(amount)
  if (!feePayerAddress || !Number.isFinite(amountNumber) || amountNumber <= 0) return null

  try {
    const fee = await fetchPlatformFee(coin.toUpperCase(), amountNumber)
    if (!fee) return null

    const network = getNetwork()
    const horizon = new Server(network.horizonUrl)
    const account = await horizon.loadAccount(feePayerAddress)

    const feeHeld = (account.balances as HorizonBalance[]).find((b) =>
      fee.assetIssuer === null
        ? b.asset_type === 'native'
        : b.asset_code === fee.assetCode && b.asset_issuer === fee.assetIssuer,
    )
    const feeAvailable = fee.assetIssuer === null
      ? Number(spendableNativeXlm(account))
      : feeHeld ? Number(feeHeld.balance) : 0

    if (feeAvailable >= amountNumber + Number(fee.amount)) {
      return fee
    }
    return null
  } catch {
    return null
  }
}

/**
 * Spend crypto from the wallet's fee-payer classic account to pay a reserved bill order.
 *
 * Destination is the classic `G…` address returned by the bill reservation.
 * The payment signs with the fee-payer passkey, applying the Veil platform fee as an
 * additional payment operation when the balance covers both.
 */
export async function sendBillPayment(params: {
  destination: string
  amount: string | number
  coin: NairaCoin
  signerSecret: string
  skipPasskey?: boolean
}): Promise<string> {
  const { destination, amount, coin, signerSecret, skipPasskey = false } = params
  const amountNumber = Number(amount)
  if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
    throw new Error('Invalid payment amount.')
  }

  const feePayerKp = Keypair.fromSecret(signerSecret)
  const network = getNetwork()
  const horizonServer = new Server(network.horizonUrl)
  const account = await horizonServer.loadAccount(feePayerKp.publicKey())

  const isUsdc = coin === 'usdc'
  const issuer = isUsdc ? (getAssetIssuer('USDC', network.name) ?? USDC_MAINNET_ISSUER) : null
  const asset = isUsdc && issuer ? new Asset('USDC', issuer) : Asset.native()

  // Balance check before passkey
  const held = (account.balances as HorizonBalance[]).find((b) =>
    !isUsdc
      ? b.asset_type === 'native'
      : b.asset_code === 'USDC' && b.asset_issuer === issuer,
  )
  const available = !isUsdc
    ? Number(spendableNativeXlm(account))
    : held ? Number(held.balance) : 0

  if (available < amountNumber) {
    throw new Error(
      `This wallet holds ${available.toLocaleString('en-US', { maximumFractionDigits: isUsdc ? 2 : 4 })} ${coin.toUpperCase()}, less than this top-up needs.`,
    )
  }

  // Passkey prompt (user presence gate)
  if (!skipPasskey) {
    await requirePasskey()
  }

  const builder = new TransactionBuilder(account, {
    fee: inclusionFee(),
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(Operation.payment({
      destination,
      asset,
      amount: String(amountNumber),
    }))
    .setTimeout(30)

  // Append platform fee if affordable
  const platformFee = await fetchPlatformFee(coin.toUpperCase(), amountNumber)
  if (platformFee) {
    const feeHeld = (account.balances as HorizonBalance[]).find((b) =>
      platformFee.assetIssuer === null
        ? b.asset_type === 'native'
        : b.asset_code === platformFee.assetCode && b.asset_issuer === platformFee.assetIssuer,
    )
    const feeAvailable = platformFee.assetIssuer === null
      ? Number(spendableNativeXlm(account))
      : feeHeld ? Number(feeHeld.balance) : 0

    if (feeAvailable >= amountNumber + Number(platformFee.amount)) {
      builder.addOperation(Operation.payment({
        destination: platformFee.destination,
        asset: platformFee.assetIssuer
          ? new Asset(platformFee.assetCode, platformFee.assetIssuer)
          : Asset.native(),
        amount: platformFee.amount,
      }))
    }
  }

  const tx = builder.build()
  tx.sign(feePayerKp)
  const result = await horizonServer.submitTransaction(tx)
  return result.hash
}

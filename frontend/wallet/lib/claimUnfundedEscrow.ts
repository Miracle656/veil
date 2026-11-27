import { TransactionBuilder, type Keypair } from '@stellar/stellar-sdk'

import { claimEscrowWithFeeBump, type FeeBumpedClaimResult } from './escrow'
import { peekFeePayerKeypair } from './feePayer'
import { inclusionFee } from './fees'
import { getNetwork } from './network'

/**
 * Claim a claimable balance from a one-time address that holds no XLM, with
 * this wallet's fee payer paying for the claim.
 *
 * **The fee payer is the link, and this function makes it on purpose.** A
 * fee-bump transaction records its fee source in the ledger entry, so anyone
 * reading the chain sees that this wallet's long-lived fee-payer account paid
 * for the claim that credited the one-time address. That ties the claimed
 * balance to this user exactly as claiming from their own wallet would have.
 * The one-time key never needs XLM, but it was never the thing hiding the
 * claim — the payer is.
 *
 * What the user can do about it, stated plainly in the UI that calls this:
 *
 *  - pay from a fee payer that is not tied to them — a fresh account funded
 *    from a source the network cannot connect back to them, used once;
 *  - or accept that this claim is public. Reusing this wallet's fee payer is
 *    choosing that, not avoiding it.
 *
 * The same applies when the one-time address has never been funded: this
 * wallet's fee payer also pays to create it, and that transfer is public too
 * (see {@link claimEscrowWithFeeBump}).
 *
 * A failed claim consumes nothing — the balance stays claimable — so calling
 * this again after a network error is safe.
 */
export async function claimUnfundedEscrow(params: {
  /** The one-time key that is a claimant on the balance. Signs the claim. */
  claimant: Keypair
  balanceId: string
}): Promise<FeeBumpedClaimResult> {
  const feePayer = peekFeePayerKeypair()
  if (!feePayer) {
    throw new Error('The wallet is locked: the fee payer is needed to pay for this claim.')
  }

  const { horizonUrl, networkPassphrase } = getNetwork()
  const asSigner = (keypair: Keypair) => ({
    publicKey: keypair.publicKey(),
    signTransaction: (xdr: string) => {
      const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase)
      tx.sign(keypair)
      return tx.toXDR()
    },
  })

  return claimEscrowWithFeeBump({
    claimant: asSigner(params.claimant),
    feePayer: asSigner(feePayer),
    balanceId: params.balanceId,
    config: { horizonUrl, networkPassphrase },
    baseFee: inclusionFee(),
  })
}

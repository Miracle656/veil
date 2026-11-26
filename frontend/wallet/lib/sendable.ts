/**
 * How much of a balance a send screen may actually offer.
 *
 * The Send screen had a flat `balance - 1.5` for XLM. That is the reserve of an
 * account holding exactly one trustline, and nothing holds the account to that:
 * Stellar locks 1 XLM for the account plus 0.5 for every trustline, offer and
 * data entry. An account with four trustlines keeps 3 XLM back, so "Max" filled
 * in a figure 1.5 XLM larger than the network would release and the send was
 * rejected with `tx_insufficient_balance` — while the screen still read
 * "5.37 available". An account with no trustlines had 0.5 XLM withheld from it
 * for nothing.
 *
 * Kept out of the page so it can be tested: the reserve arithmetic is the part
 * that decides whether a "Max" send succeeds, and it was wrong in both
 * directions without a single test noticing.
 */

/** As much of the Send screen's asset shape as this needs. */
export interface SendableAsset {
  code: string
  issuer: string | null
  /** Decimal string from Horizon. */
  balance: string
  /** Balance less the reserve, computed where the account was loaded. */
  spendable?: string
}

/**
 * The largest amount of `asset` a transaction may carry.
 *
 * The inclusion fee comes off the XLM figure as well. The bid has to clear the
 * reserve like everything else, so a "Max" that spends to the last stroop fails
 * by exactly the width of the fee — and two operations are budgeted for, since
 * the Veil fee rides behind the user's own payment.
 *
 * `spendable` is trusted when present and the balance is the fallback, which is
 * correct for issued assets (they carry no reserve) and conservative for XLM on
 * an account that could not be loaded, where the balance is '0' anyway.
 */
export function maxSendable(asset: SendableAsset, inclusionFeeStroops: string | number): number {
  const spendable = parseFloat(asset.spendable ?? asset.balance)
  if (!Number.isFinite(spendable)) return 0

  if (asset.code === 'XLM' && !asset.issuer) {
    const feeXlm = (2 * Number(inclusionFeeStroops)) / 1e7
    if (!Number.isFinite(feeXlm)) return Math.max(0, spendable)
    return Math.max(0, spendable - feeXlm)
  }

  return Math.max(0, spendable)
}

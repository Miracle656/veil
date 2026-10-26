/**
 * #1201 — the affordability margin for a Veil fee riding on a classic SDEX swap.
 *
 * This file is byte-identical to `frontend/wallet/lib/sdexSwapFeeAttach.ts`
 * (apart from line endings), pinned by the sdexSwapFeeAttach parity tests in
 * both apps. The rule lives here once per client so mobile and web cannot drift
 * into two slightly different rules — the fee either rides on the same terms
 * everywhere or nowhere.
 *
 * A swap that overdraws the account fails outright — txINSUFFICIENT_BALANCE,
 * nothing settles, and the user watches a swap they could almost afford die
 * because of a fee they never asked for. So the margin below must cover every
 * stroop the transaction will actually consume, not just the two amounts the
 * user sees:
 *
 *   1. The inclusion fee, at the operation count the transaction will really
 *      have. The account must be able to pay its WHOLE bid above reserve, and
 *      the fee operation adds one more operation to that bid. A check that
 *      prices the swap's own operations but not the fee's approves a
 *      transaction the network then rejects.
 *   2. The reserve a changeTrust in the same transaction locks. Spendable XLM
 *      is read from the subentry count as it stands NOW; a trustline added by
 *      this transaction raises the locked reserve by a further 0.5 XLM the
 *      pre-check cannot otherwise see.
 *
 * Anything short, malformed or unreadable is "no fee" — a fee nobody asked for
 * must never be the reason a swap fails.
 */

/** 0.5 XLM per new subentry — the same value `lib/reserves` calls TRUSTLINE_RESERVE_COST_XLM. */
const TRUSTLINE_SUBENTRY_RESERVE_XLM = 0.5;

const STROOPS_PER_XLM = 10_000_000;

/** Everything the decision reads, as plain data, so both callers feed it the same shape. */
export interface SdexSwapFeeMargin {
  /** Native XLM left after the reserve and selling liabilities — `spendableNativeXlm(account)`. */
  spendableXlm: string | number;
  /** The swap's sendAmount, in whole XLM. Only a swap paying in XLM can carry the fee. */
  nativeAmountIn: string;
  /** The Veil fee, in whole XLM, as the server stated it. */
  feeAmount: string;
  /** The transaction's per-operation fee bid, in stroops — `Number(inclusionFee())`. */
  perOpBidStroops: number;
  /** Operations in the transaction WITHOUT the fee op (1, or 2 when it also adds a trustline). */
  opsWithoutFee: number;
  /** True when this same transaction adds the destination trustline. */
  addsTrustline: boolean;
}

/** Whole XLM to stroops, exact for the 7-decimal amounts Stellar carries. */
function toStroops(value: string | number): number {
  return Math.round(Number(value) * STROOPS_PER_XLM);
}

/**
 * Whether the Veil fee can be added to this swap's transaction without
 * putting it over the edge. False means drop the fee — never fail the swap.
 */
export function canAffordSdexSwapFee(margin: SdexSwapFeeMargin): boolean {
  const {
    spendableXlm,
    nativeAmountIn,
    feeAmount,
    perOpBidStroops,
    opsWithoutFee,
    addsTrustline,
  } = margin;

  // A fee the margin arithmetic cannot trust is a fee not charged.
  if (!/^(\d+)(\.\d{1,7})?$/.test(feeAmount.trim())) return false;
  if (!/^(\d+)(\.\d{1,7})?$/.test(String(nativeAmountIn).trim())) return false;
  if (!(Number(feeAmount) > 0)) return false;
  if (!(Number(nativeAmountIn) > 0)) return false;
  if (!Number.isFinite(perOpBidStroops) || perOpBidStroops < 0) return false;
  if (!Number.isInteger(opsWithoutFee) || opsWithoutFee < 1) return false;
  const spendable = Number(spendableXlm);
  if (!Number.isFinite(spendable)) return false;

  const needed =
    toStroops(nativeAmountIn) +
    toStroops(feeAmount) +
    // The fee operation itself joins the transaction, so the bid is charged
    // for opsWithoutFee + 1 operations, not the swap's own count.
    (opsWithoutFee + 1) * Math.round(perOpBidStroops) +
    // changeTrust in this same transaction locks one more subentry's reserve
    // the moment it settles — invisible to a spendable read taken before it.
    (addsTrustline ? toStroops(TRUSTLINE_SUBENTRY_RESERVE_XLM) : 0);

  return toStroops(spendable) >= needed;
}

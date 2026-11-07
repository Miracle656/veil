/**
 * Shared bill payment machinery and the per-category seam.
 *
 * Every Nigerian bill category in wraith (`airtime`, `data`, `electricity`,
 * `cabletv`, `betting`) moves money the same way:
 *
 *   1. Gate on mainnet (Linq has no sandbox; every call moves real money).
 *   2. Resolve `customerRef` and the classic `G…` `refundAddress` (the
 *      fee-payer account, because a classic refund payment cannot name a
 *      `C…` smart wallet contract).
 *   3. Quote the live NGN rate per coin (`usdc` or `xlm`).
 *   4. Gate the confirm step on the one-time NIN check (`isNairaVerified`),
 *      bouncing unverified users to `/verify` with a return path and summary.
 *   5. Preview any platform fee on the confirm step (`previewSpendFee`) so the
 *      user sees it *before* the passkey prompt, never in history afterwards.
 *   6. Reserve the bill order (`payBill`) to lock the rate and obtain the
 *      deposit address, and only then spend the exact locked amount from the
 *      wallet (`spendAsset`).
 *   7. Poll `getBillStatus` until the vend settles (`done`) or is rejected and
 *      refunded (`failed`), while keeping transient poll errors silent to the
 *      user so a network blip after payment has left never reads as a failed
 *      payment.
 *
 * ## The per-category seam
 *
 * **What belongs on the shared side (`lib/billFlow.ts` + `components/BillFlow.tsx`):**
 *   - Network gating (`mainnet` only)
 *   - `customerRef` and `refundAddress` resolution
 *   - Per-coin rate loading (`xlm` / `usdc`), retry, and crypto cost math
 *   - NGN amount input, quick-amount chips, and asset segment selector
 *   - One-time NIN verification check and `/verify` redirect
 *   - Pre-passkey `previewSpendFee` on the confirm step
 *   - Order reservation (`payBill`) followed by `spendAsset` using the order's
 *     locked `amountStableCoin` and `wallet`
 *   - Status polling (`getBillStatus`) and step transitions
 *     (`form` → `confirm` → `paying` → `done` / `failed`)
 *
 * **What belongs on the category side (e.g. `app/airtime.tsx`):**
 *   - `category`: the `BillCategory` key sent to `/ngn/bills`
 *   - `provider`: the selected biller / network code (e.g. `'MTN'`, `'IKEDC'`)
 *   - `customerId`: the normalized recipient identifier (phone digits, meter
 *     number, smartcard/IUC number, or betting account ID)
 *   - `customerValid`: category-specific validation of `provider` + `customerId`
 *   - Category-specific form controls and helpers (for airtime: prefix-based
 *     network auto-detection, network override chips, phone input, and contact
 *     picker; for electricity/TV: meter or smartcard input and lookup)
 *   - `copy`: category-specific labels, confirmation rows, and status prose
 */

import type { DeployFn } from './deployWallet';
import { getAssetIssuer } from './assets';
import {
  payBill,
  type BillCategory,
  type BillOrder,
  type NairaCoin,
} from './onramp';
import { spendAsset } from './spendAsset';

export type BillStep = 'form' | 'confirm' | 'paying' | 'done' | 'failed' | 'unconfirmed';

export type BillRateState = 'loading' | 'ready' | 'failed';

export interface BillSummaryRow {
  label: string;
  value: string;
}

/**
 * Category-supplied copy and summary rows across the five bill steps.
 *
 * Keeping copy on the category side of the seam prevents airtime nouns
 * ("airtime", "top-up", "phone") from leaking into the shared flow while
 * letting every category share the same layout and state machine.
 */
export interface BillCategoryCopy {
  /** Heading shown when the wallet is on testnet. */
  mainnetTitle: string;
  /** Explanation shown under `mainnetTitle` when on testnet. */
  mainnetHint: string;
  /** Noun used in `NotEnoughToSend` errors (e.g. `'top-up'`, `'payment'`). */
  insufficientBalanceNoun?: string;
  /** Summary passed to `/verify` when the customer has not completed NIN KYC. */
  verifySummary: (amountFormatted: string) => string;
  /** Headline above the crypto cost on the confirm step. */
  confirmQuestion: (amountFormatted: string) => string;
  /** Category-specific detail rows shown on the confirm card before "Paid from". */
  confirmRows: BillSummaryRow[];
  /** Refund reassurance note on the confirm step. */
  refundNote: string;
  /** Headline on the paying step after the passkey prompt completes. */
  payingTitle: string;
  /** Subtitle on the paying step after the passkey prompt completes. */
  payingHint: (amountFormatted: string) => string;
  /** Spinner caption while polling `getBillStatus`. */
  payingWaitLabel: string;
  /** Left-hand label on the paying summary row (e.g. `'Airtime'`, `'Electricity'`). */
  payingSummaryLabel: string;
  /** Right-hand value on the paying summary row. */
  payingSummaryValue: (amountFormatted: string) => string;
  /** Headline on the `done` step. */
  doneTitle: string;
  /** Subtitle on the `done` step. */
  doneHint: (amountFormatted: string) => string;
  /** Category-specific detail rows on the `done` step before "You spent". */
  doneRows: BillSummaryRow[];
  /** Primary button label on the `done` step (defaults to `'Buy again'`). */
  doneAgainLabel?: string;
  /** Subtitle on the `failed` step explaining that the crypto is being returned. */
  failedHint: (spentFormatted: string) => string;
  /** Left-hand label on the `failed` card explaining what the provider rejected. */
  failedReasonLabel: string;
}

/**
 * The complete per-category configuration passed across the seam into `BillFlow`.
 */
export interface BillCategoryConfig {
  /** Backend category key (`'airtime' | 'data' | 'electricity' | 'cabletv' | 'betting'`). */
  category: BillCategory;
  /** Header title for `FlowHeader` and `/verify` return label. */
  title: string;
  /** Route path `/verify` returns to after one-time NIN verification. */
  returnTo: string;
  /** Selected biller/network identifier sent to `payBill`. */
  provider: string;
  /** Normalized customer identifier (phone digits, meter number, etc.) sent to `payBill`. */
  customerId: string;
  /** Whether the category-specific fields are valid and ready to continue. */
  customerValid: boolean;
  /** Quick NGN amount chips shown below the amount input. */
  quickAmounts?: readonly number[];
  /** Category-specific copy and summary rows for each step. */
  copy: BillCategoryCopy;
}

export const DEFAULT_QUICK_AMOUNTS: readonly number[] = [200, 500, 1000, 2000];

export function formatNaira(n: number): string {
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
}

export function parseBillAmountNgn(raw: string): number {
  return Number(raw.replace(/[^\d]/g, '')) || 0;
}

export function computeBillCryptoCost(amountNgn: number, rate: number | null): number {
  return rate && rate > 0 && amountNgn > 0 ? amountNgn / rate : 0;
}

/**
 * Lock the 7-decimal Stellar amount sent to both `payBill` and `spendAsset`.
 *
 * Linq settles at whatever amount actually arrives ("this is a manual deposit
 * by design"), so the amount spent on-chain must be identical to the amount
 * reserved in the bill order.
 */
export function lockBillAmountStableCoin(amountNgn: number, rate: number): number {
  return Number((amountNgn / rate).toFixed(7));
}

export function canContinueBillForm(params: {
  customerValid: boolean;
  amountNgn: number;
  rateState: BillRateState;
}): boolean {
  return params.customerValid && params.amountNgn > 0 && params.rateState === 'ready';
}

/**
 * Map a `getBillStatus` status string to the bill flow's terminal state, or
 * `'pending'` while the vend is still in flight.
 *
 * `settled` and `disbursed` are in the success list because they are the words
 * Linq actually ends a vend with. Without them a delivered, paid-for top-up
 * classified as `pending` and the screen waited for it forever. wraith now
 * appends "(completed)" for installed apps that predate this
 * (`billStatusForClients`), but a client that can read the provider's own word
 * should not need the translation.
 */
export function classifyBillPollStatus(status: string): 'done' | 'failed' | 'pending' {
  // Checked before the success test: "settlement_pending" and "refund_pending"
  // both contain a terminal word and are not terminal.
  if (/pending|processing|awaiting|queued|initiated|progress/i.test(status)) return 'pending';
  if (/complete|success|delivered|settled|disbursed/i.test(status)) return 'done';
  if (/fail|refund|revers|cancel|expire|timeout/i.test(status)) return 'failed';
  return 'pending';
}

/**
 * Reserve the bill order first, then spend the locked crypto amount to the
 * order's deposit wallet.
 *
 * Kept in one function so every category honours the same invariant:
 *   1. `payBill` runs first; if reserving fails, nothing is spent.
 *   2. `spendAsset` sends `String(amountStableCoin)` — the exact figure locked
 *      into the order — to `order.wallet`.
 */
export async function executeBillPayment(params: {
  customerRef: string;
  billCategory: BillCategory;
  provider: string;
  customerId: string;
  amountNgn: number;
  rate: number;
  coin: NairaCoin;
  refundAddress: string;
  deploy: DeployFn;
  onOrderReserved?: (order: BillOrder, amountStableCoin: number) => void;
  onBeforePasskey?: () => void;
  onAfterPasskey?: () => void;
  payBillFn?: typeof payBill;
  spendAssetFn?: typeof spendAsset;
}): Promise<{ order: BillOrder; amountStableCoin: number; txHash: string }> {
  const reserve = params.payBillFn ?? payBill;
  const spend = params.spendAssetFn ?? spendAsset;

  const amountStableCoin = lockBillAmountStableCoin(params.amountNgn, params.rate);
  const order = await reserve({
    customerRef: params.customerRef,
    billCategory: params.billCategory,
    provider: params.provider,
    customerId: params.customerId,
    amountNgn: params.amountNgn,
    amountStableCoin,
    rate: params.rate,
    coin: params.coin,
    refundAddress: params.refundAddress,
  });
  params.onOrderReserved?.(order, amountStableCoin);

  params.onBeforePasskey?.();
  const issuer = params.coin === 'usdc' ? getAssetIssuer('USDC', 'mainnet') : null;
  const txHash = await spend({
    to: order.wallet,
    amount: String(amountStableCoin),
    ...(issuer ? { asset: { code: 'USDC', issuer } } : {}),
    deploy: params.deploy,
  });
  params.onAfterPasskey?.();

  return { order, amountStableCoin, txHash };
}

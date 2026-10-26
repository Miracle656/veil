/**
 * Shared bill payment machinery and per-category seam from V296.
 *
 * Every Nigerian bill category (`airtime`, `data`, `electricity`, `cabletv`, `betting`)
 * moves money the same way:
 *   1. Gate on mainnet (Linq has no sandbox; every call moves real money).
 *   2. Resolve customerRef and classic G… refundAddress (fee-payer account).
 *   3. Quote live NGN rate per coin (usdc / xlm).
 *   4. Gate confirm step on one-time NIN check (`isNairaVerified`).
 *   5. Preview platform fee on confirm step (`previewSpendFee`) before passkey prompt.
 *   6. Reserve order first (`payBill`) to lock rate and get deposit address, then spend
 *      exact locked amount (`spendAsset`).
 *   7. Poll `getBillStatus` with bounded retry budget and distinguish `unconfirmed` from `failed`.
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

export interface BillCategoryCopy {
  mainnetTitle: string;
  mainnetHint: string;
  insufficientBalanceNoun?: string;
  verifySummary: (amountFormatted: string) => string;
  confirmQuestion: (amountFormatted: string) => string;
  confirmRows: BillSummaryRow[];
  refundNote: string;
  payingTitle: string;
  payingHint: (amountFormatted: string) => string;
  payingWaitLabel: string;
  payingSummaryLabel: string;
  payingSummaryValue: (amountFormatted: string) => string;
  doneTitle: string;
  doneHint: (amountFormatted: string) => string;
  doneRows: BillSummaryRow[];
  doneAgainLabel?: string;
  failedHint: (spentFormatted: string) => string;
  failedReasonLabel: string;
}

export interface BillCategoryConfig {
  category: BillCategory;
  title: string;
  returnTo: string;
  provider: string;
  customerId: string;
  customerValid: boolean;
  quickAmounts?: readonly number[];
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

/**
 * #1201 — the affordability margin for a Veil fee riding on a classic SDEX swap.
 *
 * The stated rule is absolute: a fee the user did not ask for must never cause
 * a swap to fail. These pin the two edges where the old comparison
 * (`spendable >= amountIn + fee`) missed cost the transaction really carries:
 *
 *   1. The inclusion fee, at the operation count the transaction will
 *      ACTUALLY have. The fee operation adds one more operation, and the
 *      network charges an account that cannot cover its whole bid above
 *      reserve with txINSUFFICIENT_BALANCE — the swap dies, not just the fee.
 *   2. The 0.5 XLM subentry reserve a changeTrust in the same transaction
 *      locks once it settles. The spendable read is taken while the trustline
 *      does not exist yet, so the pre-check cannot see it.
 *
 * If these go red, a swap at the last stroop is being approved for a fee it
 * cannot pay — and the network rejects the WHOLE transaction, so the user's
 * swap fails over a charge they never asked for.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { canAffordSdexSwapFee, type SdexSwapFeeMargin } from '../sdexSwapFeeAttach';

const REPO_ROOT = resolve(__dirname, '../../../..');
const MOBILE_HELPER = resolve(REPO_ROOT, 'frontend/mobile/lib/sdexSwapFeeAttach.ts');
const WALLET_HELPER = resolve(REPO_ROOT, 'frontend/wallet/lib/sdexSwapFeeAttach.ts');

// 100 stroops = 0.00001 XLM per operation (testnet), 100,000 = 0.01 XLM (the
// mainnet surge bid). 10 XLM swapped, 0.1 XLM fee.
const TESTNET_BID = 100;

const base: SdexSwapFeeMargin = {
  spendableXlm: '0',
  nativeAmountIn: '10',
  feeAmount: '0.1',
  perOpBidStroops: TESTNET_BID,
  opsWithoutFee: 1,
  addsTrustline: false,
};

const margin = (over: Partial<SdexSwapFeeMargin>): SdexSwapFeeMargin => ({ ...base, ...over });

describe('the inclusion fee, at the real operation count', () => {
  it('refuses the fee when the account covers swap + fee but not the fee op\'s own bid', () => {
    // 10.1 pays amountIn + fee — exactly what the old comparison checked. With
    // the fee op, the transaction bids for 2 ops: 10 + 0.1 + 2 × 0.00001 = 10.10002.
    expect(canAffordSdexSwapFee(margin({ spendableXlm: '10.1000100' }))).toBe(false);
  });

  it('charges the fee at the last stroop the transaction actually needs', () => {
    expect(canAffordSdexSwapFee(margin({ spendableXlm: '10.1000200' }))).toBe(true);
  });

  it('prices the bid for the trustline op too — a 3-op tx needs 3 bids', () => {
    // changeTrust + pathPayment + fee: 10 + 0.1 + 3 × 0.00001 = 10.10003.
    const threeOps = margin({ opsWithoutFee: 2, addsTrustline: false });
    expect(canAffordSdexSwapFee({ ...threeOps, spendableXlm: '10.1000200' })).toBe(false);
    expect(canAffordSdexSwapFee({ ...threeOps, spendableXlm: '10.1000300' })).toBe(true);
  });

  it('holds at the mainnet surge bid, where one extra op costs 0.01 XLM', () => {
    // 10 + 0.1 + 2 × 0.01 = 10.12. Under the old check, 10.1 looked affordable.
    const mainnet = margin({ perOpBidStroops: 100_000 });
    expect(canAffordSdexSwapFee({ ...mainnet, spendableXlm: '10.1199900' })).toBe(false);
    expect(canAffordSdexSwapFee({ ...mainnet, spendableXlm: '10.1200000' })).toBe(true);
  });
});

describe('a trustline added by the same transaction', () => {
  it('refuses the fee when swap + fee + bid fit but the new subentry reserve does not', () => {
    // Without the trustline, 10.10003 is exactly enough; changeTrust then locks
    // a further 0.5 XLM the moment it settles.
    expect(
      canAffordSdexSwapFee(margin({ spendableXlm: '10.1000300', opsWithoutFee: 2, addsTrustline: true })),
    ).toBe(false);
  });

  it('charges the fee once the 0.5 XLM subentry is inside the margin', () => {
    // 10 + 0.1 + 3 × 0.00001 + 0.5 = 10.60003.
    expect(
      canAffordSdexSwapFee(margin({ spendableXlm: '10.6000300', opsWithoutFee: 2, addsTrustline: true })),
    ).toBe(true);
  });

  it('locks no reserve when the account already trusts the destination', () => {
    expect(canAffordSdexSwapFee(margin({ spendableXlm: '10.1000200', addsTrustline: false }))).toBe(true);
  });
});

describe('anything unreadable means no fee, never a failed swap', () => {
  it.each([
    ['a fee with more precision than Stellar has', { feeAmount: '0.123456789' }],
    ['a zero fee', { feeAmount: '0' }],
    ['a negative fee', { feeAmount: '-0.1' }],
    ['a non-numeric fee', { feeAmount: 'free' }],
    ['a zero amount in', { nativeAmountIn: '0' }],
    ['a spendable that is not a number', { spendableXlm: 'nope' }],
    ['a negative bid', { perOpBidStroops: -1 }],
    ['no operations in the transaction', { opsWithoutFee: 0 }],
  ])('refuses the fee for %s', (_label, over) => {
    expect(canAffordSdexSwapFee(margin({ spendableXlm: '1000', ...over }))).toBe(false);
  });
});

describe('mobile and web run one rule, not two (#1201)', () => {
  it('the web helper is byte-identical to the mobile one — edit both together', () => {
    // Line endings are per-checkout noise; every byte of the rule itself must match.
    const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    // If this fails, the margin was edited on one client only, and a swap at
    // the last stroop is affordable on one app and fatal on the other.
    expect(read(WALLET_HELPER)).toBe(read(MOBILE_HELPER));
  });
});

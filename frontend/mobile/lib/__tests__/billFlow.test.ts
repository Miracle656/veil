/**
 * Tests for the shared bill payment flow (`lib/billFlow.ts`) and its category
 * seam (`app/airtime.tsx` + a second category plugged into the same seam).
 *
 * Pins the financial-safety invariants:
 *   - `payBill` reserves the order first; if reservation fails, `spendAsset`
 *     is never called.
 *   - `spendAsset` sends the exact 7-decimal `amountStableCoin` locked in the
 *     order to `order.wallet`.
 *   - `classifyBillPollStatus` maps terminal statuses cleanly and leaves
 *     in-flight statuses pending.
 *   - Both airtime and a second bill category (`electricity`) plug into the
 *     shared seam without duplicating the payment machinery.
 */

import {
  canContinueBillForm,
  classifyBillPollStatus,
  computeBillCryptoCost,
  executeBillPayment,
  formatNaira,
  lockBillAmountStableCoin,
  parseBillAmountNgn,
  type BillCategoryConfig,
} from '../billFlow';
import {
  buildAirtimeCategoryConfig,
  detectNetwork,
  isValidNigerianPhone,
} from '../../app/airtime';

const DEPOSIT_WALLET = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const REFUND_WALLET = 'GBDEVU63Y6NTHJQQZIKVTC23NWLQVP3WJ2RI2OTSJTNYOIGICST6DUXR';
const USDC_MAINNET_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('shared bill flow math and form gating', () => {
  it('parses NGN input digits and computes crypto cost from the per-coin rate', () => {
    expect(parseBillAmountNgn('₦1,500')).toBe(1500);
    expect(parseBillAmountNgn('')).toBe(0);
    expect(computeBillCryptoCost(1500, 1500)).toBe(1);
    expect(computeBillCryptoCost(1500, null)).toBe(0);
    expect(lockBillAmountStableCoin(1000, 1500)).toBe(0.6666667);
    expect(formatNaira(1500)).toBe('₦1,500');
  });

  it('requires valid customer details, a positive amount, and a ready rate before continuing', () => {
    expect(
      canContinueBillForm({ customerValid: true, amountNgn: 500, rateState: 'ready' }),
    ).toBe(true);
    expect(
      canContinueBillForm({ customerValid: false, amountNgn: 500, rateState: 'ready' }),
    ).toBe(false);
    expect(
      canContinueBillForm({ customerValid: true, amountNgn: 0, rateState: 'ready' }),
    ).toBe(false);
    expect(
      canContinueBillForm({ customerValid: true, amountNgn: 500, rateState: 'loading' }),
    ).toBe(false);
  });

  it('classifies poll statuses into done, failed, or pending', () => {
    expect(classifyBillPollStatus('completed')).toBe('done');
    expect(classifyBillPollStatus('DELIVERED')).toBe('done');
    expect(classifyBillPollStatus('success')).toBe('done');
    expect(classifyBillPollStatus('failed')).toBe('failed');
    expect(classifyBillPollStatus('refunded')).toBe('failed');
    expect(classifyBillPollStatus('reversed')).toBe('failed');
    expect(classifyBillPollStatus('cancelled')).toBe('failed');
    expect(classifyBillPollStatus('pending')).toBe('pending');
    expect(classifyBillPollStatus('processing')).toBe('pending');
  });
});

describe('executeBillPayment — reserve first, spend second', () => {
  it('reserves the bill order before spending the locked amount to the order wallet', async () => {
    const callOrder: string[] = [];
    const payBillFn = jest.fn(async () => {
      callOrder.push('payBill');
      return {
        id: 'bill_order_101',
        customerRef: 'veil_4sjjjzwamdoe',
        wallet: DEPOSIT_WALLET,
        status: 'pending',
      };
    });
    const spendAssetFn = jest.fn(async () => {
      callOrder.push('spendAsset');
      return 'tx_hash_airtime_101';
    });

    const result = await executeBillPayment({
      customerRef: 'veil_4sjjjzwamdoe',
      billCategory: 'airtime',
      provider: 'MTN',
      customerId: '08035124471',
      amountNgn: 1000,
      rate: 1500,
      coin: 'usdc',
      refundAddress: REFUND_WALLET,
      deploy: jest.fn(),
      payBillFn,
      spendAssetFn,
    });

    expect(callOrder).toEqual(['payBill', 'spendAsset']);
    expect(result.amountStableCoin).toBe(0.6666667);
    expect(result.txHash).toBe('tx_hash_airtime_101');

    expect(payBillFn).toHaveBeenCalledWith({
      customerRef: 'veil_4sjjjzwamdoe',
      billCategory: 'airtime',
      provider: 'MTN',
      customerId: '08035124471',
      amountNgn: 1000,
      amountStableCoin: 0.6666667,
      rate: 1500,
      coin: 'usdc',
      refundAddress: REFUND_WALLET,
    });

    expect(spendAssetFn).toHaveBeenCalledWith({
      to: DEPOSIT_WALLET,
      amount: '0.6666667',
      asset: { code: 'USDC', issuer: USDC_MAINNET_ISSUER },
      deploy: expect.any(Function),
    });
  });

  it('never spends crypto when reserving the order fails', async () => {
    const payBillFn = jest.fn(async () => {
      throw new Error('Service temporarily unavailable');
    });
    const spendAssetFn = jest.fn();

    await expect(
      executeBillPayment({
        customerRef: 'veil_4sjjjzwamdoe',
        billCategory: 'airtime',
        provider: 'MTN',
        customerId: '08035124471',
        amountNgn: 1000,
        rate: 1500,
        coin: 'xlm',
        refundAddress: REFUND_WALLET,
        deploy: jest.fn(),
        payBillFn,
        spendAssetFn,
      }),
    ).rejects.toThrow('Service temporarily unavailable');

    expect(spendAssetFn).not.toHaveBeenCalled();
  });
});

describe('airtime category on the seam', () => {
  it('detects Nigerian mobile networks from 4-digit prefixes and validates 11-digit numbers', () => {
    expect(detectNetwork('08035124471')).toBe('MTN');
    expect(detectNetwork('08021234567')).toBe('AIRTEL');
    expect(detectNetwork('08051234567')).toBe('GLO');
    expect(detectNetwork('08091234567')).toBe('9MOBILE');
    expect(detectNetwork('080')).toBeNull();

    expect(isValidNigerianPhone('08035124471')).toBe(true);
    expect(isValidNigerianPhone('8035124471')).toBe(false);
    expect(isValidNigerianPhone('0803512')).toBe(false);
  });

  it('builds the airtime category configuration without leaking flow state', () => {
    const cfg = buildAirtimeCategoryConfig({ provider: 'AIRTEL', phone: '0802 123 4567' });
    expect(cfg.category).toBe('airtime');
    expect(cfg.provider).toBe('AIRTEL');
    expect(cfg.customerId).toBe('08021234567');
    expect(cfg.customerValid).toBe(true);
    expect(cfg.copy.confirmQuestion('₦1,000')).toBe('₦1,000 airtime to 08021234567 costs');
    expect(cfg.copy.confirmRows).toEqual([
      { label: 'Network', value: 'AIRTEL' },
      { label: 'Phone', value: '08021234567' },
    ]);
  });
});

describe('adding a second category without copying the flow', () => {
  function buildElectricityCategoryConfig(params: {
    disco: string;
    meterNumber: string;
  }): BillCategoryConfig {
    const meterDigits = params.meterNumber.replace(/\D/g, '');
    return {
      category: 'electricity',
      title: 'Electricity',
      returnTo: '/electricity',
      provider: params.disco,
      customerId: meterDigits,
      customerValid: meterDigits.length >= 11 && meterDigits.length <= 13,
      quickAmounts: [2000, 5000, 10000, 20000],
      copy: {
        mainnetTitle: 'Switch to mainnet to buy electricity',
        mainnetHint: 'Prepaid tokens are vended against real crypto on mainnet only.',
        insufficientBalanceNoun: 'purchase',
        verifySummary: (amt) => `Electricity · ${amt} to meter ${meterDigits}`,
        confirmQuestion: (amt) => `${amt} electricity for ${meterDigits} costs`,
        confirmRows: [
          { label: 'Distributor', value: params.disco },
          { label: 'Meter', value: meterDigits },
        ],
        refundNote: `If ${params.disco} cannot issue the token, the full amount returns to this wallet.`,
        payingTitle: 'Purchasing your token',
        payingHint: (amt) => `${params.disco} is issuing ${amt} for meter ${meterDigits}.`,
        payingWaitLabel: 'Waiting for the meter token…',
        payingSummaryLabel: 'Electricity',
        payingSummaryValue: (amt) => `${amt} · ${params.disco} ${meterDigits}`,
        doneTitle: 'Token issued',
        doneHint: (amt) => `${amt} prepaid units purchased for meter ${meterDigits}.`,
        doneRows: [
          { label: 'Distributor', value: params.disco },
          { label: 'Meter', value: meterDigits },
        ],
        failedHint: (spentStr) =>
          `Your ${spentStr} is being returned to this wallet. No token was issued for ${meterDigits}.`,
        failedReasonLabel: `${params.disco} didn't issue the token`,
      },
    };
  }

  it('executes a second bill category through the exact same payment flow', async () => {
    const elec = buildElectricityCategoryConfig({
      disco: 'IKEDC',
      meterNumber: '45012345678',
    });
    expect(elec.customerValid).toBe(true);

    const payBillFn = jest.fn(async () => ({
      id: 'bill_elec_202',
      customerRef: 'veil_4sjjjzwamdoe',
      wallet: DEPOSIT_WALLET,
      status: 'pending',
    }));
    const spendAssetFn = jest.fn(async () => 'tx_hash_elec_202');

    const res = await executeBillPayment({
      customerRef: 'veil_4sjjjzwamdoe',
      billCategory: elec.category,
      provider: elec.provider,
      customerId: elec.customerId,
      amountNgn: 5000,
      rate: 250,
      coin: 'xlm',
      refundAddress: REFUND_WALLET,
      deploy: jest.fn(),
      payBillFn,
      spendAssetFn,
    });

    expect(res.amountStableCoin).toBe(20);
    expect(payBillFn).toHaveBeenCalledWith(
      expect.objectContaining({
        billCategory: 'electricity',
        provider: 'IKEDC',
        customerId: '45012345678',
        amountNgn: 5000,
        amountStableCoin: 20,
        coin: 'xlm',
      }),
    );
    expect(spendAssetFn).toHaveBeenCalledWith({
      to: DEPOSIT_WALLET,
      amount: '20',
      deploy: expect.any(Function),
    });
  });
});

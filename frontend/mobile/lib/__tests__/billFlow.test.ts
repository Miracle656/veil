import {
  canContinueBillForm,
  classifyBillPollStatus,
  computeBillCryptoCost,
  executeBillPayment,
  formatNaira,
  lockBillAmountStableCoin,
  parseBillAmountNgn,
} from '../billFlow';
import type { BillOrder } from '../onramp';

describe('billFlow', () => {
  describe('formatting & calculation helpers', () => {
    it('formats naira amounts with commas', () => {
      expect(formatNaira(1000)).toBe('₦1,000');
      expect(formatNaira(5500.5)).toBe('₦5,500.5');
      expect(formatNaira(0)).toBe('₦0');
    });

    it('parses naira input stripping non-digits', () => {
      expect(parseBillAmountNgn('₦5,000')).toBe(5000);
      expect(parseBillAmountNgn('10 000')).toBe(10000);
      expect(parseBillAmountNgn('')).toBe(0);
      expect(parseBillAmountNgn('abc')).toBe(0);
    });

    it('computes crypto cost from rate', () => {
      expect(computeBillCryptoCost(1500, 1500)).toBe(1);
      expect(computeBillCryptoCost(3000, 1500)).toBe(2);
      expect(computeBillCryptoCost(0, 1500)).toBe(0);
      expect(computeBillCryptoCost(1500, null)).toBe(0);
      expect(computeBillCryptoCost(1500, 0)).toBe(0);
    });

    it('locks crypto amount to 7 decimals for Linq manual deposit match', () => {
      // 1000 / 1450 = 0.6896551724...
      const locked = lockBillAmountStableCoin(1000, 1450);
      expect(locked).toBe(0.6896552);
      expect(String(locked).split('.')[1]?.length ?? 0).toBeLessThanOrEqual(7);
    });

    it('evaluates canContinueBillForm accurately', () => {
      expect(
        canContinueBillForm({ customerValid: true, amountNgn: 1000, rateState: 'ready' }),
      ).toBe(true);
      expect(
        canContinueBillForm({ customerValid: false, amountNgn: 1000, rateState: 'ready' }),
      ).toBe(false);
      expect(
        canContinueBillForm({ customerValid: true, amountNgn: 0, rateState: 'ready' }),
      ).toBe(false);
      expect(
        canContinueBillForm({ customerValid: true, amountNgn: 1000, rateState: 'loading' }),
      ).toBe(false);
      expect(
        canContinueBillForm({ customerValid: true, amountNgn: 1000, rateState: 'failed' }),
      ).toBe(false);
    });

    it('classifies poll statuses', () => {
      expect(classifyBillPollStatus('completed')).toBe('done');
      expect(classifyBillPollStatus('complete')).toBe('done');
      expect(classifyBillPollStatus('success')).toBe('done');
      expect(classifyBillPollStatus('delivered')).toBe('done');
      expect(classifyBillPollStatus('failed')).toBe('failed');
      expect(classifyBillPollStatus('refunded')).toBe('failed');
      expect(classifyBillPollStatus('reversed')).toBe('failed');
      expect(classifyBillPollStatus('cancelled')).toBe('failed');
      expect(classifyBillPollStatus('pending')).toBe('pending');
      expect(classifyBillPollStatus('initiated')).toBe('pending');
    });
  });

  describe('executeBillPayment invariants', () => {
    it('reserves order first, then spends the exact locked stablecoin amount to order.wallet', async () => {
      const mockOrder: BillOrder = {
        id: 'ord_res_123',
        customerRef: 'usr_test',
        wallet: 'GDXYZ_LINQ_DEPOSIT_WALLET',
        status: 'initiated',
      };

      const mockPayBill = jest.fn().mockResolvedValue(mockOrder);
      const mockSpendAsset = jest.fn().mockResolvedValue('0x_tx_hash_abc');
      const mockDeploy = jest.fn();

      const onOrderReserved = jest.fn();
      const onBeforePasskey = jest.fn();
      const onAfterPasskey = jest.fn();

      const result = await executeBillPayment({
        customerRef: 'usr_test',
        billCategory: 'electricity',
        provider: 'IKEDC',
        customerId: '014256789012',
        amountNgn: 5000,
        rate: 1450,
        coin: 'usdc',
        refundAddress: 'G_REFUND_WALLET',
        deploy: mockDeploy,
        onOrderReserved,
        onBeforePasskey,
        onAfterPasskey,
        payBillFn: mockPayBill,
        spendAssetFn: mockSpendAsset,
      });

      // 1. payBill called with parameters
      expect(mockPayBill).toHaveBeenCalledWith({
        customerRef: 'usr_test',
        billCategory: 'electricity',
        provider: 'IKEDC',
        customerId: '014256789012',
        amountNgn: 5000,
        amountStableCoin: 3.4482759,
        rate: 1450,
        coin: 'usdc',
        refundAddress: 'G_REFUND_WALLET',
      });

      // Callback notified of reservation before spend
      expect(onOrderReserved).toHaveBeenCalledWith(mockOrder, 3.4482759);

      // 2. spendAsset called with order's wallet and exact locked amount
      expect(mockSpendAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'GDXYZ_LINQ_DEPOSIT_WALLET',
          amount: '3.4482759',
        }),
      );

      expect(onBeforePasskey).toHaveBeenCalled();
      expect(onAfterPasskey).toHaveBeenCalled();
      expect(result.order).toBe(mockOrder);
      expect(result.amountStableCoin).toBe(3.4482759);
      expect(result.txHash).toBe('0x_tx_hash_abc');
    });

    it('does NOT call spendAsset if order reservation fails', async () => {
      const mockPayBill = jest.fn().mockRejectedValue(new Error('Reservation failed'));
      const mockSpendAsset = jest.fn();
      const mockDeploy = jest.fn();

      await expect(
        executeBillPayment({
          customerRef: 'usr_test',
          billCategory: 'electricity',
          provider: 'IKEDC',
          customerId: '014256789012',
          amountNgn: 5000,
          rate: 1450,
          coin: 'usdc',
          refundAddress: 'G_REFUND_WALLET',
          deploy: mockDeploy,
          payBillFn: mockPayBill,
          spendAssetFn: mockSpendAsset,
        }),
      ).rejects.toThrow('Reservation failed');

      expect(mockSpendAsset).not.toHaveBeenCalled();
    });
  });
});

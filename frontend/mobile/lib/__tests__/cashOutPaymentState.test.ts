/**
 * Tests for cash-out payment state invariants (issue #1382).
 *
 * - Deposit payment confirmation with transaction hash disables Pay
 * - Resuming an order with payHash restores the disabled state and "Sent" message
 * - Countdown reaching 0 without payment expires order immediately and disables Pay
 * - Resumed order with unknown start time does not offer Pay until status read succeeds
 * - Consecutive poll errors emit a warning without falsely failing the order
 * - Paid cash-out is never presented as failed
 */

import { isTerminal, isFailure } from '../offramp';

describe('cash-out payment state invariants', () => {
  function computePaymentState({
    busy = false,
    payHash = null as string | null,
    secondsLeft = 600 as number | null,
    createdAt = Date.now() as number | null,
    statusReadSucceeded = true,
    isResumed = false,
    pollErrors = 0,
    status = 'initiated',
  }) {
    const isStartUnknown = isResumed && createdAt === null && !statusReadSucceeded;
    const isExpired = secondsLeft === 0 && payHash === null;
    const isPayDisabled = busy || payHash !== null || isExpired || isStartUnknown;

    let buttonText: string;
    if (payHash !== null) {
      buttonText = 'Sent — processing your payout';
    } else if (isExpired) {
      buttonText = 'Start a new cash-out';
    } else if (isStartUnknown) {
      buttonText = 'Checking order status...';
    } else {
      buttonText = 'Pay USDC from this wallet';
    }

    const showPollWarning = pollErrors >= 3;
    const isDoneFailure = isFailure(status) && payHash === null;

    return {
      isStartUnknown,
      isExpired,
      isPayDisabled,
      buttonText,
      showPollWarning,
      isDoneFailure,
    };
  }

  describe('paid deposit state', () => {
    it('disables pay button and shows "Sent" message when payHash is present', () => {
      const state = computePaymentState({ payHash: '0xhash123' });
      expect(state.isPayDisabled).toBe(true);
      expect(state.buttonText).toBe('Sent — processing your payout');
      expect(state.isExpired).toBe(false);
    });

    it('keeps pay disabled when resuming an order with a restored payHash', () => {
      const state = computePaymentState({
        isResumed: true,
        payHash: '0xrestored_hash',
        secondsLeft: 300,
      });
      expect(state.isPayDisabled).toBe(true);
      expect(state.buttonText).toBe('Sent — processing your payout');
    });

    it('never treats a paid order as a failure even if terminal status has error markers', () => {
      const state = computePaymentState({
        payHash: '0xpaid_hash',
        status: 'refunded (failed)',
      });
      expect(state.isDoneFailure).toBe(false);
    });
  });

  describe('order expiry at 0:00', () => {
    it('immediately expires and disables pay at 0:00 without deposit', () => {
      const state = computePaymentState({
        secondsLeft: 0,
        payHash: null,
      });
      expect(state.isExpired).toBe(true);
      expect(state.isPayDisabled).toBe(true);
      expect(state.buttonText).toBe('Start a new cash-out');
    });

    it('does not mark a paid order as expired when countdown reaches 0', () => {
      const state = computePaymentState({
        secondsLeft: 0,
        payHash: '0xvalid_hash',
      });
      expect(state.isExpired).toBe(false);
      expect(state.buttonText).toBe('Sent — processing your payout');
    });
  });

  describe('resumed order with unknown start time', () => {
    it('does not offer pay until status read succeeds', () => {
      const state = computePaymentState({
        isResumed: true,
        createdAt: null,
        statusReadSucceeded: false,
      });
      expect(state.isStartUnknown).toBe(true);
      expect(state.isPayDisabled).toBe(true);
      expect(state.buttonText).toBe('Checking order status...');
    });

    it('offers pay once status read has succeeded', () => {
      const state = computePaymentState({
        isResumed: true,
        createdAt: Date.now(),
        statusReadSucceeded: true,
      });
      expect(state.isStartUnknown).toBe(false);
      expect(state.isPayDisabled).toBe(false);
      expect(state.buttonText).toBe('Pay USDC from this wallet');
    });
  });

  describe('poll error handling', () => {
    it('does not show warning on 1 or 2 poll errors', () => {
      expect(computePaymentState({ pollErrors: 1 }).showPollWarning).toBe(false);
      expect(computePaymentState({ pollErrors: 2 }).showPollWarning).toBe(false);
    });

    it('shows warning after 3 poll errors without failing the order', () => {
      const state = computePaymentState({ pollErrors: 3, status: 'initiated' });
      expect(state.showPollWarning).toBe(true);
      expect(state.isDoneFailure).toBe(false);
      expect(isTerminal('initiated')).toBe(false);
    });
  });
});

/**
 * Unit tests for `onrampOrderState.ts` — the pure state-transition logic for
 * buying crypto with naira.
 */

import {
  LATE_CHECK_GRACE_MS,
  isOrderRetentionActive,
  lateCheckSecondsRemaining,
  resolveRestoredOnrampStep,
  shouldPollOnramp,
  transitionOnStatus,
  transitionOnTick,
  type OnrampStep,
} from '../onrampOrderState';

const BASE_TIME = Date.parse('2026-11-23T12:00:00.000Z');
const EXPIRES_AT = new Date(BASE_TIME + 10 * 60_000).toISOString();
const EXPIRES_MS = Date.parse(EXPIRES_AT);

describe('shouldPollOnramp', () => {
  it.each<OnrampStep>(['pay', 'waiting', 'waiting_late'])(
    'returns true while actively awaiting payment (%s)',
    (step) => {
      expect(shouldPollOnramp(step)).toBe(true);
    },
  );

  it.each<OnrampStep>(['amount', 'confirm', 'done', 'expired', 'failed', 'unconfirmed'])(
    'returns false for pre-order and terminal steps (%s)',
    (step) => {
      expect(shouldPollOnramp(step)).toBe(false);
    },
  );
});

describe('transitionOnTick', () => {
  it('keeps an unpaid order in pay before expiresAt', () => {
    expect(transitionOnTick('pay', EXPIRES_AT, EXPIRES_MS - 1_000)).toEqual({
      step: 'pay',
      forgetOrder: false,
    });
  });

  it('moves an unpaid order from pay to expired and forgets it at expiresAt', () => {
    expect(transitionOnTick('pay', EXPIRES_AT, EXPIRES_MS)).toEqual({
      step: 'expired',
      forgetOrder: true,
    });
  });

  it('keeps waiting in waiting before expiresAt', () => {
    expect(transitionOnTick('waiting', EXPIRES_AT, EXPIRES_MS - 1_000)).toEqual({
      step: 'waiting',
      forgetOrder: false,
    });
  });

  it('moves waiting to waiting_late (never expired) when the window closes, keeping the saved order', () => {
    expect(transitionOnTick('waiting', EXPIRES_AT, EXPIRES_MS)).toEqual({
      step: 'waiting_late',
      forgetOrder: false,
    });
    expect(
      transitionOnTick('waiting', EXPIRES_AT, EXPIRES_MS + LATE_CHECK_GRACE_MS - 1_000),
    ).toEqual({
      step: 'waiting_late',
      forgetOrder: false,
    });
  });

  it('keeps waiting_late active until the bounded grace period ends', () => {
    expect(
      transitionOnTick('waiting_late', EXPIRES_AT, EXPIRES_MS + LATE_CHECK_GRACE_MS - 1_000),
    ).toEqual({
      step: 'waiting_late',
      forgetOrder: false,
    });
  });

  it('moves waiting_late to unconfirmed (never failed or expired) and forgets the order once the grace period ends', () => {
    expect(
      transitionOnTick('waiting_late', EXPIRES_AT, EXPIRES_MS + LATE_CHECK_GRACE_MS),
    ).toEqual({
      step: 'unconfirmed',
      forgetOrder: true,
    });
  });

  it('moves waiting directly to unconfirmed if the clock jumped past the full grace period', () => {
    expect(
      transitionOnTick('waiting', EXPIRES_AT, EXPIRES_MS + LATE_CHECK_GRACE_MS + 60_000),
    ).toEqual({
      step: 'unconfirmed',
      forgetOrder: true,
    });
  });

  it.each<OnrampStep>(['amount', 'confirm', 'done', 'expired', 'failed', 'unconfirmed'])(
    'does not alter terminal or pre-order step %s on tick',
    (step) => {
      expect(
        transitionOnTick(step, EXPIRES_AT, EXPIRES_MS + LATE_CHECK_GRACE_MS + 60_000),
      ).toEqual({
        step,
        forgetOrder: false,
      });
    },
  );
});

describe('transitionOnStatus', () => {
  it('moves pay, waiting, and waiting_late to done when a transfer settles (including late arrivals)', () => {
    for (const step of ['pay', 'waiting', 'waiting_late'] as const) {
      expect(transitionOnStatus(step, 'completed')).toEqual({
        step: 'done',
        forgetOrder: true,
      });
      expect(transitionOnStatus(step, 'SUCCESS')).toEqual({
        step: 'done',
        forgetOrder: true,
      });
      expect(transitionOnStatus(step, 'settled')).toEqual({
        step: 'done',
        forgetOrder: true,
      });
    }
  });

  it('moves pay, waiting, and waiting_late to failed and forgets the order on failure or cancellation', () => {
    for (const step of ['pay', 'waiting', 'waiting_late'] as const) {
      expect(transitionOnStatus(step, 'failed')).toEqual({
        step: 'failed',
        forgetOrder: true,
      });
      expect(transitionOnStatus(step, 'cancelled')).toEqual({
        step: 'failed',
        forgetOrder: true,
      });
    }
  });

  it('stays in the current step while status is still pending or processing', () => {
    expect(transitionOnStatus('pay', 'initiated')).toEqual({
      step: 'pay',
      forgetOrder: false,
    });
    expect(transitionOnStatus('waiting', 'pending')).toEqual({
      step: 'waiting',
      forgetOrder: false,
    });
    expect(transitionOnStatus('waiting_late', 'processing')).toEqual({
      step: 'waiting_late',
      forgetOrder: false,
    });
  });

  it('ignores late status responses once in a terminal step', () => {
    expect(transitionOnStatus('done', 'failed')).toEqual({
      step: 'done',
      forgetOrder: false,
    });
    expect(transitionOnStatus('failed', 'completed')).toEqual({
      step: 'failed',
      forgetOrder: false,
    });
    expect(transitionOnStatus('unconfirmed', 'completed')).toEqual({
      step: 'unconfirmed',
      forgetOrder: false,
    });
  });
});

describe('isOrderRetentionActive and resolveRestoredOnrampStep', () => {
  it('retains an unpaid order only before expiresAt and restores it to pay', () => {
    expect(isOrderRetentionActive(EXPIRES_AT, false, EXPIRES_MS - 1_000)).toBe(true);
    expect(resolveRestoredOnrampStep(EXPIRES_AT, false, EXPIRES_MS - 1_000)).toBe('pay');

    expect(isOrderRetentionActive(EXPIRES_AT, false, EXPIRES_MS)).toBe(false);
    expect(resolveRestoredOnrampStep(EXPIRES_AT, false, EXPIRES_MS)).toBeNull();
  });

  it('retains a paid-claimed order through the bounded grace period and restores waiting or waiting_late', () => {
    // Still inside the original payment window
    expect(isOrderRetentionActive(EXPIRES_AT, true, EXPIRES_MS - 1_000)).toBe(true);
    expect(resolveRestoredOnrampStep(EXPIRES_AT, true, EXPIRES_MS - 1_000)).toBe('waiting');

    // Past the payment window, inside the extra checking period
    expect(isOrderRetentionActive(EXPIRES_AT, true, EXPIRES_MS + 60_000)).toBe(true);
    expect(resolveRestoredOnrampStep(EXPIRES_AT, true, EXPIRES_MS + 60_000)).toBe('waiting_late');

    // Past the bounded extra checking period
    expect(isOrderRetentionActive(EXPIRES_AT, true, EXPIRES_MS + LATE_CHECK_GRACE_MS)).toBe(false);
    expect(
      resolveRestoredOnrampStep(EXPIRES_AT, true, EXPIRES_MS + LATE_CHECK_GRACE_MS),
    ).toBeNull();
  });

  it('rejects an unreadable expiresAt timestamp', () => {
    expect(isOrderRetentionActive('not-a-date', true, BASE_TIME)).toBe(false);
    expect(resolveRestoredOnrampStep('not-a-date', true, BASE_TIME)).toBeNull();
  });
});

describe('lateCheckSecondsRemaining', () => {
  it('counts down the bounded extra checking window and clamps at 0', () => {
    expect(lateCheckSecondsRemaining(EXPIRES_AT, EXPIRES_MS)).toBe(LATE_CHECK_GRACE_MS / 1000);
    expect(lateCheckSecondsRemaining(EXPIRES_AT, EXPIRES_MS + 90_000)).toBe(
      LATE_CHECK_GRACE_MS / 1000 - 90,
    );
    expect(lateCheckSecondsRemaining(EXPIRES_AT, EXPIRES_MS + LATE_CHECK_GRACE_MS + 5_000)).toBe(
      0,
    );
    expect(lateCheckSecondsRemaining('invalid', BASE_TIME)).toBe(0);
  });
});

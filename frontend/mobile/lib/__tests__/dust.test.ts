import {
  DUST_AMOUNT_LABEL,
  DUST_THRESHOLD,
  formatDisplayAmount,
  isDustAmount,
  isDustRecord,
} from '../dust';

describe('isDustAmount', () => {
  it('flags zero and sub-threshold amounts as dust', () => {
    expect(isDustAmount(0)).toBe(true);
    expect(isDustAmount('0')).toBe(true);
    expect(isDustAmount('0.0000001')).toBe(true); // 1 stroop
    expect(isDustAmount(0.0000001)).toBe(true);
    expect(isDustAmount('0.0000499')).toBe(true); // just below threshold
    expect(isDustAmount(DUST_THRESHOLD - 1e-7)).toBe(true);
  });

  it('does not flag amounts at or above the threshold', () => {
    expect(isDustAmount(DUST_THRESHOLD)).toBe(false); // 0.00005 -> rounds to 0.0001
    expect(isDustAmount('0.00005')).toBe(false);
    expect(isDustAmount('0.0001')).toBe(false);
    expect(isDustAmount(0.0001)).toBe(false);
    expect(isDustAmount('1,234.5678')).toBe(false);
    expect(isDustAmount('25')).toBe(false);
  });

  it('does not treat missing or unreadable values as dust', () => {
    expect(isDustAmount(undefined)).toBe(false);
    expect(isDustAmount(null)).toBe(false);
    expect(isDustAmount('')).toBe(false);
    expect(isDustAmount('   ')).toBe(false);
    expect(isDustAmount('not-a-number')).toBe(false);
    expect(isDustAmount(Number.NaN)).toBe(false);
    expect(isDustAmount(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('isDustRecord', () => {
  it('prefers explicit isDust flag when present', () => {
    expect(isDustRecord({ amount: '0', isDust: true })).toBe(true);
    expect(isDustRecord({ amount: '0.0001', isDust: false })).toBe(false);
  });

  it('falls back to amount string when isDust is omitted', () => {
    expect(isDustRecord({ amount: '0' })).toBe(true);
    expect(isDustRecord({ amount: '0.0000001' })).toBe(true);
    expect(isDustRecord({ amount: '0.0001' })).toBe(false);
    expect(isDustRecord({ amount: '1,000' })).toBe(false);
  });
});

describe('formatDisplayAmount', () => {
  it('shows quiet dust label for any asset', () => {
    expect(formatDisplayAmount({ amount: '0', asset: 'XLM', isDust: true })).toBe(
      `${DUST_AMOUNT_LABEL} XLM`,
    );
    expect(formatDisplayAmount({ amount: '0', asset: 'USDC', isDust: true })).toBe(
      `${DUST_AMOUNT_LABEL} USDC`,
    );
    expect(formatDisplayAmount({ amount: '0', asset: 'EURC' })).toBe(
      `${DUST_AMOUNT_LABEL} EURC`,
    );
  });

  it('preserves normal formatting for real payments of 0.0001 or more', () => {
    expect(formatDisplayAmount({ amount: '0.0001', asset: 'XLM', isDust: false })).toBe(
      '0.0001 XLM',
    );
    expect(formatDisplayAmount({ amount: '12.5', asset: 'USDC', isDust: false })).toBe(
      '12.5 USDC',
    );
  });

  it('does not apply the dust label to swap rows', () => {
    expect(
      formatDisplayAmount({ type: 'swapped', amount: '0', asset: 'XLM', isDust: true }),
    ).toBe('0 XLM');
  });
});

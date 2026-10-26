import { consumeCashOutHandoff, setCashOutHandoff } from '../cashOutHandoff';

describe('cash-out hand-off', () => {
  it('keeps only the amount and rate in memory and consumes them once', () => {
    setCashOutHandoff({ amountNGN: 25_000, rate: 1_500 });

    expect(consumeCashOutHandoff()).toEqual({ amountNGN: 25_000, rate: 1_500 });
    expect(consumeCashOutHandoff()).toBeNull();
  });
});

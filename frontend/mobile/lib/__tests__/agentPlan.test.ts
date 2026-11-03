import { realizedOutputAmount } from '../agentPlan';

describe('realizedOutputAmount', () => {
  it('uses the observed output delta, not the plan or quote estimate', () => {
    expect(realizedOutputAmount(12.5, 17.2345678)).toBe('4.7345678');
  });

  it('does not produce a next-step amount when no positive output is observed', () => {
    expect(realizedOutputAmount(12.5, 12.5)).toBeNull();
    expect(realizedOutputAmount(12.5, 12.4)).toBeNull();
  });

  it('rejects invalid balances', () => {
    expect(realizedOutputAmount(Number.NaN, 1)).toBeNull();
  });
});

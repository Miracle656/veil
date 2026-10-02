import { planDeposit } from '../depositPlan';

describe('planDeposit', () => {
  it('needs no move when the spending account covers it', () => {
    expect(planDeposit({ amount: 5, inSpending: 5, inWallet: 0 })).toEqual({ kind: 'ready' });
  });

  it('moves exactly the shortfall from the smart wallet', () => {
    expect(planDeposit({ amount: 10, inSpending: 1.5, inWallet: 30 })).toEqual({
      kind: 'move',
      amount: '8.5000000',
    });
  });

  it('does not lose a stroop to floating point', () => {
    // 0.1 + 0.2 style inputs must not round the move down below the shortfall.
    expect(planDeposit({ amount: 0.3, inSpending: 0.1, inWallet: 0.2 })).toEqual({
      kind: 'move',
      amount: '0.2000000',
    });
  });

  it('refuses, and reports the combined total, when both accounts are short', () => {
    expect(planDeposit({ amount: 50, inSpending: 2, inWallet: 30 })).toEqual({
      kind: 'short',
      available: 32,
    });
  });

  it('treats a negative spendable figure as nothing', () => {
    expect(planDeposit({ amount: 1, inSpending: -0.4, inWallet: 1 })).toEqual({
      kind: 'move',
      amount: '1.0000000',
    });
  });
});

let mockNetworkName = 'mainnet';

jest.mock('../network', () => ({
  getNetwork: () => ({ name: mockNetworkName }),
}));

import {
  assessFeePayerFunding,
  feeBidXlm,
  formatFundingXlm,
  inclusionFee,
  MAINNET_FEE_BID,
  requiredFeePayerXlm,
  requiredReserveXlm,
} from '../fees';

describe('inclusionFee', () => {
  it('bids 0.01 XLM on mainnet: above the market, but affordable', () => {
    mockNetworkName = 'mainnet';
    expect(inclusionFee()).toBe(MAINNET_FEE_BID);
    expect(feeBidXlm()).toBe(0.01);
  });

  it('never bids 0.1 XLM again, which demanded 0.1 XLM spare in every account', () => {
    mockNetworkName = 'mainnet';
    expect(Number(inclusionFee())).toBeLessThan(1_000_000);
  });

  it('keeps the minimum on testnet', () => {
    mockNetworkName = 'testnet';
    expect(inclusionFee()).toBe('100');
  });
});

describe('assessFeePayerFunding — the three banner states (V193 / #766)', () => {
  it('raises the banner for a missing account with a concrete amount', () => {
    const assessed = assessFeePayerFunding({ exists: false });
    expect(assessed.status).toBe('missing');
    expect(assessed.balance).toBe(0);
    expect(assessed.reserve).toBe(requiredReserveXlm(0));
    expect(assessed.needed).toBe(requiredFeePayerXlm(0));
    // The banner names a concrete amount, not "some XLM".
    expect(assessed.needed).toBeCloseTo(1.05, 5);
    expect(assessed.shortfall).toBeCloseTo(1.05, 5);
    expect(formatFundingXlm(assessed.needed)).toBe('1.05 XLM');
  });

  it('raises the banner for a funded-but-too-low account', () => {
    // 4 XLM with 4 subentries locks (2 + 4) × 0.5 = 3 XLM reserve; with the
    // 0.05 fee buffer the account needs 3.05 but the spendable logic behind
    // the banner is the same reserve the swap screen explains.
    const assessed = assessFeePayerFunding({ exists: true, balance: 1.0, subentries: 0 });
    expect(assessed.status).toBe('underfunded');
    expect(assessed.needed).toBeCloseTo(1.05, 5);
    expect(assessed.shortfall).toBeCloseTo(0.05, 5);
    expect(formatFundingXlm(assessed.shortfall)).toContain('XLM');
    expect(formatFundingXlm(assessed.shortfall)).not.toMatch(/some/i);
  });

  it('does not raise the banner for a healthy account', () => {
    const assessed = assessFeePayerFunding({ exists: true, balance: 5, subentries: 2 });
    expect(assessed.status).toBe('healthy');
    expect(assessed.shortfall).toBe(0);
    // (2 + 2) × 0.5 reserve + 0.05 buffer = 2.05 needed.
    expect(assessed.needed).toBeCloseTo(2.05, 5);
  });

  it('counts selling liabilities against the balance', () => {
    const assessed = assessFeePayerFunding({
      exists: true,
      balance: 2,
      subentries: 0,
      sellingLiabilities: 1.5,
    });
    // Effective 0.5 < 1.05 needed.
    expect(assessed.status).toBe('underfunded');
  });

  it('treats exactly-funded as healthy', () => {
    const needed = requiredFeePayerXlm(1);
    const assessed = assessFeePayerFunding({ exists: true, balance: needed, subentries: 1 });
    expect(assessed.status).toBe('healthy');
  });
});

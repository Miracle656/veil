import {
  calculateAccountReserve,
  calculateSpendableAfterTrustline,
  spendableNativeXlm,
  TRUSTLINE_TX_FEE_BUFFER_XLM,
  TRUSTLINE_RESERVE_COST_XLM,
  TRUSTLINE_RESERVE_EXPLANATION,
} from '../reserves';

describe('Account Reserve Calculation & Explanation (Issue #824)', () => {
  it('correctly calculates reserve for an account with zero trustlines/subentries', () => {
    const account = {
      subentry_count: 0,
      balances: [{ asset_type: 'native', balance: '10.0000000' }],
    };

    const reserve = calculateAccountReserve(account);

    expect(reserve.totalBalance).toBe(10);
    expect(reserve.subentries).toBe(0);
    expect(reserve.baseAccountReserve).toBe(1.0);
    expect(reserve.subentryReserve).toBe(0.0);
    expect(reserve.totalReserve).toBe(1.0);
    expect(reserve.spendable).toBe('9.0000000');
    expect(reserve.reason).toContain('1.0 XLM locked for account base reserve');
  });

  it('correctly calculates reserve for an account with one trustline/subentry', () => {
    const account = {
      subentry_count: 1,
      balances: [
        { asset_type: 'native', balance: '10.0000000' },
        { asset_type: 'credit_alphanum4', balance: '5.0000000' },
      ],
    };

    const reserve = calculateAccountReserve(account);

    expect(reserve.totalBalance).toBe(10);
    expect(reserve.subentries).toBe(1);
    expect(reserve.baseAccountReserve).toBe(1.0);
    expect(reserve.subentryReserve).toBe(0.5);
    expect(reserve.totalReserve).toBe(1.5);
    expect(reserve.spendable).toBe('8.5000000');
    expect(reserve.reason).toContain('1.5 XLM locked: 1.0 XLM account base reserve + 0.5 XLM for 1 trustline/subentry');
    expect(reserve.reason).toContain('locked, not spent — released if removed');
  });

  it('correctly calculates reserve for an account with several trustlines/subentries', () => {
    // 3 subentries (e.g. USDC, USDT0, and a data entry)
    const account = {
      subentry_count: 3,
      balances: [
        { asset_type: 'native', balance: '10.0000000' },
        { asset_type: 'credit_alphanum4', balance: '5.0000000' },
        { asset_type: 'credit_alphanum12', balance: '20.0000000' },
      ],
    };

    const reserve = calculateAccountReserve(account);

    expect(reserve.totalBalance).toBe(10);
    expect(reserve.subentries).toBe(3);
    expect(reserve.baseAccountReserve).toBe(1.0);
    expect(reserve.subentryReserve).toBe(1.5); // 3 * 0.5
    expect(reserve.totalReserve).toBe(2.5); // (2 + 3) * 0.5
    expect(reserve.spendable).toBe('7.5000000');
    expect(reserve.reason).toContain('2.5 XLM locked: 1.0 XLM account base reserve + 1.5 XLM for 3 trustlines/subentries');
    expect(reserve.reason).toContain('locked, not spent — released if removed');
  });

  it('accounts for DEX selling liabilities when determining spendable balance', () => {
    const account = {
      subentry_count: 2,
      balances: [
        { asset_type: 'native', balance: '10.0000000', selling_liabilities: '2.0000000' },
      ],
    };

    const reserve = calculateAccountReserve(account);

    expect(reserve.totalReserve).toBe(2.0); // (2 + 2) * 0.5
    // 10 - 2.0 (reserve) - 2.0 (liabilities) = 6.0
    expect(reserve.spendable).toBe('6.0000000');
  });

  it('provides constant trustline reserve cost and standard explanation', () => {
    expect(TRUSTLINE_RESERVE_COST_XLM).toBe(0.5);
    expect(TRUSTLINE_RESERVE_EXPLANATION).toContain('locks 0.5 XLM');
    expect(TRUSTLINE_RESERVE_EXPLANATION).toContain('locked, not spent');
    expect(TRUSTLINE_RESERVE_EXPLANATION).toContain('released back to your available balance');
  });
});

describe('calculateSpendableAfterTrustline', () => {
  it('deducts one trustline reserve from spendable XLM', () => {
    const impact = calculateSpendableAfterTrustline('3.5000000', 1);
    expect(impact.reserveCost).toBe(TRUSTLINE_RESERVE_COST_XLM);
    expect(impact.currentSpendable).toBe(3.5);
    expect(impact.projectedSpendable).toBe(3.0);
    expect(impact.canAfford).toBe(true);
  });

  it('scales the reserve with the number of trustlines', () => {
    const impact = calculateSpendableAfterTrustline(5, 3);
    expect(impact.reserveCost).toBe(3 * TRUSTLINE_RESERVE_COST_XLM);
    expect(impact.projectedSpendable).toBe(3.5);
  });

  it('flags canAfford as false when spendable XLM is below the reserve', () => {
    const impact = calculateSpendableAfterTrustline('0.3000000', 1);
    expect(impact.projectedSpendable).toBe(0);
    expect(impact.canAfford).toBe(false);
  });

  it('does not report canAfford at exactly the reserve: the fee must be payable too', () => {
    const exactlyReserve = calculateSpendableAfterTrustline(TRUSTLINE_RESERVE_COST_XLM, 1);
    expect(exactlyReserve.canAfford).toBe(false);

    const reservePlusFee = calculateSpendableAfterTrustline(
      TRUSTLINE_RESERVE_COST_XLM + TRUSTLINE_TX_FEE_BUFFER_XLM,
      1,
    );
    expect(reservePlusFee.canAfford).toBe(true);
  });

  it('treats an unparseable balance as zero', () => {
    const impact = calculateSpendableAfterTrustline('not-a-number', 1);
    expect(impact.currentSpendable).toBe(0);
    expect(impact.canAfford).toBe(false);
  });
});

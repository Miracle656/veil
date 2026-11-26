import {
  calculateAccountReserve,
  spendableNativeXlm,
  TRUSTLINE_RESERVE_COST_XLM,
  TRUSTLINE_RESERVE_EXPLANATION,
} from '../reserves';

describe('Mobile Reserve Calculations & Explanations (Issue #824)', () => {
  it('correctly calculates reserve for an account with zero trustlines/subentries', () => {
    const account = {
      subentry_count: 0,
      balances: [{ asset_type: 'native', balance: '12.0000000' }],
    };

    const res = calculateAccountReserve(account);
    expect(res.subentries).toBe(0);
    expect(res.baseAccountReserve).toBe(1.0);
    expect(res.subentryReserve).toBe(0.0);
    expect(res.totalReserve).toBe(1.0);
    expect(res.spendable).toBe('11.0000000');
    expect(res.reason).toContain('1.0 XLM locked for account base reserve');
  });

  it('correctly calculates reserve for an account with one trustline/subentry', () => {
    const account = {
      subentry_count: 1,
      balances: [
        { asset_type: 'native', balance: '12.0000000' },
        { asset_type: 'credit_alphanum4', balance: '10.0000000' },
      ],
    };

    const res = calculateAccountReserve(account);
    expect(res.subentries).toBe(1);
    expect(res.baseAccountReserve).toBe(1.0);
    expect(res.subentryReserve).toBe(0.5);
    expect(res.totalReserve).toBe(1.5);
    expect(res.spendable).toBe('10.5000000');
    expect(res.reason).toContain('1.5 XLM locked: 1.0 XLM account base reserve + 0.5 XLM for 1 trustline/subentry');
    expect(res.reason).toContain('locked, not spent — released if removed');
  });

  it('correctly calculates reserve for an account with several trustlines/subentries', () => {
    const account = {
      subentry_count: 3,
      balances: [
        { asset_type: 'native', balance: '20.0000000' },
        { asset_type: 'credit_alphanum4', balance: '10.0000000' },
        { asset_type: 'credit_alphanum12', balance: '5.0000000' },
      ],
    };

    const res = calculateAccountReserve(account);
    expect(res.subentries).toBe(3);
    expect(res.baseAccountReserve).toBe(1.0);
    expect(res.subentryReserve).toBe(1.5);
    expect(res.totalReserve).toBe(2.5);
    expect(res.spendable).toBe('17.5000000');
    expect(res.reason).toContain('2.5 XLM locked: 1.0 XLM account base reserve + 1.5 XLM for 3 trustlines/subentries');
    expect(res.reason).toContain('locked, not spent — released if removed');
  });

  it('provides constant 0.5 XLM cost and standard disclosure explanation', () => {
    expect(TRUSTLINE_RESERVE_COST_XLM).toBe(0.5);
    expect(TRUSTLINE_RESERVE_EXPLANATION).toMatch(/0\.5 XLM/);
    expect(TRUSTLINE_RESERVE_EXPLANATION).toMatch(/locked, not spent/);
    expect(TRUSTLINE_RESERVE_EXPLANATION).toMatch(/released/i);
  });
});

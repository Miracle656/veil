const mockGetSignerSecret = jest.fn();
const mockGetNetwork = jest.fn();

jest.mock('../walletStore', () => ({
  getSignerSecret: (...a: unknown[]) => mockGetSignerSecret(...a),
}));
jest.mock('../network', () => ({
  getNetwork: (...a: unknown[]) => mockGetNetwork(...a),
}));

import { Horizon, Keypair } from '@stellar/stellar-sdk';

import {
  assessFeePayerFunding,
  assertFeePayerCanCoverFee,
  checkFeePayerFunding,
  FeePayerNotFunded,
  FeePayerShort,
  feePayerMinimumXlm,
  queryFeePayerBalance,
  requiredFeePayerXlm,
  requiredReserveXlm,
} from '../feePayerCheck';
import { formatFundingXlm } from '../fees';

const G_ADDR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('feePayerCheck', () => {
  let mockLoadAccount: jest.SpyInstance;

  beforeEach(() => {
    jest.resetAllMocks();
    mockGetNetwork.mockReturnValue({
      name: 'mainnet',
      horizonUrl: 'https://horizon.stellar.org',
    });
    mockGetSignerSecret.mockResolvedValue(Keypair.random().secret());
    mockLoadAccount = jest.spyOn(Horizon.Server.prototype, 'loadAccount');
  });

  afterEach(() => {
    mockLoadAccount.mockRestore();
  });

  describe('feePayerMinimumXlm', () => {
    it('returns a positive minimum threshold', () => {
      expect(feePayerMinimumXlm()).toBeGreaterThan(0);
    });
  });

  describe('assertFeePayerCanCoverFee', () => {
    it('throws FeePayerNotFunded if the account is missing (404)', async () => {
      mockLoadAccount.mockRejectedValue({
        response: { status: 404 },
      });

      await expect(assertFeePayerCanCoverFee(G_ADDR)).rejects.toThrow(FeePayerNotFunded);
    });

    it('throws FeePayerShort if the account has insufficient spendable balance', async () => {
      mockLoadAccount.mockResolvedValue({
        subentry_count: 0,
        balances: [
          {
            asset_type: 'native',
            balance: '0.001',
          },
        ],
      });

      await expect(assertFeePayerCanCoverFee(G_ADDR)).rejects.toThrow(FeePayerShort);
    });

    it('passes silently if the account has sufficient spendable balance', async () => {
      mockLoadAccount.mockResolvedValue({
        subentry_count: 0,
        balances: [
          {
            asset_type: 'native',
            balance: '10.0',
          },
        ],
      });

      await expect(assertFeePayerCanCoverFee(G_ADDR)).resolves.toBeUndefined();
    });
  });

  describe('Error messages', () => {
    it('FeePayerNotFunded contains the address and required amount', () => {
      const needed = 0.02;
      const err = new FeePayerNotFunded(G_ADDR, needed);
      expect(err.message).toContain(G_ADDR);
      expect(err.message).toContain(needed.toString());
      expect(err.name).toBe('FeePayerNotFunded');
    });

    it('FeePayerShort contains the address, available amount, and required amount', () => {
      const needed = 0.02;
      const have = 0.005;
      const err = new FeePayerShort(G_ADDR, have, needed);
      expect(err.message).toContain(G_ADDR);
      expect(err.message).toContain(needed.toString());
      expect(err.message).toContain(have.toFixed(7));
      expect(err.name).toBe('FeePayerShort');
    });
  });

  describe('queryFeePayerBalance', () => {
    it('returns the raw balance breakdown and spendable amount in one read', async () => {
      mockLoadAccount.mockResolvedValue({
        subentry_count: 2,
        balances: [
          { asset_type: 'native', balance: '5', selling_liabilities: '0.5' },
        ],
      });

      await expect(queryFeePayerBalance(G_ADDR)).resolves.toEqual({
        exists: true,
        balance: 5,
        subentries: 2,
        reserve: 2,
        sellingLiabilities: 0.5,
        spendableXlm: 2.5,
      });
    });

    it('reports a failed read as unknown (infinite spendable), not empty', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Failed to fetch'));

      await expect(queryFeePayerBalance(G_ADDR)).resolves.toMatchObject({
        exists: true,
        spendableXlm: Number.POSITIVE_INFINITY,
      });
    });
  });

  describe('checkFeePayerFunding — the banner reads the same account as the guard', () => {
    it('reports no-wallet when no fee-payer is stored', async () => {
      mockGetSignerSecret.mockResolvedValue(null);

      await expect(checkFeePayerFunding()).resolves.toEqual({
        status: 'no-wallet',
        feePayerAddress: null,
      });
      expect(mockLoadAccount).not.toHaveBeenCalled();
    });

    it('reports missing for a 404 and names the fee-payer', async () => {
      const secret = Keypair.random().secret();
      const address = Keypair.fromSecret(secret).publicKey();
      mockGetSignerSecret.mockResolvedValue(secret);
      mockLoadAccount.mockRejectedValue({ response: { status: 404 } });

      const result = await checkFeePayerFunding();

      expect(result.status).toBe('missing');
      expect(result.feePayerAddress).toBe(address);
      if (result.status === 'missing') {
        expect(result.needed).toBeCloseTo(1.05, 5);
        expect(result.shortfall).toBeCloseTo(1.05, 5);
      }
    });

    it('reports underfunded from the same reserve maths the guard uses', async () => {
      const secret = Keypair.random().secret();
      const address = Keypair.fromSecret(secret).publicKey();
      mockGetSignerSecret.mockResolvedValue(secret);
      mockLoadAccount.mockResolvedValue({
        subentry_count: 0,
        balances: [{ asset_type: 'native', balance: '1' }],
      });

      const result = await checkFeePayerFunding();

      expect(result.status).toBe('underfunded');
      expect(result.feePayerAddress).toBe(address);
      if (result.status === 'underfunded') {
        expect(result.needed).toBeCloseTo(1.05, 5);
        expect(result.shortfall).toBeCloseTo(0.05, 5);
      }
    });

    it('returns unknown when Horizon cannot be reached, not a false banner', async () => {
      mockLoadAccount.mockRejectedValue(new Error('Failed to fetch'));

      await expect(checkFeePayerFunding()).resolves.toMatchObject({ status: 'unknown' });
    });

    it('returns unknown when the fee-payer secret cannot be read', async () => {
      mockGetSignerSecret.mockRejectedValue(new Error('keychain unavailable'));

      await expect(checkFeePayerFunding()).resolves.toEqual({
        status: 'unknown',
        feePayerAddress: null,
      });
    });
  });
});

describe('assessFeePayerFunding — the three banner states (V193 / #766)', () => {
  it('raises the banner for a missing account with a concrete amount', () => {
    const assessed = assessFeePayerFunding({ exists: false });
    expect(assessed.status).toBe('missing');
    expect(assessed.balance).toBe(0);
    expect(assessed.reserve).toBe(requiredReserveXlm(0));
    expect(assessed.needed).toBe(requiredFeePayerXlm(0));
    expect(assessed.needed).toBeCloseTo(1.05, 5);
    expect(assessed.shortfall).toBeCloseTo(1.05, 5);
    expect(formatFundingXlm(assessed.needed)).toBe('1.05 XLM');
  });

  it('raises the banner for a funded-but-too-low account', () => {
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
    expect(assessed.needed).toBeCloseTo(2.05, 5);
  });

  it('counts selling liabilities against the balance', () => {
    const assessed = assessFeePayerFunding({
      exists: true,
      balance: 2,
      subentries: 0,
      sellingLiabilities: 1.5,
    });
    expect(assessed.status).toBe('underfunded');
  });

  it('treats exactly-funded as healthy', () => {
    const needed = requiredFeePayerXlm(1);
    const assessed = assessFeePayerFunding({ exists: true, balance: needed, subentries: 1 });
    expect(assessed.status).toBe('healthy');
  });
});

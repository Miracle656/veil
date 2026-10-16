import { Horizon } from '@stellar/stellar-sdk';
import {
  assertFeePayerCanCoverFee,
  FeePayerNotFunded,
  FeePayerShort,
  feePayerMinimumXlm,
} from '../feePayerCheck';
import { getNetwork } from '../network';

const G_ADDR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

describe('feePayerCheck', () => {
  let mockLoadAccount: jest.SpyInstance;

  beforeEach(() => {
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
      // 1.5 XLM total, but 2 subentries = 2 * 0.5 = 1 XLM reserve.
      // 1.5 - 1.0 = 0.5 spendable. Assuming feePayerMinimumXlm is higher or we simulate liabilities.
      mockLoadAccount.mockResolvedValue({
        subentry_count: 0,
        balances: [
          {
            asset_type: 'native',
            balance: '0.001', // Very low balance
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
            balance: '10.0', // Plenty of XLM
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
});

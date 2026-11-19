/**
 * Telling a user their spending account dies with the phone, and letting them
 * save its key when nothing else can.
 *
 * Both exist because of one loss: 31.07 USDC on a random-key spending account,
 * gone when the app was uninstalled on 2026-11-14. The app had said nothing on
 * any screen the user visited, and offered no way to take the key off the phone.
 */
import { Keypair } from '@stellar/stellar-sdk';

import { spendingAccountWarning } from '../spendingAccountWarning';

const SMART = 'CCGIA4C7CGUARBWOOY6G2J7FRE6QT77AECCJTOEDQ3SAIWFPFNT55BKK';
const SPENDING = Keypair.random();

const mockGetWalletAddress = jest.fn();
const mockGetSignerSecret = jest.fn();
const mockGetFeePayerInfo = jest.fn();

jest.mock('../walletStore', () => ({
  getWalletAddress: (...a: unknown[]) => mockGetWalletAddress(...a),
  getSignerSecret: (...a: unknown[]) => mockGetSignerSecret(...a),
}));
jest.mock('../feePayerSource', () => ({
  getFeePayerInfo: (...a: unknown[]) => mockGetFeePayerInfo(...a),
}));
jest.mock('expo-local-authentication', () => ({}));

import { resolveSpendingKeyExport } from '../spendingKeyExport';

describe('spendingAccountWarning', () => {
  it('warns, with both ways out, when the spending account is on a random key', () => {
    const warning = spendingAccountWarning(SMART, 'random');
    expect(warning).toMatchObject({ level: 'danger', title: 'This address is not backed up' });
    expect(warning!.secondary).toBe('Save the key instead');
    // It has to say what is at stake in plain words.
    expect(warning!.body).toContain('cannot be recovered');
  });

  it('asks for a check when nobody knows how the account was made', () => {
    expect(spendingAccountWarning(SMART, 'unknown')).toMatchObject({ level: 'check', secondary: null });
  });

  it('says nothing when the passkey can rebuild the account', () => {
    expect(spendingAccountWarning(SMART, 'prf')).toBeNull();
    expect(spendingAccountWarning(SMART, 'credential-id')).toBeNull();
  });

  it('says nothing for a keypair wallet, whose own key is a different subject', () => {
    expect(spendingAccountWarning(SPENDING.publicKey(), 'keypair')).toBeNull();
    expect(spendingAccountWarning(SPENDING.publicKey(), 'random')).toBeNull();
  });

  it('says nothing before there is a wallet', () => {
    expect(spendingAccountWarning(null, null)).toBeNull();
    expect(spendingAccountWarning(SMART, null)).toBeNull();
  });
});

describe('resolveSpendingKeyExport', () => {
  beforeEach(() => {
    mockGetWalletAddress.mockReset().mockResolvedValue(SMART);
    mockGetSignerSecret.mockReset().mockResolvedValue(SPENDING.secret());
    mockGetFeePayerInfo.mockReset().mockResolvedValue({ address: SPENDING.publicKey(), source: 'random' });
  });

  it('reveals the key of a random spending account, with the address it belongs to', async () => {
    await expect(resolveSpendingKeyExport()).resolves.toEqual({
      status: 'revealable',
      address: SPENDING.publicKey(),
      secret: SPENDING.secret(),
    });
  });

  it('does not reveal a key the passkey can rebuild, and does not read it', async () => {
    // Showing it would add a way to lose the money and remove none.
    for (const source of ['prf', 'credential-id'] as const) {
      mockGetSignerSecret.mockClear();
      mockGetFeePayerInfo.mockResolvedValue({ address: SPENDING.publicKey(), source });
      await expect(resolveSpendingKeyExport()).resolves.toEqual({
        status: 'recoverable',
        address: SPENDING.publicKey(),
      });
      expect(mockGetSignerSecret).not.toHaveBeenCalled();
    }
  });

  it('asks for the passkey check first when the source was never recorded', async () => {
    mockGetFeePayerInfo.mockResolvedValue({ address: SPENDING.publicKey(), source: 'unknown' });
    await expect(resolveSpendingKeyExport()).resolves.toEqual({
      status: 'unchecked',
      address: SPENDING.publicKey(),
    });
    expect(mockGetSignerSecret).not.toHaveBeenCalled();
  });

  it('refuses a stored secret that is not the key of the address shown', async () => {
    mockGetSignerSecret.mockResolvedValue(Keypair.random().secret());
    await expect(resolveSpendingKeyExport()).resolves.toEqual({
      status: 'no-secret',
      address: SPENDING.publicKey(),
    });
  });

  it('leaves a keypair wallet to the screen written for it', async () => {
    mockGetWalletAddress.mockResolvedValue(SPENDING.publicKey());
    await expect(resolveSpendingKeyExport()).resolves.toEqual({
      status: 'not-a-smart-wallet',
      address: SPENDING.publicKey(),
    });
  });

  it('has nothing to reveal before a wallet exists', async () => {
    mockGetWalletAddress.mockResolvedValue(null);
    await expect(resolveSpendingKeyExport()).resolves.toEqual({ status: 'no-wallet' });
  });
});

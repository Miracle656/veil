/**
 * Switching a wallet from a random spending key to the passkey-derived one.
 *
 * The switch replaces the stored secret. For a random key that secret is the
 * only copy anywhere, so every test here is about one rule: nothing the old
 * account holds may be left behind a key that is about to be overwritten.
 *
 * Before 2026-11-14 the move carried XLM only and the old secret was simply
 * overwritten. A wallet holding USDC that ran this repair lost the USDC.
 */
import { Keypair } from '@stellar/stellar-sdk';

const PRF_OUTPUT = new Uint8Array(32).fill(7);
const DERIVED = Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT));
const OLD = Keypair.random();
const WALLET = 'CARM3RKO7MDAHVAR7RP3AEMO2GXVHRLA5FSEZD5OE2WARCADCEKGDK62';

const mockEvaluatePrf = jest.fn();
const mockGetSignerSecret = jest.fn();
const mockSetSignerSecret = jest.fn();
const mockRetire = jest.fn();
const mockMigrate = jest.fn();
const mockMayHold = jest.fn();
const mockLoadAccount = jest.fn();
const mockRecordSource = jest.fn();
const calls: string[] = [];

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: jest.fn(() => ({ loadAccount: mockLoadAccount })) },
  };
});
jest.mock('../passkey', () => ({ evaluatePrf: (...a: unknown[]) => mockEvaluatePrf(...a) }));
jest.mock('../classicWallet', () => ({}));
jest.mock('../testnetWallet', () => ({ fundWithFriendbot: jest.fn() }));
jest.mock('../walletBreadcrumbs', () => ({ writeBreadcrumbs: jest.fn(async () => undefined) }));
jest.mock('../sdkStorage', () => ({
  SDK_KEY_ID: 'invisible_wallet_key_id',
  getCredentialId: jest.fn(async () => 'credential-id'),
  getSdkItem: jest.fn(async () => null),
}));
jest.mock('../network', () => ({
  getNetwork: () => ({ horizonUrl: 'https://horizon.example', networkPassphrase: 'Test' }),
}));
jest.mock('../fees', () => ({ inclusionFee: () => '100' }));
jest.mock('../feePayerSource', () => ({
  recordFeePayerSource: (...a: unknown[]) => mockRecordSource(...a),
}));
jest.mock('../feePayerHoldings', () => ({
  mayHoldCollectibles: (...a: unknown[]) => mockMayHold(...a),
}));
jest.mock('../feePayerSweep', () => ({
  defaultSweepDeps: jest.fn(() => ({})),
  migrateFeePayerToPasskey: (...a: unknown[]) => mockMigrate(...a),
}));
jest.mock('../walletStore', () => ({
  getWalletAddress: jest.fn(async () => WALLET),
  getPasskeyPublicKey: jest.fn(async () => null),
  getSignerSecret: (...a: unknown[]) => mockGetSignerSecret(...a),
  setSignerSecret: (...a: unknown[]) => mockSetSignerSecret(...a),
  retireFeePayerSecret: (...a: unknown[]) => mockRetire(...a),
  setWalletAddress: jest.fn(),
  setPasskeyId: jest.fn(),
  setPasskeyCredential: jest.fn(),
}));

import { retryRecoveryBinding } from '../passkeyWallet';

beforeEach(() => {
  calls.length = 0;
  mockEvaluatePrf.mockReset().mockResolvedValue({ outcome: 'ok', output: PRF_OUTPUT });
  mockGetSignerSecret.mockReset().mockResolvedValue(OLD.secret());
  mockSetSignerSecret.mockReset().mockImplementation(async () => {
    calls.push('set');
  });
  mockRetire.mockReset().mockImplementation(async () => {
    calls.push('retire');
  });
  mockMigrate.mockReset().mockImplementation(async () => {
    calls.push('move');
    return { swept: true, amount: '5.2776763', txHash: 'h', from: OLD.publicKey(), to: DERIVED.publicKey() };
  });
  mockMayHold.mockReset().mockResolvedValue(false);
  // The old account exists on the network.
  mockLoadAccount.mockReset().mockResolvedValue({});
  mockRecordSource.mockReset().mockResolvedValue(undefined);
});

it('moves the holdings, keeps the old key, and only then switches', async () => {
  await expect(retryRecoveryBinding()).resolves.toEqual({ bound: true });

  expect(calls).toEqual(['move', 'retire', 'set']);
  expect(mockRetire).toHaveBeenCalledWith(OLD.secret());
  expect(mockSetSignerSecret).toHaveBeenCalledWith(DERIVED.secret());
});

it('gives the move the new account key, so trustline assets can cross', async () => {
  await retryRecoveryBinding();

  expect(mockMigrate.mock.calls[0][0]).toEqual({
    from: OLD.publicKey(),
    fromSecret: OLD.secret(),
    to: DERIVED.publicKey(),
    toSecret: DERIVED.secret(),
  });
});

it('does not switch when the move did not happen', async () => {
  mockMigrate.mockResolvedValue({ swept: false, reason: 'sweep-failed' });

  await expect(retryRecoveryBinding()).resolves.toEqual({ bound: false, issue: 'funded' });
  expect(mockRetire).not.toHaveBeenCalled();
  expect(mockSetSignerSecret).not.toHaveBeenCalled();
});

it('does not switch when the old key could not be kept', async () => {
  // Without the retired copy, replacing the secret destroys the only key to
  // an account that still holds its reserve.
  mockRetire.mockRejectedValue(new Error('secure store unavailable'));

  await expect(retryRecoveryBinding()).resolves.toEqual({ bound: false, issue: 'failed' });
  expect(mockSetSignerSecret).not.toHaveBeenCalled();
});

it('does not switch while the old account holds a collectible', async () => {
  mockMayHold.mockResolvedValue(true);

  await expect(retryRecoveryBinding()).resolves.toEqual({ bound: false, issue: 'funded' });
  expect(mockMigrate).not.toHaveBeenCalled();
  expect(mockSetSignerSecret).not.toHaveBeenCalled();
});

it('still keeps the old key when there was nothing to move', async () => {
  mockMigrate.mockResolvedValue({ swept: false, reason: 'legacy-empty' });

  await expect(retryRecoveryBinding()).resolves.toEqual({ bound: true });
  expect(mockRetire).toHaveBeenCalledWith(OLD.secret());
});

it('changes nothing when the stored key is already the passkey-derived one', async () => {
  mockGetSignerSecret.mockResolvedValue(DERIVED.secret());

  await expect(retryRecoveryBinding()).resolves.toEqual({ bound: true });
  expect(mockMigrate).not.toHaveBeenCalled();
  expect(mockRetire).not.toHaveBeenCalled();
});

/**
 * The stranded fee-payer recovery has to be reachable without signing in.
 *
 * `loginWithPasskey` is called from the Sign in screen and nowhere else, and
 * `app/index.tsx` routes anyone with a stored wallet straight to the dashboard.
 * So for the people this recovery exists for — already signed in, quietly
 * missing a balance — the only way to reach it was to clear the app's data and
 * sign in again. Telling a user whose money is stranded to wipe local state is
 * not a repair; it is a second chance to lose the wallet.
 *
 * What matters here is what it does NOT need: no assertion, no passkey prompt,
 * no sign-in.
 */

import { Keypair } from '@stellar/stellar-sdk';

const STORED_WALLET = 'CARM3RKO7MDAHVAR7RP3AEMO2GXVHRLA5FSEZD5OE2WARCADCEKGDK62';
const storedKp = Keypair.random();

const mockGetWalletAddress = jest.fn<Promise<string | null>, []>(async () => null);
const mockGetSignerSecret = jest.fn<Promise<string | null>, []>(async () => null);
const mockGetPasskeyId = jest.fn<Promise<string | null>, []>(async () => null);
const mockGetPasskeyPublicKey = jest.fn<Promise<string | null>, []>(async () => null);
const mockDiscoverWithPrf = jest.fn();
const mockSweep = jest.fn();

jest.mock('../walletStore', () => ({
  getWalletAddress: () => mockGetWalletAddress(),
  getSignerSecret: () => mockGetSignerSecret(),
  getPasskeyId: () => mockGetPasskeyId(),
  getPasskeyPublicKey: () => mockGetPasskeyPublicKey(),
  setPasskeyCredential: jest.fn(),
  setPasskeyId: jest.fn(),
  setSignerSecret: jest.fn(),
  setWalletAddress: jest.fn(),
}));
jest.mock('../passkey', () => ({
  discoverWithPrf: (...a: unknown[]) => mockDiscoverWithPrf(...a),
  nativePrfEvaluator: jest.fn(),
}));
jest.mock('../feePayerSweep', () => {
  const actual = jest.requireActual('../feePayerSweep');
  return {
    ...actual,
    sweepStrandedFeePayer: (...a: unknown[]) => mockSweep(...a),
    defaultSweepDeps: jest.fn(() => ({})),
  };
});
jest.mock('../network', () => ({
  getNetwork: () => ({ rpcUrl: 'https://rpc.example', horizonUrl: 'https://horizon.example' }),
  getNetworkName: () => 'mainnet',
}));
jest.mock('../walletBreadcrumbs', () => ({
  readBreadcrumbs: jest.fn(),
  writeBreadcrumbs: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined), multiSet: jest.fn() },
}));

import { recoverStoredWalletFeePayer } from '../passkeyLogin';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetWalletAddress.mockResolvedValue(null);
  mockGetSignerSecret.mockResolvedValue(null);
  mockGetPasskeyId.mockResolvedValue(null);
  mockGetPasskeyPublicKey.mockResolvedValue(null);
});

it('declines when there is no wallet on the device, touching nothing', async () => {
  await expect(recoverStoredWalletFeePayer()).resolves.toEqual({
    swept: false,
    reason: 'no-stored-wallet',
  });
  expect(mockSweep).not.toHaveBeenCalled();
});

it('runs for a wallet already signed in, with no passkey ceremony', async () => {
  mockGetWalletAddress.mockResolvedValue(STORED_WALLET);
  mockGetSignerSecret.mockResolvedValue(storedKp.secret());
  mockGetPasskeyId.mockResolvedValue('a-stored-credential-id');
  mockSweep.mockResolvedValue({ swept: false, reason: 'legacy-empty' });

  const outcome = await recoverStoredWalletFeePayer();

  expect(outcome).toEqual({ swept: false, reason: 'legacy-empty' });
  // The whole point: no assertion was requested of the authenticator.
  expect(mockDiscoverWithPrf).not.toHaveBeenCalled();
  // And it swept towards the fee-payer already in the secure store.
  expect(mockSweep).toHaveBeenCalledTimes(1);
  const [plan] = mockSweep.mock.calls[0] as [{ walletAddress: string; prfAddress: string }];
  expect(plan.walletAddress).toBe(STORED_WALLET);
  expect(plan.prfAddress).toBe(storedKp.publicKey());
});

it('reports a completed sweep to its caller', async () => {
  mockGetWalletAddress.mockResolvedValue(STORED_WALLET);
  mockGetSignerSecret.mockResolvedValue(storedKp.secret());
  mockGetPasskeyId.mockResolvedValue('a-stored-credential-id');
  mockSweep.mockResolvedValue({
    swept: true,
    amount: '4.2650850',
    txHash: 'abc123',
    from: 'GC5S3DWEG3E5KJZDEOBKQE5KE4UKOYCZVOH5ZZNR6RTCSJK7QAOSWTLN',
    to: storedKp.publicKey(),
  });

  const outcome = await recoverStoredWalletFeePayer();

  expect(outcome.swept).toBe(true);
  if (outcome.swept) expect(outcome.amount).toBe('4.2650850');
});

it('declines when a credential id is stored but no wallet is', async () => {
  // Order matters: without a signer there is nothing to sweep towards, so this
  // must not reach the network on the strength of a credential id alone.
  mockGetPasskeyId.mockResolvedValue('a-stored-credential-id');

  await expect(recoverStoredWalletFeePayer()).resolves.toEqual({
    swept: false,
    reason: 'no-stored-wallet',
  });
  expect(mockSweep).not.toHaveBeenCalled();
});

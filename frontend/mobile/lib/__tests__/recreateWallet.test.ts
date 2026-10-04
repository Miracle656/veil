/**
 * Re-registering as the repair for a password manager with no PRF.
 *
 * A manager that answers WebAuthn without a PRF result will answer the same way
 * every time, so retrying its passkey can never make the wallet recoverable —
 * only a passkey held somewhere else can. These pin down that the re-register
 * path actually replaces the wallet, and that it refuses once the account it
 * would abandon is on chain.
 */

import { Keypair } from '@stellar/stellar-sdk';

import { recreatePasskeyWallet } from '../passkeyWallet';
import { evaluatePrf } from '../passkey';
import { getNetwork } from '../network';
import { getSignerSecret, setSignerSecret, setWalletAddress } from '../walletStore';

// Prefixed `mock` so the hoisted jest.mock factory below may close over it.
const mockLoadAccount = jest.fn();

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: { Server: jest.fn().mockImplementation(() => ({ loadAccount: (...a: unknown[]) => mockLoadAccount(...a) })) },
  };
});

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => 'credential-id'),
  setItem: jest.fn(async () => undefined),
}));
jest.mock('../passkey', () => ({ evaluatePrf: jest.fn() }));
jest.mock('../network', () => ({ getNetwork: jest.fn() }));
jest.mock('../testnetWallet', () => ({ fundWithFriendbot: jest.fn(async () => false) }));
jest.mock('../walletBreadcrumbs', () => ({ writeBreadcrumbs: jest.fn(async () => undefined) }));
jest.mock('../walletStore', () => ({
  getPasskeyPublicKey: jest.fn(async () => null),
  getSignerSecret: jest.fn(),
  getWalletAddress: jest.fn(async () => null),
  setPasskeyCredential: jest.fn(async () => undefined),
  setPasskeyId: jest.fn(async () => undefined),
  setSignerSecret: jest.fn(async () => undefined),
  setWalletAddress: jest.fn(async () => undefined),
}));

const mockPrf = evaluatePrf as jest.MockedFunction<typeof evaluatePrf>;
const mockNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>;
const mockSecret = getSignerSecret as jest.MockedFunction<typeof getSignerSecret>;

const OLD = Keypair.random();
const NEW_ADDRESS = 'C' + 'A'.repeat(55);

/** A fresh passkey, i.e. a different wallet address. */
const register = jest.fn(async () => ({ walletAddress: NEW_ADDRESS }));

function mainnet() {
  mockNetwork.mockReturnValue({ horizonUrl: 'https://horizon', friendbotUrl: '' } as ReturnType<typeof getNetwork>);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSecret.mockResolvedValue(OLD.secret());
  mockLoadAccount.mockRejectedValue(Object.assign(new Error('not found'), { response: { status: 404 } }));
});

describe('recreatePasskeyWallet', () => {
  it('builds a new wallet from a new passkey, and binds recovery when the new one has PRF', async () => {
    mainnet();
    mockPrf.mockResolvedValue({ outcome: 'ok', output: new Uint8Array(32).fill(7) });

    const result = await recreatePasskeyWallet({ register });

    expect(register).toHaveBeenCalledTimes(1);
    expect(result.ok && result.wallet.address).toBe(NEW_ADDRESS);
    expect(result.ok && result.wallet.recoverable).toBe(true);
    // The old random fee-payer is replaced, not kept alongside.
    expect(setSignerSecret).toHaveBeenCalledWith(Keypair.fromRawEd25519Seed(Buffer.from(new Uint8Array(32).fill(7))).secret());
    expect(setWalletAddress).toHaveBeenCalledWith(NEW_ADDRESS);
  });

  it('still reports the wallet unrecoverable when the new passkey also has no PRF', async () => {
    mainnet();
    mockPrf.mockResolvedValue({ outcome: 'ok', output: null });

    const result = await recreatePasskeyWallet({ register });

    expect(result.ok && result.wallet.recoverable).toBe(false);
    expect(result.ok && result.wallet.recoveryIssue).toBe('unsupported');
  });

  it('refuses when the account it would abandon is already on chain', async () => {
    mainnet();
    mockLoadAccount.mockResolvedValue({ id: OLD.publicKey() });

    const result = await recreatePasskeyWallet({ register });

    expect(result).toEqual({ ok: false, reason: 'funded' });
    expect(register).not.toHaveBeenCalled();
  });

  it('does not treat a faucet-funded testnet account as worth keeping', async () => {
    mockNetwork.mockReturnValue({
      horizonUrl: 'https://horizon',
      friendbotUrl: 'https://friendbot',
    } as ReturnType<typeof getNetwork>);
    mockLoadAccount.mockResolvedValue({ id: OLD.publicKey() });
    mockPrf.mockResolvedValue({ outcome: 'ok', output: new Uint8Array(32).fill(7) });

    const result = await recreatePasskeyWallet({ register });

    expect(result.ok).toBe(true);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });
});

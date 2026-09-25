import { Keypair } from '@stellar/stellar-sdk';
import { createPasskeyWallet } from '../passkeyWallet';
import { evaluatePrf } from '../passkey';
import { getNetwork } from '../network';
import { setSignerSecret, setWalletAddress } from '../walletStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => 'test-credential-id'),
  setItem: jest.fn(async () => undefined),
}));

jest.mock('../passkey', () => ({
  evaluatePrf: jest.fn(),
}));

jest.mock('../network', () => ({
  getNetwork: jest.fn(),
}));

jest.mock('../testnetWallet', () => ({
  fundWithFriendbot: jest.fn(async () => true),
}));

jest.mock('../walletBreadcrumbs', () => ({
  writeBreadcrumbs: jest.fn(async () => undefined),
}));

jest.mock('../walletStore', () => ({
  getPasskeyPublicKey: jest.fn(async () => null),
  getSignerSecret: jest.fn(async () => null),
  getWalletAddress: jest.fn(async () => null),
  setPasskeyCredential: jest.fn(async () => undefined),
  setPasskeyId: jest.fn(async () => undefined),
  setSignerSecret: jest.fn(async () => undefined),
  setWalletAddress: jest.fn(async () => undefined),
}));

const mockPrf = evaluatePrf as jest.MockedFunction<typeof evaluatePrf>;
const mockNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>;

const WALLET_ADDRESS = 'C' + 'B'.repeat(55);
const register = jest.fn(async () => ({
  walletAddress: WALLET_ADDRESS,
  publicKeyBytes: new Uint8Array(64).fill(1),
}));

function setupTestnet() {
  mockNetwork.mockReturnValue({
    horizonUrl: 'https://horizon-testnet',
    friendbotUrl: 'https://friendbot-testnet',
  } as ReturnType<typeof getNetwork>);
}

describe('createPasskeyWallet PRF checking before commit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupTestnet();
  });

  it('commits immediately when passkey manager supports PRF', async () => {
    const prfOutput = new Uint8Array(32).fill(9);
    mockPrf.mockResolvedValue({ outcome: 'ok', output: prfOutput });

    const result = await createPasskeyWallet({ register });

    expect(register).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.wallet.address).toBe(WALLET_ADDRESS);
      expect(result.wallet.recoverable).toBe(true);
      expect(result.wallet.recoveryIssue).toBeUndefined();
    }

    const expectedSecret = Keypair.fromRawEd25519Seed(Buffer.from(prfOutput)).secret();
    expect(setSignerSecret).toHaveBeenCalledWith(expectedSecret);
    expect(setWalletAddress).toHaveBeenCalledWith(WALLET_ADDRESS);
  });

  it('surfaces unsupported status before committing when passkey manager lacks PRF', async () => {
    mockPrf.mockResolvedValue({ outcome: 'ok', output: null });

    const result = await createPasskeyWallet({ register });

    expect(register).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') {
      expect(result.walletAddress).toBe(WALLET_ADDRESS);
      expect(result.issue).toBe('unsupported');
      // Storage must NOT have been written before user commits
      expect(setWalletAddress).not.toHaveBeenCalled();
      expect(setSignerSecret).not.toHaveBeenCalled();

      // Now simulate user choosing to continue / commit
      const committed = await result.commit();
      expect(committed.address).toBe(WALLET_ADDRESS);
      expect(committed.recoverable).toBe(false);
      expect(committed.recoveryIssue).toBe('unsupported');

      expect(setWalletAddress).toHaveBeenCalledWith(WALLET_ADDRESS);
      expect(setSignerSecret).toHaveBeenCalled();
    }
  });

  it('forceCommit option commits immediately even without PRF', async () => {
    mockPrf.mockResolvedValue({ outcome: 'ok', output: null });

    const result = await createPasskeyWallet({ register }, { forceCommit: true });

    expect(result.status).toBe('created');
    if (result.status === 'created') {
      expect(result.wallet.address).toBe(WALLET_ADDRESS);
      expect(result.wallet.recoverable).toBe(false);
      expect(result.wallet.recoveryIssue).toBe('unsupported');
    }
    expect(setWalletAddress).toHaveBeenCalledWith(WALLET_ADDRESS);
  });
});

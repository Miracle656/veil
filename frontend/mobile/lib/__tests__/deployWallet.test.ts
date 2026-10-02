const mockIsWalletDeployed = jest.fn();
const mockGetSignerSecret = jest.fn();
const mockGetPasskeyPublicKey = jest.fn();
const mockSetPasskeyPublicKey = jest.fn();
const mockGetFeePayerAddress = jest.fn();
const mockReadBreadcrumbs = jest.fn();
const mockComputeWalletAddress = jest.fn();

jest.mock('../contractSpend', () => ({
  isWalletDeployed: (...a: unknown[]) => mockIsWalletDeployed(...a),
}));
jest.mock('../walletStore', () => ({
  getSignerSecret: () => mockGetSignerSecret(),
  getPasskeyPublicKey: () => mockGetPasskeyPublicKey(),
  setPasskeyPublicKey: (...a: unknown[]) => mockSetPasskeyPublicKey(...a),
}));
jest.mock('../activity', () => ({
  getFeePayerAddress: () => mockGetFeePayerAddress(),
}));
jest.mock('../walletBreadcrumbs', () => ({
  readBreadcrumbs: (...a: unknown[]) => mockReadBreadcrumbs(...a),
}));
jest.mock('../network', () => ({
  getNetwork: () => ({ factoryContractId: 'CFACTORY', networkPassphrase: 'Public Global Stellar Network ; September 2015' }),
}));
jest.mock('@veil/sdk', () => ({
  computeWalletAddress: (...a: unknown[]) => mockComputeWalletAddress(...a),
}));

import { deployWalletIfNeeded, resolveWalletPublicKey } from '../deployWallet';

const WALLET = 'CABCH3GZPGJOOZXPLN4EBXTLZSV6BUGFBXIKMNO2VJIPZ7ERENL7PCJ7';
const KEY = new Uint8Array(65).fill(7);
KEY[0] = 0x04;
const KEY_HEX = Buffer.from(KEY).toString('hex');

beforeEach(() => {
  jest.resetAllMocks();
  mockSetPasskeyPublicKey.mockResolvedValue(undefined);
});

describe('resolveWalletPublicKey', () => {
  it('uses the secure-store key when it derives to this wallet', async () => {
    mockGetPasskeyPublicKey.mockResolvedValue(KEY_HEX);
    mockComputeWalletAddress.mockReturnValue(WALLET);

    const key = await resolveWalletPublicKey(WALLET);

    expect(Buffer.from(key!).toString('hex')).toBe(KEY_HEX);
    expect(mockReadBreadcrumbs).not.toHaveBeenCalled();
  });

  it('ignores a stored key that derives to a different wallet', async () => {
    // Deploying with it would create a different, empty contract and leave the
    // funds where they are.
    mockGetPasskeyPublicKey.mockResolvedValue(KEY_HEX);
    mockComputeWalletAddress.mockReturnValue('COTHERWALLET');
    mockGetFeePayerAddress.mockResolvedValue('GSPENDING');
    mockReadBreadcrumbs.mockResolvedValue(null);

    await expect(resolveWalletPublicKey(WALLET)).resolves.toBeNull();
  });

  it('falls back to the on-chain recovery entries, and remembers the key', async () => {
    // The reported case: a recovered wallet with no key on the device.
    mockGetPasskeyPublicKey.mockResolvedValue(null);
    mockGetFeePayerAddress.mockResolvedValue('GSPENDING');
    mockReadBreadcrumbs.mockResolvedValue({ walletAddress: WALLET, publicKeyBytes: KEY, hasLegacyWalletEntry: true });

    const key = await resolveWalletPublicKey(WALLET);

    expect(key).toBe(KEY);
    expect(mockReadBreadcrumbs).toHaveBeenCalledWith('GSPENDING');
    expect(mockSetPasskeyPublicKey).toHaveBeenCalledWith(KEY_HEX);
  });

  it('refuses recovery entries that belong to a different wallet', async () => {
    mockGetPasskeyPublicKey.mockResolvedValue(null);
    mockGetFeePayerAddress.mockResolvedValue('GSPENDING');
    mockReadBreadcrumbs.mockResolvedValue({ walletAddress: 'COTHERWALLET', publicKeyBytes: KEY, hasLegacyWalletEntry: false });

    await expect(resolveWalletPublicKey(WALLET)).resolves.toBeNull();
  });
});

describe('deployWalletIfNeeded', () => {
  it('does nothing for a wallet already on chain', async () => {
    mockIsWalletDeployed.mockResolvedValue(true);
    const deploy = jest.fn();

    await deployWalletIfNeeded(deploy, WALLET);

    expect(deploy).not.toHaveBeenCalled();
  });

  it('deploys with the spending key and the resolved public key', async () => {
    mockIsWalletDeployed.mockResolvedValue(false);
    mockGetSignerSecret.mockResolvedValue('SSECRET');
    mockGetPasskeyPublicKey.mockResolvedValue(null);
    mockGetFeePayerAddress.mockResolvedValue('GSPENDING');
    mockReadBreadcrumbs.mockResolvedValue({ walletAddress: WALLET, publicKeyBytes: KEY, hasLegacyWalletEntry: false });
    const deploy = jest.fn().mockResolvedValue({});

    await deployWalletIfNeeded(deploy, WALLET);

    expect(deploy).toHaveBeenCalledWith('SSECRET', KEY);
  });

  it('refuses, and says the funds are safe, when no matching key can be found', async () => {
    mockIsWalletDeployed.mockResolvedValue(false);
    mockGetSignerSecret.mockResolvedValue('SSECRET');
    mockGetPasskeyPublicKey.mockResolvedValue(null);
    mockGetFeePayerAddress.mockResolvedValue('GSPENDING');
    mockReadBreadcrumbs.mockResolvedValue(null);
    const deploy = jest.fn();

    await expect(deployWalletIfNeeded(deploy, WALLET)).rejects.toThrow(/funds are safe/);
    expect(deploy).not.toHaveBeenCalled();
  });

  it('refuses without a spending key', async () => {
    mockIsWalletDeployed.mockResolvedValue(false);
    mockGetSignerSecret.mockResolvedValue(null);

    await expect(deployWalletIfNeeded(jest.fn(), WALLET)).rejects.toThrow(/No spending key/);
  });
});

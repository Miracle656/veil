/**
 * Tests for the device-side backup wiring's network stamping.
 *
 * `collectWalletMetadata` must stamp the ACTIVE network's passphrase — never a
 * hard-coded testnet value. A mainnet backup labelled with the testnet
 * passphrase describes the wallet as living on the wrong network (#703
 * follow-up, `backupFile.ts` site).
 *
 * The overrides argument supplies address/signers/settings so these tests
 * exercise only the network stamping, with no device storage involved.
 */

jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({
    name: 'mainnet',
    displayName: 'Stellar Mainnet',
    networkPassphrase: 'Public Global Network',
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://example.test/rpc',
    factoryContractId: 'CMAINNETFACTORY',
    friendbotUrl: null,
  })),
}));

import { collectWalletMetadata } from '../backupFile';
import { getNetwork } from '../network';

const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>;

const OVERRIDES = {
  address: 'GTESTWALLETADDRESS00000000000000000000000000000000000000000',
  signers: [],
  settings: {},
};

describe('collectWalletMetadata network stamping', () => {
  afterEach(() => {
    delete process.env['EXPO_PUBLIC_NETWORK_PASSPHRASE'];
    mockGetNetwork.mockReset();
    mockGetNetwork.mockImplementation(() => ({
      name: 'mainnet',
      displayName: 'Stellar Mainnet',
      networkPassphrase: 'Public Global Network',
      horizonUrl: 'https://horizon.stellar.org',
      rpcUrl: 'https://example.test/rpc',
      factoryContractId: 'CMAINNETFACTORY',
      friendbotUrl: null,
    }));
  });

  it('stamps the active mainnet passphrase, not the testnet one', async () => {
    const metadata = await collectWalletMetadata({ ...OVERRIDES });

    // Before the fix this was always 'Test SDF Network ; September 2015'.
    expect(metadata.networkPassphrase).toBe('Public Global Network');
    expect(metadata.networkPassphrase).not.toBe('Test SDF Network ; September 2015');
  });

  it('still stamps testnet when that is the active network', async () => {
    mockGetNetwork.mockReturnValueOnce({
      name: 'testnet',
      displayName: 'Stellar Testnet',
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      factoryContractId: 'CTESTNETFACTORY',
      friendbotUrl: 'https://friendbot.stellar.org',
    });

    const metadata = await collectWalletMetadata({ ...OVERRIDES });

    expect(metadata.networkPassphrase).toBe('Test SDF Network ; September 2015');
  });

  it('prefers the build-time env passphrase when one is set', async () => {
    process.env['EXPO_PUBLIC_NETWORK_PASSPHRASE'] = 'Custom Build Network';

    const metadata = await collectWalletMetadata({ ...OVERRIDES });

    expect(metadata.networkPassphrase).toBe('Custom Build Network');
  });

  it('fails clearly when the active network has no passphrase', async () => {
    // A whole VeilNetwork, not just the field under test: `getNetwork` is
    // typed, so a partial object is a typecheck error even though this code
    // path only reads the passphrase (the mistake #703 fixed in mobile's test).
    mockGetNetwork.mockReturnValueOnce({
      name: 'mainnet',
      displayName: 'Stellar Mainnet',
      networkPassphrase: '',
      horizonUrl: '',
      rpcUrl: '',
      factoryContractId: '',
      friendbotUrl: null,
    });

    await expect(collectWalletMetadata({ ...OVERRIDES })).rejects.toThrow(
      'No network passphrase is configured for Stellar Mainnet.',
    );
  });
});

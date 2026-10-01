jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({
    name: 'mainnet',
    displayName: 'Stellar Mainnet',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    factoryContractId: 'CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK',
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://app.useveilapp.xyz/api/rpc/mainnet',
    friendbotUrl: null,
  })),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn((key: string) => {
    if (key === 'invisible_wallet_address') return Promise.resolve('CADDRESS123');
    if (key === 'invisible_wallet_public_key') return Promise.resolve('GPUBLICKEY123');
    return Promise.resolve(null);
  }),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));

import { collectWalletMetadata } from '../backupFile';
import { getNetwork } from '../network';

const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>;

describe('collectWalletMetadata network fallbacks', () => {
  it('uses active mainnet network configuration and never falls back to testnet passphrase', async () => {
    const md = await collectWalletMetadata();

    expect(md.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
    expect(md.factoryAddress).toBe('CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK');
    expect(md.networkPassphrase).not.toContain('Test SDF Network');
  });

  it('fails clearly when network configuration has no factoryContractId', async () => {
    mockGetNetwork.mockReturnValueOnce({
      ...mockGetNetwork(),
      factoryContractId: '',
    });

    await expect(collectWalletMetadata()).rejects.toThrow(
      'Network configuration is incomplete for Stellar Mainnet.',
    );
  });

  it('fails clearly when network configuration has no networkPassphrase', async () => {
    mockGetNetwork.mockReturnValueOnce({
      ...mockGetNetwork(),
      networkPassphrase: '',
    });

    await expect(collectWalletMetadata()).rejects.toThrow(
      'Network configuration is incomplete for Stellar Mainnet.',
    );
  });

  it('honours explicit overrides when provided', async () => {
    const md = await collectWalletMetadata({
      networkPassphrase: 'Custom Network Passphrase',
      factoryAddress: 'CCUSTOMFACTORYADDRESS',
    });

    expect(md.networkPassphrase).toBe('Custom Network Passphrase');
    expect(md.factoryAddress).toBe('CCUSTOMFACTORYADDRESS');
  });
});

jest.mock('../network', () => ({
  getNetwork: jest.fn(() => ({
    displayName: 'Stellar Mainnet',
    networkPassphrase: 'Public Global Network',
  })),
}));

import { discoverAnchorInfo } from '../sep24';
import { getNetwork } from '../network';

const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>;

describe('discoverAnchorInfo', () => {
  it('uses the active mainnet passphrase when the anchor omits NETWORK_PASSPHRASE', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"',
        'WEB_AUTH_ENDPOINT = "https://anchor.example/auth"',
      ].join('\n'),
    }) as jest.Mock;

    await expect(discoverAnchorInfo('anchor.example')).resolves.toMatchObject({
      networkPassphrase: 'Public Global Network',
      transferServerUrl: 'https://anchor.example/sep24',
    });
  });

  it('fails clearly when the active network has no passphrase', async () => {
    // A whole VeilNetwork, not just the two fields under test: `getNetwork` is
    // typed, so a partial object is a typecheck error even though the code path
    // only reads the passphrase.
    mockGetNetwork.mockReturnValueOnce({
      name: 'mainnet',
      displayName: 'Stellar Mainnet',
      networkPassphrase: '',
      horizonUrl: '',
      rpcUrl: '',
      factoryContractId: '',
      friendbotUrl: null,
    });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => [
        'TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"',
        'WEB_AUTH_ENDPOINT = "https://anchor.example/auth"',
      ].join('\n'),
    }) as jest.Mock;

    await expect(discoverAnchorInfo('anchor.example')).rejects.toThrow(
      'No network passphrase is configured for Stellar Mainnet.',
    );
  });
});

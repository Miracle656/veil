/**
 * Tests for the Horizon URL `fetchHeldAssets` queries.
 *
 * The portfolio must be read from the ACTIVE network's Horizon. The old code
 * froze the URL into a module constant defaulting to testnet Horizon, so on
 * mainnet the portfolio screen queried the wrong chain and reported an empty
 * portfolio (#703 follow-up, `assets.ts` site).
 */

jest.mock('../network', () => ({
  ...jest.requireActual('../network'),
  getNetwork: jest.fn(),
}));

// `Horizon.Server` is a non-configurable property on the SDK bundle's
// namespace, so `jest.spyOn` cannot replace it — mock the module instead,
// keeping everything else real.
jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk');
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: jest.fn(),
    },
  };
});

import { Horizon } from '@stellar/stellar-sdk';
import { fetchHeldAssets } from '../assets';
import { getNetwork } from '../network';

const mockGetNetwork = getNetwork as jest.MockedFunction<typeof getNetwork>;
const ServerMock = Horizon.Server as unknown as jest.Mock;

const MAINNET = {
  name: 'mainnet' as const,
  displayName: 'Stellar Mainnet',
  networkPassphrase: 'Public Global Network',
  horizonUrl: 'https://horizon.stellar.org',
  rpcUrl: 'https://example.test/rpc',
  factoryContractId: 'CMAINNETFACTORY',
  friendbotUrl: null,
};

const TESTNET = {
  name: 'testnet' as const,
  displayName: 'Stellar Testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  factoryContractId: 'CTESTNETFACTORY',
  friendbotUrl: 'https://friendbot.stellar.org',
};

describe('fetchHeldAssets Horizon URL', () => {
  beforeEach(() => {
    // An empty funded account, so the fetch resolves without real HTTP.
    ServerMock.mockImplementation(() => ({
      loadAccount: jest.fn().mockResolvedValue({ balances: [] }),
    }));
  });

  afterEach(() => {
    ServerMock.mockReset();
    mockGetNetwork.mockReset();
  });

  it('queries the active mainnet Horizon, not the testnet one', async () => {
    mockGetNetwork.mockReturnValue(MAINNET);

    await fetchHeldAssets('GABCDEFTESTWALLET');

    // Before the fix this was always 'https://horizon-testnet.stellar.org'.
    expect(ServerMock).toHaveBeenCalledWith('https://horizon.stellar.org');
  });

  it('still uses testnet Horizon when testnet is the active network', async () => {
    mockGetNetwork.mockReturnValue(TESTNET);

    await fetchHeldAssets('GABCDEFTESTWALLET');

    expect(ServerMock).toHaveBeenCalledWith('https://horizon-testnet.stellar.org');
  });
});

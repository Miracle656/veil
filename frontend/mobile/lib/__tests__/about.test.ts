/**
 * Tests for the About screen's facts.
 *
 * The version is read from the Expo config, which is mocked with a mutable
 * object; everything else takes its network as an argument, so each case states
 * the network it is describing rather than depending on the ambient environment.
 */

import { Linking } from 'react-native';

import {
  EXTERNAL_LINKS,
  explorerAddressUrl,
  explorerNetworkSegment,
  getAppVersion,
  getContractEntries,
  getNetworkFacts,
  openExternalUrl,
} from '../about';
import type { VeilNetwork } from '../network';

const mockConstants: {
  nativeApplicationVersion: string | null;
  nativeBuildVersion: string | null;
  expoConfig: { version?: string } | null;
} = {
  nativeApplicationVersion: null,
  nativeBuildVersion: null,
  expoConfig: { version: '0.1.0' },
};

const mockOpenBrowserAsync = jest.fn<Promise<unknown>, [string]>();

// A getter, not a value: the mock factory runs while `../about` is imported,
// which is before the constants above are initialised.
jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() {
    return mockConstants;
  },
}));

jest.mock('expo-web-browser', () => ({
  __esModule: true,
  openBrowserAsync: (url: string) => mockOpenBrowserAsync(url),
}));

const CONTRACT = 'CA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ';
const ACCOUNT = 'GA3DHM4WL2VXPHR7NQKPZ7XK9FQJ2ULTQ6ZT4W2M5N6Q7RSTUVWXK9FQ';

const TESTNET: VeilNetwork = {
  name: 'testnet',
  displayName: 'Stellar Testnet',
  networkPassphrase: 'Test SDF Network ; September 2015',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  factoryContractId: CONTRACT,
  friendbotUrl: 'https://friendbot.stellar.org',
};

const MAINNET: VeilNetwork = {
  name: 'mainnet',
  displayName: 'Stellar Mainnet',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
  horizonUrl: 'https://horizon.stellar.org',
  rpcUrl: '',
  factoryContractId: '',
  friendbotUrl: null,
};

let openURLSpy: jest.SpyInstance<Promise<unknown>, [string]>;

beforeEach(() => {
  mockConstants.nativeApplicationVersion = null;
  mockConstants.nativeBuildVersion = null;
  mockConstants.expoConfig = { version: '0.1.0' };
  mockOpenBrowserAsync.mockReset().mockResolvedValue(undefined);
  openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
});

afterEach(() => {
  openURLSpy.mockRestore();
});

describe('getAppVersion', () => {
  it('prefers the native build over the Expo config', () => {
    mockConstants.nativeApplicationVersion = '1.2.3';
    mockConstants.nativeBuildVersion = '42';

    expect(getAppVersion()).toEqual({ version: '1.2.3', build: '42' });
  });

  it('falls back to the Expo config version outside a native build', () => {
    expect(getAppVersion()).toEqual({ version: '0.1.0', build: null });
  });

  it('reports an unknown version rather than an empty one', () => {
    mockConstants.expoConfig = {};

    expect(getAppVersion().version).toBe('unknown');
  });
});

describe('getNetworkFacts', () => {
  it('describes the network the app signs against', () => {
    const facts = getNetworkFacts(TESTNET);

    expect(facts.map((fact) => fact.key)).toEqual(['network', 'rpc', 'horizon']);
    expect(facts[0]!.value).toBe('Stellar Testnet');
    expect(facts[1]!.value).toBe('https://soroban-testnet.stellar.org');
  });

  it('marks an unconfigured RPC url rather than showing a blank', () => {
    const rpc = getNetworkFacts(MAINNET).find((fact) => fact.key === 'rpc');

    expect(rpc!.value).toBe('Not configured');
  });
});

describe('getContractEntries', () => {
  it('reports the wallet and the factory for the given network', () => {
    expect(getContractEntries(ACCOUNT, TESTNET)).toEqual([
      { key: 'wallet', label: 'Your wallet', address: ACCOUNT },
      { key: 'factory', label: 'Wallet factory', address: CONTRACT },
    ]);
  });

  it('reports a missing address as null instead of an empty string', () => {
    const entries = getContractEntries(null, MAINNET);

    expect(entries.every((entry) => entry.address === null)).toBe(true);
  });
});

describe('explorerAddressUrl', () => {
  it('links contracts and accounts to their own explorer paths', () => {
    expect(explorerAddressUrl(CONTRACT, TESTNET)).toBe(
      `https://stellar.expert/explorer/testnet/contract/${CONTRACT}`
    );
    expect(explorerAddressUrl(ACCOUNT, TESTNET)).toBe(
      `https://stellar.expert/explorer/testnet/account/${ACCOUNT}`
    );
  });

  it('uses the public network segment on mainnet', () => {
    expect(explorerNetworkSegment('mainnet')).toBe('public');
    expect(explorerAddressUrl(CONTRACT, MAINNET)).toContain('/explorer/public/contract/');
  });

  it('returns null for anything that is not a Stellar address', () => {
    expect(explorerAddressUrl(null, TESTNET)).toBeNull();
    expect(explorerAddressUrl('', TESTNET)).toBeNull();
    expect(explorerAddressUrl('not-an-address', TESTNET)).toBeNull();
    // Right shape, wrong length.
    expect(explorerAddressUrl(CONTRACT.slice(0, 55), TESTNET)).toBeNull();
    // Right length, neither a contract nor an account.
    expect(explorerAddressUrl(`M${CONTRACT.slice(1)}`, TESTNET)).toBeNull();
  });
});

describe('EXTERNAL_LINKS', () => {
  it('only points at https urls', () => {
    for (const link of EXTERNAL_LINKS) {
      expect(link.url).toMatch(/^https:\/\//);
    }
  });
});

describe('openExternalUrl', () => {
  it('opens an https url in the in-app browser', async () => {
    await expect(openExternalUrl('https://example.com')).resolves.toBe(true);

    expect(mockOpenBrowserAsync).toHaveBeenCalledWith('https://example.com');
    expect(openURLSpy).not.toHaveBeenCalled();
  });

  it('refuses any other scheme', async () => {
    await expect(openExternalUrl('http://example.com')).resolves.toBe(false);
    await expect(openExternalUrl('javascript:alert(1)')).resolves.toBe(false);
    await expect(openExternalUrl('veil://settings')).resolves.toBe(false);
    expect(mockOpenBrowserAsync).not.toHaveBeenCalled();
  });

  it('falls back to the platform when no in-app browser is available', async () => {
    mockOpenBrowserAsync.mockRejectedValue(new Error('unavailable'));

    await expect(openExternalUrl('https://example.com')).resolves.toBe(true);

    expect(openURLSpy).toHaveBeenCalledWith('https://example.com');
  });

  it('reports failure when nothing can open the url', async () => {
    mockOpenBrowserAsync.mockRejectedValue(new Error('unavailable'));
    openURLSpy.mockRejectedValue(new Error('no handler'));

    await expect(openExternalUrl('https://example.com')).resolves.toBe(false);
  });
});

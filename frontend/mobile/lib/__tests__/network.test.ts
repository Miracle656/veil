/**
 * Tests for runtime network selection.
 *
 * `lib/network.ts` holds module-level state that is hydrated once from storage,
 * so almost every case here needs a fresh module instance with a fresh
 * environment. `loadNetwork` handles that: reset the registry, set the build's
 * env vars, import, and wait for hydration to land.
 */

const mockStorage = new Map<string, string>();
let mockGetItemError: Error | null = null;

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (key: string) => {
      if (mockGetItemError) throw mockGetItemError;
      return mockStorage.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStorage.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockStorage.delete(key);
    }),
  },
}));

type NetworkModule = typeof import('../network');

const ENV_KEYS = [
  'EXPO_PUBLIC_NETWORK',
  'EXPO_PUBLIC_RPC_URL',
  'EXPO_PUBLIC_SOROBAN_RPC_URL',
  'EXPO_PUBLIC_MAINNET_RPC_URL',
  'EXPO_PUBLIC_FACTORY_CONTRACT_ID',
  'EXPO_PUBLIC_FACTORY_CONTRACT_ID_TESTNET',
  'EXPO_PUBLIC_FACTORY_CONTRACT_ID_MAINNET',
] as const;

/** Import a fresh copy of lib/network.ts under the given build environment. */
async function loadNetwork(env: Partial<Record<string, string>> = {}): Promise<NetworkModule> {
  jest.resetModules();
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);

  const mod: NetworkModule = require('../network');
  await mod.hydrateNetwork();
  return mod;
}

const STORAGE_KEY = 'veil_network_override';

beforeEach(() => {
  mockStorage.clear();
  mockGetItemError = null;
});

afterAll(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('default network', () => {
  it('falls back to testnet when nothing is configured', async () => {
    const net = await loadNetwork();
    expect(net.getNetworkName()).toBe('testnet');
    expect(net.getNetwork().networkPassphrase).toBe('Test SDF Network ; September 2015');
  });

  it('honours the build-time network', async () => {
    const net = await loadNetwork({ EXPO_PUBLIC_NETWORK: 'mainnet' });
    expect(net.getNetworkName()).toBe('mainnet');
    expect(net.getNetwork().networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('ignores an unrecognised build-time network', async () => {
    const net = await loadNetwork({ EXPO_PUBLIC_NETWORK: 'regtest' });
    expect(net.getNetworkName()).toBe('testnet');
  });

  it('reads endpoints from the build environment', async () => {
    const net = await loadNetwork({
      EXPO_PUBLIC_SOROBAN_RPC_URL: 'https://rpc.example.test',
      EXPO_PUBLIC_FACTORY_CONTRACT_ID_TESTNET: 'CTESTFACTORY',
    });
    expect(net.getNetwork().rpcUrl).toBe('https://rpc.example.test');
    expect(net.getNetwork().factoryContractId).toBe('CTESTFACTORY');
  });
});

describe('persisted override', () => {
  it('overrides the build-time network on hydration', async () => {
    mockStorage.set(STORAGE_KEY, 'mainnet');
    const net = await loadNetwork();
    expect(net.getNetworkName()).toBe('mainnet');
  });

  it('ignores a stored value that is not a known network', async () => {
    mockStorage.set(STORAGE_KEY, 'regtest');
    const net = await loadNetwork({ EXPO_PUBLIC_NETWORK: 'mainnet' });
    expect(net.getNetworkName()).toBe('mainnet');
  });

  it('falls back to the build network when storage is unreadable', async () => {
    mockGetItemError = new Error('storage unavailable');
    const net = await loadNetwork({ EXPO_PUBLIC_NETWORK: 'mainnet' });
    expect(net.getNetworkName()).toBe('mainnet');
  });

  it('reads storage once no matter how often hydration is requested', async () => {
    const net = await loadNetwork();
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    const before = AsyncStorage.getItem.mock.calls.length;
    await Promise.all([net.hydrateNetwork(), net.hydrateNetwork(), net.hydrateNetwork()]);
    expect(AsyncStorage.getItem.mock.calls.length).toBe(before);
  });
});

describe('setNetwork', () => {
  it('re-points RPC, factory, and passphrase', async () => {
    const net = await loadNetwork({
      EXPO_PUBLIC_FACTORY_CONTRACT_ID_TESTNET: 'CTESTFACTORY',
      EXPO_PUBLIC_MAINNET_RPC_URL: 'https://mainnet.rpc.test',
      EXPO_PUBLIC_FACTORY_CONTRACT_ID_MAINNET: 'CMAINFACTORY',
    });

    expect(net.getNetwork()).toMatchObject({
      rpcUrl: 'https://soroban-testnet.stellar.org',
      factoryContractId: 'CTESTFACTORY',
    });

    await net.setNetwork('mainnet');

    expect(net.getNetwork()).toMatchObject({
      name: 'mainnet',
      rpcUrl: 'https://mainnet.rpc.test',
      factoryContractId: 'CMAINFACTORY',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
  });

  it('persists the choice', async () => {
    const net = await loadNetwork();
    await net.setNetwork('mainnet');
    expect(mockStorage.get(STORAGE_KEY)).toBe('mainnet');
  });

  it('survives a reload', async () => {
    const first = await loadNetwork();
    await first.setNetwork('mainnet');

    const second = await loadNetwork();
    expect(second.getNetworkName()).toBe('mainnet');
  });

  it('is a no-op when the network is already active', async () => {
    const net = await loadNetwork();
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    AsyncStorage.setItem.mockClear();

    await expect(net.setNetwork('testnet')).resolves.toBe(false);
    expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  });

  it('rejects an unknown network', async () => {
    const net = await loadNetwork();
    await expect(net.setNetwork('regtest' as never)).rejects.toThrow(/Unknown network/);
  });

  it('leaves the active network unchanged when the write fails', async () => {
    const net = await loadNetwork();
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    AsyncStorage.setItem.mockRejectedValueOnce(new Error('disk full'));

    await expect(net.setNetwork('mainnet')).rejects.toThrow('disk full');
    expect(net.getNetworkName()).toBe('testnet');
  });
});

describe('subscribeToNetwork', () => {
  it('notifies subscribers on a switch', async () => {
    const net = await loadNetwork();
    const listener = jest.fn();
    net.subscribeToNetwork(listener);

    await net.setNetwork('mainnet');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not notify when nothing changed', async () => {
    const net = await loadNetwork();
    const listener = jest.fn();
    net.subscribeToNetwork(listener);

    await net.setNetwork('testnet');
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies when hydration changes the network out from under a render', async () => {
    jest.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
    mockStorage.set(STORAGE_KEY, 'mainnet');

    const net: NetworkModule = require('../network');
    const listener = jest.fn();
    net.subscribeToNetwork(listener);

    await net.hydrateNetwork();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(net.getNetworkName()).toBe('mainnet');
  });

  it('stops notifying after unsubscribe', async () => {
    const net = await loadNetwork();
    const listener = jest.fn();
    const unsubscribe = net.subscribeToNetwork(listener);
    unsubscribe();

    await net.setNetwork('mainnet');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('clearNetworkOverride', () => {
  it('returns to the build-time network and removes the stored value', async () => {
    const net = await loadNetwork({ EXPO_PUBLIC_NETWORK: 'testnet' });
    await net.setNetwork('mainnet');
    expect(net.getNetworkName()).toBe('mainnet');

    await net.clearNetworkOverride();

    expect(net.getNetworkName()).toBe('testnet');
    expect(mockStorage.has(STORAGE_KEY)).toBe(false);
  });
});

describe('configuration checks', () => {
  it('reports mainnet as unconfigured when the build has no endpoints for it', async () => {
    const net = await loadNetwork();
    expect(net.isNetworkConfigured(net.NETWORKS.mainnet)).toBe(false);
    expect(net.describeMissingConfig(net.NETWORKS.mainnet)).toEqual([
      'Soroban RPC URL',
      'factory contract ID',
    ]);
  });

  it('reports a fully configured network as ready', async () => {
    const net = await loadNetwork({
      EXPO_PUBLIC_MAINNET_RPC_URL: 'https://mainnet.rpc.test',
      EXPO_PUBLIC_FACTORY_CONTRACT_ID_MAINNET: 'CMAINFACTORY',
    });
    expect(net.isNetworkConfigured(net.NETWORKS.mainnet)).toBe(true);
    expect(net.describeMissingConfig(net.NETWORKS.mainnet)).toEqual([]);
  });

  it('names each missing piece individually', async () => {
    const net = await loadNetwork({ EXPO_PUBLIC_MAINNET_RPC_URL: 'https://mainnet.rpc.test' });
    expect(net.describeMissingConfig(net.NETWORKS.mainnet)).toEqual(['factory contract ID']);
  });
});

describe('buildFriendbotUrl', () => {
  it('builds a funding URL on testnet', async () => {
    const net = await loadNetwork();
    expect(net.buildFriendbotUrl('GABC')).toBe('https://friendbot.stellar.org/?addr=GABC');
  });

  it('returns null on a network without a faucet', async () => {
    const net = await loadNetwork();
    await net.setNetwork('mainnet');
    expect(net.buildFriendbotUrl('GABC')).toBeNull();
  });
});

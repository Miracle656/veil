/**
 * The SDK's AsyncStorage keys are namespaced per network — and every module
 * that reaches past the SDK has to use the same names.
 *
 * `components/WalletProvider.tsx` gives the SDK an adapter that suffixes mainnet
 * keys with `_mainnet`. Four modules read those keys directly and were still
 * reading the bare names, so on mainnet they each got null and took a silent
 * "nothing stored" branch: no PRF (random, unrecoverable fee-payer), no public
 * key in the secure mockStore, breadcrumbs written with `veil:wallet` alone, and a
 * recovery screen that said "try again" to something that could never succeed.
 * Wallets reached mainnet holding real money at an address nothing could deploy.
 *
 * The mockStore below answers ONLY to the correctly-suffixed key, so a reader that
 * drifts back to the bare name fails here instead of on someone's phone.
 */

// Prefixed `mock` so the hoisted jest.mock factories below may close over them.
const mockStore = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    setItem: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
    removeItem: jest.fn(async (k: string) => void mockStore.delete(k)),
    multiSet: jest.fn(async (pairs: [string, string][]) => {
      for (const [k, v] of pairs) mockStore.set(k, v);
    }),
  },
}));

let mockNetworkName: 'mainnet' | 'testnet' = 'mainnet';
jest.mock('../network', () => ({
  getNetworkName: () => mockNetworkName,
  hydrateNetwork: jest.fn(async () => undefined),
}));

import { SDK_KEY_ID, getSdkItem, sdkStorageKey, setSdkItems } from '../sdkStorage';

beforeEach(() => {
  mockStore.clear();
  mockNetworkName = 'mainnet';
});

describe('sdkStorageKey', () => {
  it('suffixes on mainnet and leaves testnet on the historical bare names', async () => {
    expect(await sdkStorageKey(SDK_KEY_ID)).toBe('invisible_wallet_key_id_mainnet');
    mockNetworkName = 'testnet';
    expect(await sdkStorageKey(SDK_KEY_ID)).toBe('invisible_wallet_key_id');
  });
});

describe('getSdkItem', () => {
  it('reads what the SDK adapter wrote on mainnet', async () => {
    mockStore.set('invisible_wallet_key_id_mainnet', 'credential-from-mainnet');
    expect(await getSdkItem(SDK_KEY_ID)).toBe('credential-from-mainnet');
  });

  // The bug: the value is right there under the bare name, and a mainnet read
  // must not see it — on testnet that key IS the testnet wallet's credential.
  it('does not fall back to the bare key on mainnet', async () => {
    mockStore.set('invisible_wallet_key_id', 'credential-from-testnet');
    expect(await getSdkItem(SDK_KEY_ID)).toBeNull();
  });

  it('keeps the two networks apart', async () => {
    mockStore.set('invisible_wallet_key_id', 'testnet-credential');
    mockStore.set('invisible_wallet_key_id_mainnet', 'mainnet-credential');
    expect(await getSdkItem(SDK_KEY_ID)).toBe('mainnet-credential');
    mockNetworkName = 'testnet';
    expect(await getSdkItem(SDK_KEY_ID)).toBe('testnet-credential');
  });
});

describe('setSdkItems', () => {
  it('writes where the SDK will look for it, and round-trips', async () => {
    await setSdkItems([[SDK_KEY_ID, 'written']]);
    expect(mockStore.get('invisible_wallet_key_id_mainnet')).toBe('written');
    expect(mockStore.has('invisible_wallet_key_id')).toBe(false);
    expect(await getSdkItem(SDK_KEY_ID)).toBe('written');
  });
});

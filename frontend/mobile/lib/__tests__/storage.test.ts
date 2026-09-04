/**
 * Tests for the secure-storage helper and the wallet accessors that route
 * through it. `expo-secure-store` is mocked with an in-memory keychain so the
 * contract is exercised without a device: values round-trip and survive across
 * reads (the relaunch-persistence guarantee), JSON serialises and tolerates
 * corrupt data, reads fail soft to null, and the wallet accessors read and write
 * exactly the canonical secure keys — never plain storage.
 */

// `mock`-prefixed so jest's factory-hoist allows referencing them out of scope.
const mockStore = new Map<string, string>();
let mockThrowOnRead = false;

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => {
    if (mockThrowOnRead) throw new Error('keychain unavailable');
    return mockStore.has(key) ? mockStore.get(key)! : null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import {
  SecureKey,
  getSecureItem,
  setSecureItem,
  deleteSecureItem,
  getSecureJSON,
  setSecureJSON,
} from '../storage';
import {
  getWalletAddress,
  setWalletAddress,
  setSignerSecret,
  getSignerSecret,
  clearWalletStore,
} from '../walletStore';

beforeEach(() => {
  mockStore.clear();
  mockThrowOnRead = false;
  jest.clearAllMocks();
});

describe('secure string storage', () => {
  it('round-trips a value and keeps it available across reads', async () => {
    await setSecureItem('k', 'v');
    expect(await getSecureItem('k')).toBe('v');
    // A second read returns the same value — the persistence relaunch relies on.
    expect(await getSecureItem('k')).toBe('v');
  });

  it('returns null for a missing key', async () => {
    expect(await getSecureItem('absent')).toBeNull();
  });

  it('deletes a value', async () => {
    await setSecureItem('k', 'v');
    await deleteSecureItem('k');
    expect(await getSecureItem('k')).toBeNull();
  });

  it('fails soft to null when the keychain read throws', async () => {
    await setSecureItem('k', 'v');
    mockThrowOnRead = true;
    expect(await getSecureItem('k')).toBeNull();
  });
});

describe('secure JSON storage', () => {
  it('serialises and parses structured metadata', async () => {
    const meta = { address: 'CABC', signers: [{ index: 0, publicKey: 'GABC' }] };
    await setSecureJSON('meta', meta);
    expect(await getSecureJSON<typeof meta>('meta')).toEqual(meta);
  });

  it('returns null for a missing key', async () => {
    expect(await getSecureJSON('absent')).toBeNull();
  });

  it('returns null on malformed JSON rather than throwing', async () => {
    await setSecureItem('meta', '{not json');
    expect(await getSecureJSON('meta')).toBeNull();
  });
});

describe('walletStore routes through secure storage', () => {
  it('persists and reads the wallet address under the canonical secure key', async () => {
    await setWalletAddress('CWALLET');
    expect(await getWalletAddress()).toBe('CWALLET');
    expect(mockStore.get(SecureKey.walletAddress)).toBe('CWALLET');
  });

  it('keeps the signer secret in the keychain', async () => {
    await setSignerSecret('SSECRET');
    expect(await getSignerSecret()).toBe('SSECRET');
    expect(mockStore.get(SecureKey.signerSecret)).toBe('SSECRET');
  });

  it('clears every wallet identifier', async () => {
    await setWalletAddress('CWALLET');
    await setSignerSecret('SSECRET');
    await clearWalletStore();
    expect(await getWalletAddress()).toBeNull();
    expect(await getSignerSecret()).toBeNull();
    expect(mockStore.size).toBe(0);
  });
});

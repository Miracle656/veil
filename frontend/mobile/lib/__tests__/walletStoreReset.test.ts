/**
 * Reset wallet must leave NOTHING that can present itself as a wallet.
 *
 * A reset that clears only the secure-store identifiers still leaves the SDK
 * holding a credential id, the WalletProvider holding a signer session, and the
 * app's caches describing the deleted wallet — a half-reset that either refuses
 * to re-create the wallet or shows the old one's data under a new one.
 *
 * These tests seed every key {@link resetWallet} is responsible for and assert
 * it is gone afterwards, while presentation state and the other network's
 * wallet survive untouched.
 */

// `mock`-prefixed so jest's hoisted factory may close over it.
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => (mockStore.has(key) ? mockStore.get(key)! : null)),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';

import { SecureKey } from '../storage';
import {
  SDK_KEYS,
  SESSION_KEYS,
  WALLET_CACHE_KEYS,
  WALLET_SESSION_SIGNER_SECRET_KEY,
  clearWalletStore,
  resetWallet,
} from '../walletStore';

/** The active wallet's own secure-store identifiers. */
const SECURE_IDENTITY_KEYS = Object.values(SecureKey);
/** Secure-store keys that identify the active wallet or its signer session. */
const SECURE_WALLET_KEYS = [...SECURE_IDENTITY_KEYS, ...SESSION_KEYS];

/** AsyncStorage keys that derail a re-created wallet if left behind. */
const ASYNC_WALLET_KEYS = [...SDK_KEYS, ...WALLET_CACHE_KEYS];

// Presentation state, deliberately not wallet state.
const UNRELATED_KEY = 'veil_seen_welcome';
// The other network's wallet. Reset on one network must never touch it.
const OTHER_NETWORK_KEY = 'invisible_wallet_address_mainnet';

async function seedWallet() {
  for (const key of SECURE_WALLET_KEYS) mockStore.set(key, 'secret-material');
  for (const key of ASYNC_WALLET_KEYS) await AsyncStorage.setItem(key, 'cached');
  await AsyncStorage.setItem(UNRELATED_KEY, '1');
  await AsyncStorage.setItem(OTHER_NETWORK_KEY, 'CMAINNETWALLET');
}

beforeEach(async () => {
  mockStore.clear();
  await AsyncStorage.clear();
  jest.clearAllMocks();
});

describe('resetWallet', () => {
  it('clears every wallet key — secure store, SDK keys, session and cached state', async () => {
    await seedWallet();

    // Sanity-check the fixture actually held something to clear.
    expect(mockStore.size).toBe(SECURE_WALLET_KEYS.length);
    for (const key of ASYNC_WALLET_KEYS) {
      expect(await AsyncStorage.getItem(key)).toBe('cached');
    }

    await resetWallet();

    for (const key of SECURE_WALLET_KEYS) {
      expect(mockStore.has(key)).toBe(false);
    }
    for (const key of ASYNC_WALLET_KEYS) {
      expect(await AsyncStorage.getItem(key)).toBeNull();
    }
  });

  it('leaves presentation state and the other network’s wallet intact', async () => {
    await seedWallet();

    await resetWallet();

    expect(await AsyncStorage.getItem(UNRELATED_KEY)).toBe('1');
    expect(await AsyncStorage.getItem(OTHER_NETWORK_KEY)).toBe('CMAINNETWALLET');
  });

  it('is a superset of clearWalletStore — it clears the identifiers clearWalletStore clears too', async () => {
    await seedWallet();

    await resetWallet();

    // clearWalletStore's contract is unchanged: the active network's identifiers
    // are gone after a reset.
    expect(await AsyncStorage.getItem('invisible_wallet_address')).toBeNull();
    expect(await AsyncStorage.getItem('invisible_wallet_key_id')).toBeNull();
  });
});

describe('clearWalletStore', () => {
  it('still clears only the active network’s identifiers, leaving session and caches', async () => {
    await seedWallet();

    await clearWalletStore();

    // Identifiers are gone...
    for (const key of SECURE_IDENTITY_KEYS) {
      expect(mockStore.has(key)).toBe(false);
    }
    // ...but the full reset's extra surface is untouched, which is why resetWallet
    // exists rather than callers composing this by hand.
    expect(mockStore.get(WALLET_SESSION_SIGNER_SECRET_KEY)).toBe('secret-material');
    expect(await AsyncStorage.getItem('veil_outbox_v1')).toBe('cached');
  });
});

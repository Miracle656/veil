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
  WALLET_SESSION_SIGNER_SECRET_KEY,
  clearWalletStore,
  resetWallet,
  walletCacheKeys,
} from '../walletStore';
// Imported from the modules that own them, NOT from `walletStore`, so a key
// forgotten from walletCacheKeys() fails these tests instead of asserting the
// implementation against itself. The secure-store side gets the same property
// from `Object.values(SecureKey)` below.
import { OUTBOX_STORAGE_KEY } from '../outbox';
import { WALLETCONNECT_SESSIONS_KEY } from '../walletConnect';
import { MULTISIG_CONTRACT_STORAGE_KEY } from '../multisig';
import { NOTIFIED_MOVEMENTS_KEY } from '../notifiedMovements';
import { WALLET_SETTINGS_STORAGE_KEY, BACKUP_LAST_EXPORTED_KEY } from '../backupFile';
import { PENDING_RECOVERY_KEY, RECOVERY_SERVERS_KEY } from '../recovery';
import { ORIGIN_PERMISSIONS_STORAGE_KEY } from '../permissions';
import { OFFRAMP_ACTIVE_ORDER_KEY, OFFRAMP_DEPOSIT_ADDRESSES_KEY } from '../offramp';
import { FEE_PAYER_SOURCE_KEY } from '../feePayerSource';

/** The active wallet's own secure-store identifiers. */
const SECURE_IDENTITY_KEYS = Object.values(SecureKey);
/** Secure-store keys that identify the active wallet or its signer session. */
const SECURE_WALLET_KEYS = [...SECURE_IDENTITY_KEYS, ...SESSION_KEYS];

/**
 * Every AsyncStorage key a reset is responsible for, read from its owning
 * module. Kept independent of {@link walletCacheKeys} on purpose: if the two
 * ever disagree, the assertion below fails and names the oversight.
 */
const WALLET_DERIVED_ASYNC_KEYS = [
  OUTBOX_STORAGE_KEY,
  WALLETCONNECT_SESSIONS_KEY,
  MULTISIG_CONTRACT_STORAGE_KEY,
  NOTIFIED_MOVEMENTS_KEY,
  WALLET_SETTINGS_STORAGE_KEY,
  PENDING_RECOVERY_KEY,
  ORIGIN_PERMISSIONS_STORAGE_KEY,
  BACKUP_LAST_EXPORTED_KEY,
  OFFRAMP_ACTIVE_ORDER_KEY,
  OFFRAMP_DEPOSIT_ADDRESSES_KEY,
  FEE_PAYER_SOURCE_KEY,
  RECOVERY_SERVERS_KEY,
];

/** AsyncStorage keys that derail a re-created wallet if left behind. */
const ASYNC_WALLET_KEYS = [...SDK_KEYS, ...walletCacheKeys()];

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
  it('covers every wallet-derived AsyncStorage key its owning module defines', () => {
    // `walletStore` imports these same constants, so this is the check that a
    // newly added wallet-derived key was not silently left out of the reset.
    expect([...walletCacheKeys()].sort()).toEqual([...WALLET_DERIVED_ASYNC_KEYS].sort());
  });

  it('resolves every key even when an owning module is what loads walletStore', async () => {
    // `walletConnect`, `recovery` and `feePayerSource` import from `walletStore`,
    // so importing their key constants into `walletStore` closes an import cycle.
    // Entering that cycle from the OTHER side used to leave the list holding
    // `undefined` for those keys, and a reset then deleted the literal key
    // "undefined" while `veil_fee_payer_source` stayed on the device. The rest of
    // this file imports `walletStore` first, which hides it, so force the bad
    // order here. `walletCacheKeys()` reads the constants at call time, which is
    // what makes the order stop mattering.
    jest.resetModules();
    await jest.isolateModulesAsync(async () => {
      const owner = require('../feePayerSource') as typeof import('../feePayerSource');
      const store = require('../walletStore') as typeof import('../walletStore');
      expect(store.walletCacheKeys()).toContain(owner.FEE_PAYER_SOURCE_KEY);
      expect(store.walletCacheKeys().filter((k) => typeof k !== 'string')).toEqual([]);
      expect([...store.networkScopedWalletCacheKeys()]).toEqual([owner.FEE_PAYER_SOURCE_KEY]);
    });
  });

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

import { WALLET_KEYS, namespaceKey } from './network';
import type { StorageAdapter } from './types';

/**
 * Creates a namespaced storage wrapper over any given `StorageAdapter`
 * that routes wallet keys to the designated network slot.
 */
export function createNamespacedStorage(
  storage: StorageAdapter,
  getNetwork: () => 'testnet' | 'mainnet' = () => 'testnet',
): StorageAdapter {
  return {
    getItem(key: string): string | null {
      try {
        return storage.getItem(namespaceKey(key, getNetwork()));
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        storage.setItem(namespaceKey(key, getNetwork()), value);
      } catch {
        /* blocked / quota */
      }
    },
    removeItem(key: string): void {
      try {
        storage.removeItem(namespaceKey(key, getNetwork()));
      } catch {
        /* blocked */
      }
    },
  };
}

/**
 * Helper to clear all wallet keys for the active network on a StorageAdapter.
 */
export function clearNetworkWalletKeys(
  storage: StorageAdapter,
  network: 'testnet' | 'mainnet' = 'testnet',
): void {
  for (const key of WALLET_KEYS) {
    try {
      storage.removeItem(namespaceKey(key, network));
    } catch {
      /* ignore */
    }
  }
}

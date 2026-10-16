import { WALLET_KEYS, namespaceKey } from './network';
import type { StorageAdapter } from './core';

export const ADDITIONAL_SIGNERS_KEY = 'invisible_wallet_additional_signers';

const PRIMARY_BINDING_KEYS = new Set([
  'invisible_wallet_key_id',
  'invisible_wallet_address',
  'invisible_wallet_public_key',
]);

export type AdditionalSignerCredential = {
  credentialId: string;
  publicKey: string;
  status: 'pending' | 'active';
  signerIndex?: number;
};

type AdditionalSignerStore = {
  version: 1;
  credentials: AdditionalSignerCredential[];
};

/**
 * Prevent a scoped operation from changing the wallet's primary identity keys.
 * Reads are still allowed so the add-signer path can authorize with the current
 * primary credential.
 */
export function guardPrimaryBindingWrites(
  storage: StorageAdapter,
  isGuarded: () => boolean,
): StorageAdapter {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => {
      if (isGuarded() && PRIMARY_BINDING_KEYS.has(key)) {
        throw new Error(`Cannot write ${key} during the add-signer flow.`);
      }
      return storage.setItem(key, value);
    },
    removeItem: (key) => {
      if (isGuarded() && PRIMARY_BINDING_KEYS.has(key)) {
        throw new Error(`Cannot remove ${key} during the add-signer flow.`);
      }
      return storage.removeItem?.(key);
    },
  };
}

function parseAdditionalSignerStore(raw: string): AdditionalSignerStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`Additional signer storage is malformed: ${String(cause)}`);
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as AdditionalSignerStore).version !== 1 ||
    !Array.isArray((parsed as AdditionalSignerStore).credentials)
  ) {
    throw new Error('Additional signer storage has an unsupported format.');
  }

  const credentials = (parsed as AdditionalSignerStore).credentials;
  for (const credential of credentials) {
    if (
      typeof credential !== 'object' ||
      credential === null ||
      typeof credential.credentialId !== 'string' ||
      credential.credentialId.length === 0 ||
      typeof credential.publicKey !== 'string' ||
      !/^(?:[0-9a-f]{130})$/i.test(credential.publicKey) ||
      (credential.status !== 'pending' && credential.status !== 'active') ||
      (credential.signerIndex !== undefined &&
        (!Number.isInteger(credential.signerIndex) || credential.signerIndex < 0))
    ) {
      throw new Error('Additional signer storage contains an invalid credential.');
    }
  }

  return { version: 1, credentials };
}

/**
 * Read the versioned additional-credential registry, migrating installs that
 * only have the legacy primary binding to an empty registry without changing it.
 */
export async function readAdditionalSignerCredentials(
  storage: StorageAdapter,
): Promise<AdditionalSignerCredential[]> {
  const raw = await storage.getItem(ADDITIONAL_SIGNERS_KEY);
  if (raw !== null) return parseAdditionalSignerStore(raw).credentials;

  await storage.setItem(
    ADDITIONAL_SIGNERS_KEY,
    JSON.stringify({ version: 1, credentials: [] } satisfies AdditionalSignerStore),
  );
  return [];
}

export async function writeAdditionalSignerCredentials(
  storage: StorageAdapter,
  credentials: AdditionalSignerCredential[],
): Promise<void> {
  const value: AdditionalSignerStore = { version: 1, credentials };
  await storage.setItem(ADDITIONAL_SIGNERS_KEY, JSON.stringify(value));
}

/**
 * Creates a namespaced storage wrapper over any given `StorageAdapter`
 * that routes wallet keys to the designated network slot.
 */
export function createNamespacedStorage(
  storage: StorageAdapter,
  getNetwork: () => 'testnet' | 'mainnet' = () => 'testnet',
): StorageAdapter {
  return {
    getItem(key: string): string | null | Promise<string | null> {
      try {
        return storage.getItem(namespaceKey(key, getNetwork()));
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void | Promise<void> {
      try {
        return storage.setItem(namespaceKey(key, getNetwork()), value);
      } catch {
        /* blocked / quota */
      }
    },
    removeItem(key: string): void | Promise<void> {
      try {
        return storage.removeItem?.(namespaceKey(key, getNetwork()));
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
      storage.removeItem?.(namespaceKey(key, network));
    } catch {
      /* ignore */
    }
  }
}

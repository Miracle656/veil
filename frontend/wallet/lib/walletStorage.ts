import { WALLET_KEYS, namespaceKey, namespacedStorageAdapter } from './network'

/**
 * Per-network wallet storage.
 *
 * The wallet contract is deployed per network — each network has its own factory
 * (`CAUK4…` testnet, `CCZ3J…` mainnet), so one passkey resolves to a DIFFERENT
 * `C…` address on each. Storing the wallet identity under single, un-namespaced
 * keys therefore let one network clobber the other: switching to testnet stranded
 * the mainnet address, registering overwrote it, and — worst — a "Reset wallet"
 * on testnet deleted the bare keys and destroyed a REAL-funds mainnet wallet.
 *
 * The fix mirrors the mobile app (`frontend/mobile/lib/walletStore.ts`): each
 * network gets its own slot. Testnet keeps the historical unsuffixed keys so
 * existing installs keep working untouched; mainnet keys carry a `_mainnet`
 * suffix. The key-namespacing primitive and the SDK storage adapter live in
 * `network.ts` (which owns network identity); this module adds the
 * localStorage / sessionStorage wrappers app code uses, plus reset and the
 * one-time legacy migration.
 */

type WebStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function safeStorage(kind: 'local' | 'session'): WebStorage | null {
  try {
    if (kind === 'local') {
      return typeof localStorage === 'undefined' ? null : localStorage
    }
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    // Private mode / blocked storage.
    return null
  }
}

/**
 * A namespacing view over a Web Storage area. Every wallet key is transparently
 * routed to the active network's slot; other keys pass through. Reads and writes
 * are null-safe when storage is unavailable.
 */
function createNamespacedStorage(kind: 'local' | 'session') {
  return {
    getItem(key: string): string | null {
      const store = safeStorage(kind)
      if (!store) return null
      try {
        return store.getItem(namespaceKey(key))
      } catch {
        return null
      }
    },
    setItem(key: string, value: string): void {
      const store = safeStorage(kind)
      if (!store) return
      try {
        store.setItem(namespaceKey(key), value)
      } catch {
        /* quota / blocked — nothing else to do */
      }
    },
    removeItem(key: string): void {
      const store = safeStorage(kind)
      if (!store) return
      try {
        store.removeItem(namespaceKey(key))
      } catch {
        /* blocked — nothing else to do */
      }
    },
  }
}

/**
 * Namespacing wrapper over `localStorage`. Shares the SDK adapter, so app code
 * and the SDK write to the same per-network slots.
 */
export const walletLocal = namespacedStorageAdapter

/** Namespacing wrapper over `sessionStorage`. */
export const walletSession = createNamespacedStorage('session')

/**
 * Remove the ACTIVE network's wallet identifiers only — the primitive behind
 * "Reset wallet". Because each key is namespaced, resetting one network cannot
 * touch the other's state.
 */
export function clearActiveNetworkWallet(): void {
  for (const key of WALLET_KEYS) {
    walletLocal.removeItem(key)
    walletSession.removeItem(key)
  }
}

/** Marks that the one-time legacy → per-network migration has run. */
const SCHEMA_KEY = 'veil_storage_schema'
const SCHEMA_VERSION = 'v2-per-network'
const MAINNET_SUFFIX = '_mainnet'

/**
 * One-time migration of a pre-namespacing install.
 *
 * Before this change the wallet lived under bare keys, holding whichever single
 * network the install last used. Testnet already reads those bare keys as its
 * slot, so only a mainnet install needs moving: its bare keys are copied into the
 * `_mainnet` slots. This runs once, at module load, BEFORE the user can switch
 * networks — capturing the install's real network from `veil_network` while it
 * still describes the bare keys. A naive per-read "fall back to the bare key"
 * cannot do this safely: after a later switch, the bare keys (testnet's) would
 * bleed into mainnet reads. The bare keys are left in place — they remain
 * testnet's slot, so a coexisting testnet wallet keeps working.
 */
function migrateLegacyStorageOnce(): void {
  const local = safeStorage('local')
  if (!local) return
  try {
    if (local.getItem(SCHEMA_KEY) === SCHEMA_VERSION) return

    // The network the bare keys belong to == the install's stored choice. Absent
    // one, the historical default is testnet, whose slot IS the bare key — no
    // move needed.
    if (local.getItem('veil_network') === 'mainnet') {
      for (const key of WALLET_KEYS) {
        const namespaced = `${key}${MAINNET_SUFFIX}`
        if (local.getItem(namespaced) === null) {
          const legacy = local.getItem(key)
          if (legacy !== null) local.setItem(namespaced, legacy)
        }
      }
    }

    local.setItem(SCHEMA_KEY, SCHEMA_VERSION)
  } catch {
    /* storage blocked — nothing to migrate */
  }
}

migrateLegacyStorageOnce()

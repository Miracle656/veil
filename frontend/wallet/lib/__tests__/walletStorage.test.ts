/**
 * @jest-environment jsdom
 *
 * Per-network wallet storage (lib/walletStorage.ts + the namespacing primitives
 * in lib/network.ts). The wallet is deployed per network, so one passkey resolves
 * to a DIFFERENT `C…` address on each — the two must never share a storage slot.
 * These tests pin the invariant that mattered most: a testnet operation (switch,
 * register, or "Reset wallet") can never touch mainnet state, and vice versa.
 *
 * The active network is resolved once at module load from `veil_network`; jsdom
 * starts with an empty localStorage, so this file runs as a testnet install.
 * `namespaceKey` takes an explicit network argument, letting us assert both
 * networks' slot mapping without a page reload.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

// jsdom provides neither WebCrypto nor these encoders; @stellar/stellar-sdk —
// pulled in transitively by lib/network.ts — needs them at import time.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { namespaceKey, WALLET_KEYS } from '../network'
import { walletLocal, walletSession, clearActiveNetworkWallet } from '../walletStorage'

const ADDRESS = 'invisible_wallet_address'
const SECRET = 'veil_signer_secret'
const MAINNET = (base: string) => `${base}_mainnet`

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('namespaceKey', () => {
  it('leaves wallet keys bare on testnet (historical slot, untouched installs)', () => {
    for (const key of WALLET_KEYS) {
      expect(namespaceKey(key, 'testnet')).toBe(key)
    }
  })

  it('suffixes every wallet key with _mainnet on mainnet', () => {
    for (const key of WALLET_KEYS) {
      expect(namespaceKey(key, 'mainnet')).toBe(`${key}_mainnet`)
    }
  })

  it('passes non-wallet keys through unchanged on both networks', () => {
    for (const network of ['testnet', 'mainnet'] as const) {
      expect(namespaceKey('veil_network', network)).toBe('veil_network')
      expect(namespaceKey('veil_wallet_settings', network)).toBe('veil_wallet_settings')
      expect(namespaceKey('unrelated_key', network)).toBe('unrelated_key')
    }
  })
})

describe('walletLocal / walletSession (active network = testnet)', () => {
  it('routes wallet keys to the testnet (bare) slot and round-trips', () => {
    walletLocal.setItem(ADDRESS, 'C_TESTNET')
    expect(localStorage.getItem(ADDRESS)).toBe('C_TESTNET') // bare slot, no suffix
    expect(localStorage.getItem(MAINNET(ADDRESS))).toBeNull()
    expect(walletLocal.getItem(ADDRESS)).toBe('C_TESTNET')

    walletLocal.removeItem(ADDRESS)
    expect(walletLocal.getItem(ADDRESS)).toBeNull()
    expect(localStorage.getItem(ADDRESS)).toBeNull()
  })

  it('keeps sessionStorage wallet keys in the active network slot too', () => {
    walletSession.setItem(SECRET, 'S_TESTNET')
    expect(sessionStorage.getItem(SECRET)).toBe('S_TESTNET')
    expect(sessionStorage.getItem(MAINNET(SECRET))).toBeNull()
    expect(walletSession.getItem(SECRET)).toBe('S_TESTNET')
  })
})

describe('clearActiveNetworkWallet', () => {
  it('wipes only the active network slot — a coexisting mainnet wallet survives', () => {
    // Seed a full wallet on both networks: bare keys = testnet, _mainnet = mainnet.
    for (const key of WALLET_KEYS) {
      localStorage.setItem(key, `${key}:testnet`)
      localStorage.setItem(MAINNET(key), `${key}:mainnet`)
      sessionStorage.setItem(key, `${key}:testnet`)
      sessionStorage.setItem(MAINNET(key), `${key}:mainnet`)
    }

    clearActiveNetworkWallet() // active = testnet

    for (const key of WALLET_KEYS) {
      // testnet slot gone…
      expect(localStorage.getItem(key)).toBeNull()
      expect(sessionStorage.getItem(key)).toBeNull()
      // …mainnet REAL-funds wallet untouched.
      expect(localStorage.getItem(MAINNET(key))).toBe(`${key}:mainnet`)
      expect(sessionStorage.getItem(MAINNET(key))).toBe(`${key}:mainnet`)
    }
  })
})

describe('one-time legacy migration (runs at module load)', () => {
  const SCHEMA_KEY = 'veil_storage_schema'
  const SCHEMA_VERSION = 'v2-per-network'

  // Re-run the module-load side effect against freshly-seeded storage.
  const reloadWalletStorage = () => {
    jest.isolateModules(() => {
      require('../walletStorage')
    })
  }

  it('moves a mainnet install\'s bare keys into the _mainnet slots', () => {
    localStorage.setItem('veil_network', 'mainnet')
    for (const key of WALLET_KEYS) {
      localStorage.setItem(key, `${key}:legacy-mainnet`)
    }

    reloadWalletStorage()

    for (const key of WALLET_KEYS) {
      expect(localStorage.getItem(MAINNET(key))).toBe(`${key}:legacy-mainnet`)
      // bare keys are left in place (they become testnet's slot).
      expect(localStorage.getItem(key)).toBe(`${key}:legacy-mainnet`)
    }
    expect(localStorage.getItem(SCHEMA_KEY)).toBe(SCHEMA_VERSION)
  })

  it('does not create _mainnet slots for a testnet install', () => {
    localStorage.setItem('veil_network', 'testnet')
    for (const key of WALLET_KEYS) {
      localStorage.setItem(key, `${key}:legacy-testnet`)
    }

    reloadWalletStorage()

    for (const key of WALLET_KEYS) {
      expect(localStorage.getItem(MAINNET(key))).toBeNull()
    }
    expect(localStorage.getItem(SCHEMA_KEY)).toBe(SCHEMA_VERSION)
  })

  it('is idempotent — a migrated install is not re-migrated', () => {
    localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION)
    localStorage.setItem('veil_network', 'mainnet')
    for (const key of WALLET_KEYS) {
      localStorage.setItem(key, `${key}:testnet-now`)
    }

    reloadWalletStorage()

    // schema already current → the mainnet bare keys are NOT copied across.
    for (const key of WALLET_KEYS) {
      expect(localStorage.getItem(MAINNET(key))).toBeNull()
    }
  })

  it('does not clobber a mainnet slot that already holds data', () => {
    localStorage.setItem('veil_network', 'mainnet')
    for (const key of WALLET_KEYS) {
      localStorage.setItem(key, `${key}:bare`)
      localStorage.setItem(MAINNET(key), `${key}:existing`)
    }

    reloadWalletStorage()

    for (const key of WALLET_KEYS) {
      expect(localStorage.getItem(MAINNET(key))).toBe(`${key}:existing`)
    }
  })
})

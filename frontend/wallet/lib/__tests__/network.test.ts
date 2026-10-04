/**
 * @jest-environment jsdom
 *
 * Acceptance tests for #834 (runtime network switch), covering setActiveNetwork()
 * itself — the mechanism lib/walletStorage.test.ts assumes already ran correctly.
 * That file drives namespaceKey / walletLocal / walletSession directly and already
 * covers per-network isolation, a switch with state on both networks, and the
 * module-load migration; this file instead exercises the four things nothing in
 * frontend/wallet or sdk/ tests yet: setActiveNetwork's refusal paths, the
 * session-address drop on a real switch, the first-load default resolution, and
 * isNetworkAvailable's mainnet gating.
 *
 * window.location.reload() is not implemented by jsdom — calling it logs a
 * "Not implemented: navigation" error to the virtual console but does not
 * throw, so setActiveNetwork() still returns normally. That console error is
 * expected noise for any test that reaches a real switch, not a failure.
 */
import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { namespaceKey, NETWORK_STORAGE_KEY, NETWORKS, isNetworkAvailable, setActiveNetwork } from '../network'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('setActiveNetwork refusal paths', () => {
  it('refuses an unknown network name and writes nothing', () => {
    // @ts-expect-error — deliberately invalid input, the case setActiveNetwork guards against.
    expect(setActiveNetwork('moonnet')).toBe(false)
    expect(localStorage.getItem(NETWORK_STORAGE_KEY)).toBeNull()
  })

  it('refuses mainnet when it has no reachable RPC, and writes nothing', () => {
    const originalRpcUrl = NETWORKS.mainnet.rpcUrl
    NETWORKS.mainnet.rpcUrl = ''
    try {
      expect(isNetworkAvailable('mainnet')).toBe(false)
      expect(setActiveNetwork('mainnet')).toBe(false)
      expect(localStorage.getItem(NETWORK_STORAGE_KEY)).toBeNull()
    } finally {
      NETWORKS.mainnet.rpcUrl = originalRpcUrl
    }
  })

  it('reports testnet as always available', () => {
    expect(isNetworkAvailable('testnet')).toBe(true)
  })
})

describe('setActiveNetwork — already on the target network', () => {
  it('returns true without writing or reloading when the target is already active', () => {
    // This file's module load resolves the active network to testnet (no
    // persisted choice, default build env) — see the first-load tests below.
    expect(setActiveNetwork('testnet')).toBe(true)
    expect(localStorage.getItem(NETWORK_STORAGE_KEY)).toBeNull()
  })
})

describe('setActiveNetwork — session-address drop on a real switch', () => {
  // These reach window.location.reload(), which jsdom logs as a "Not
  // implemented: navigation" console error (see the file header) rather than
  // throwing — expected noise for this path, not a test failure, so it's
  // silenced here rather than left to print on every run.
  let consoleError: jest.SpyInstance
  beforeEach(() => {
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    consoleError.mockRestore()
  })

  it('drops the leaving network\'s session address but leaves both networks\' localStorage alone', () => {
    const testnetAddressKey = namespaceKey('invisible_wallet_address', 'testnet')
    const mainnetAddressKey = namespaceKey('invisible_wallet_address', 'mainnet')
    sessionStorage.setItem(testnetAddressKey, 'CTESTNETADDR')
    localStorage.setItem(testnetAddressKey, 'CTESTNETADDR')
    localStorage.setItem(mainnetAddressKey, 'CMAINNETADDR')

    expect(setActiveNetwork('mainnet')).toBe(true)

    expect(localStorage.getItem(NETWORK_STORAGE_KEY)).toBe('mainnet')
    // The testnet session address is gone — /lock must not misread it after reload.
    expect(sessionStorage.getItem(testnetAddressKey)).toBeNull()
    // Neither network's localStorage wallet state was touched by the switch.
    expect(localStorage.getItem(testnetAddressKey)).toBe('CTESTNETADDR')
    expect(localStorage.getItem(mainnetAddressKey)).toBe('CMAINNETADDR')
  })

  it('leaves the fee-payer key untouched by the switch — it is the same G-address on every network', () => {
    sessionStorage.setItem('veil_signer_secret', 'SFEEPAYERSECRET')

    setActiveNetwork('mainnet')

    expect(sessionStorage.getItem('veil_signer_secret')).toBe('SFEEPAYERSECRET')
  })
})

describe('first-load network resolution (module load)', () => {
  // getNetworkName() captures the active network once, at module load — so
  // re-running that resolution means re-requiring the module against
  // freshly-seeded storage, the same pattern lib/walletStorage.test.ts uses
  // for its own module-load migration.
  const resolvedNetworkName = (): string => {
    let name = ''
    jest.isolateModules(() => {
      name = require('../network').getNetworkName()
    })
    return name
  }

  it('falls back to the build-time default when nothing is persisted', () => {
    expect(localStorage.getItem(NETWORK_STORAGE_KEY)).toBeNull()
    // NEXT_PUBLIC_NETWORK is unset in this test run, so the build default is testnet.
    expect(resolvedNetworkName()).toBe('testnet')
  })

  it('prefers the persisted choice over the build-time default', () => {
    localStorage.setItem(NETWORK_STORAGE_KEY, 'mainnet')
    expect(resolvedNetworkName()).toBe('mainnet')
  })

  it('falls back to the build-time default when the persisted value is garbage', () => {
    localStorage.setItem(NETWORK_STORAGE_KEY, 'moonnet')
    expect(resolvedNetworkName()).toBe('testnet')
  })
})

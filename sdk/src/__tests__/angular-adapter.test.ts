/**
 * Unit tests for the Angular adapter (`invisible-wallet-sdk/angular`).
 *
 * The adapter is a thin DI binding over the framework-agnostic core, so these
 * tests cover the three things the binding itself is responsible for:
 * exposing the same actions as the React hook, reflecting wallet state in
 * signals, and never dragging React into an Angular app's bundle.
 *
 * The service is constructed the way an app constructs it — through a real
 * Angular `Injector` — which is also what proves the standalone wiring works.
 * WebAuthn and the Stellar SDK are mocked so the suite runs without a browser
 * or a network.
 */

import fs from 'node:fs'
import path from 'node:path'

// Loads Angular's JIT compiler ahead of DI: it registers `ng.ɵcompilerFacade`,
// which `@angular/core` consults to compile the Decorator metadata on
// VeilService / VeilModule when the injector is built (as it would be in a
// dev-mode browser).
import '@angular/compiler'

import { Injector, inject, runInInjectionContext } from '@angular/core'

import { provideVeil, VeilService } from '../angular'

// ── @stellar/stellar-sdk mock ─────────────────────────────────────────────────

jest.mock('@stellar/stellar-sdk', () => ({
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC:  'Public Global Stellar Network ; September 2015',
  },
  BASE_FEE: '100',
  rpc: {
    Server: jest.fn().mockImplementation(() => ({
      getContractData: jest.fn().mockResolvedValue({}),
    })),
    Api: {
      GetTransactionStatus: { SUCCESS: 'SUCCESS', NOT_FOUND: 'NOT_FOUND', FAILED: 'FAILED' },
      isSimulationError: jest.fn(() => false),
    },
    Durability: { Persistent: 'persistent', Temporary: 'temporary' },
    assembleTransaction: jest.fn(),
  },
  Horizon: { Server: jest.fn() },
  Account: jest.fn(),
  Contract: jest.fn(),
  Keypair: { random: jest.fn(), fromSecret: jest.fn() },
  TransactionBuilder: Object.assign(jest.fn(), { buildFeeBumpTransaction: jest.fn() }),
  xdr: { ScVal: { scvLedgerKeyContractInstance: jest.fn().mockReturnValue({}) } },
  nativeToScVal: jest.fn(),
  scValToNative: jest.fn(),
  Asset: { native: jest.fn() },
  hash: jest.fn(),
}))

// ── ./utils mock ──────────────────────────────────────────────────────────────

jest.mock('../utils', () => ({
  bufferToHex:          jest.fn(() => 'aabbcc1122334455'),
  hexToUint8Array:      jest.fn(() => new Uint8Array(65).fill(4)),
  derToRawSignature:    jest.fn(() => new Uint8Array(64).fill(1)),
  extractP256PublicKey: jest.fn().mockResolvedValue(new Uint8Array(65).fill(4)),
  computeWalletAddress: jest.fn(() => 'CWALLET_ADDRESS_MOCK'),
}))

// ── WebAuthn mock ─────────────────────────────────────────────────────────────

const mockCredentialsCreate = jest.fn()

Object.defineProperty(global, 'navigator', {
  value: { credentials: { create: mockCredentialsCreate } },
  writable:     true,
  configurable: true,
})

Object.defineProperty(global, 'crypto', {
  value: { getRandomValues: jest.fn((arr: Uint8Array) => (arr.fill(42), arr)) },
  writable:     true,
  configurable: true,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

const CONFIG = {
  factoryAddress:    'CFACTORY_ADDRESS',
  rpcUrl:            'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
}

/** Build a VeilService exactly as a standalone app's DI container would. */
function createWallet(providers: Parameters<Injector['create']>[0]['providers']): VeilService {
  const injector = Injector.create({ providers })
  return runInInjectionContext(injector, () => inject(VeilService))
}

/** A minimal PublicKeyCredential returned by navigator.credentials.create(). */
function makeMockRegistrationCredential() {
  return {
    id:   'bW9jay1jcmVkZW50aWFsLWlk',
    type: 'public-key',
    response: {
      attestationObject:     new ArrayBuffer(32),
      clientDataJSON:        new ArrayBuffer(32),
      getPublicKey:          jest.fn(() => new Uint8Array(65).fill(4).buffer),
      getPublicKeyAlgorithm: jest.fn(() => -7),
      getTransports:         jest.fn(() => ['internal']),
    },
  }
}

/**
 * Every action the README and the React hook promise. Kept as a literal list so
 * that dropping one from any adapter fails loudly.
 */
const EXPECTED_ACTIONS = [
  'addSigner',
  'approve',
  'completeRecovery',
  'decryptLocal',
  'deploy',
  'deriveCounterfactualAddress',
  'encryptLocal',
  'encryptionMode',
  'getAllowance',
  'getBalance',
  'getNonce',
  'getPortableSigner',
  'getSigners',
  'initiateRecovery',
  'login',
  'register',
  'removeSigner',
  'replayOutbox',
  'rotateSigner',
  'sendPayment',
  'setGuardian',
  'signAuthEntry',
] as const

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('VeilService (Angular)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    localStorage.clear()
  })

  describe('dependency injection', () => {
    it('is injectable through the standalone provideVeil() providers', () => {
      const wallet = createWallet([provideVeil(CONFIG)])

      expect(wallet).toBeInstanceOf(VeilService)
    })

    it('is a singleton: two injections resolve to the same instance', () => {
      const injector = Injector.create({ providers: [provideVeil(CONFIG)] })
      const first  = runInInjectionContext(injector, () => inject(VeilService))
      const second = runInInjectionContext(injector, () => inject(VeilService))

      expect(first).toBe(second)
    })

    it('reports a missing config instead of failing silently', () => {
      expect(() => createWallet([VeilService])).toThrow(/provideVeil/)
    })
  })

  describe('surface', () => {
    it('exposes every action the other adapters do', () => {
      const wallet = createWallet([provideVeil(CONFIG)])

      for (const action of EXPECTED_ACTIONS) {
        expect(typeof wallet[action]).toBe('function')
      }
      expect(wallet.outbox).toBeDefined()
    })

    it('exposes wallet status as signals', () => {
      const wallet = createWallet([provideVeil(CONFIG)])

      expect(wallet.state()).toEqual({
        address: null,
        isDeployed: false,
        isPending: false,
        error: null,
      })
      expect(wallet.address()).toBeNull()
      expect(wallet.isDeployed()).toBe(false)
      expect(wallet.isPending()).toBe(false)
      expect(wallet.error()).toBeNull()
    })
  })

  describe('reactivity', () => {
    it('reflects a successful registration in the signals', async () => {
      mockCredentialsCreate.mockResolvedValueOnce(makeMockRegistrationCredential())

      const wallet = createWallet([provideVeil(CONFIG)])
      const result = await wallet.register('alice')

      expect(result.walletAddress).toBe('CWALLET_ADDRESS_MOCK')
      expect(wallet.address()).toBe('CWALLET_ADDRESS_MOCK')
      expect(wallet.state().address).toBe('CWALLET_ADDRESS_MOCK')
      expect(wallet.isPending()).toBe(false)
      expect(wallet.error()).toBeNull()
    })

    it('reflects a failed registration in the error signal', async () => {
      mockCredentialsCreate.mockRejectedValueOnce(new Error('NotAllowedError: cancelled'))

      const wallet = createWallet([provideVeil(CONFIG)])

      await expect(wallet.register()).rejects.toThrow('NotAllowedError')
      expect(wallet.error()).toContain('NotAllowedError')
      expect(wallet.isPending()).toBe(false)
      expect(wallet.address()).toBeNull()
    })
  })

  describe('bundle', () => {
    it('reaches no React import from the Angular entry point', () => {
      const srcDir = path.join(__dirname, '..')
      const entry  = path.join(srcDir, 'angular', 'index.ts')

      // `import type` / `export type` are erased by tsc, so they are not part
      // of the bundle — drop those lines to model the emitted graph.
      const importsOf = (file: string): string[] =>
        fs.readFileSync(file, 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(?:import|export)\s+type\s/.test(line))
          .flatMap((line) =>
            Array.from(
              line.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g),
              (match) => match[1],
            ),
          )

      const resolveLocal = (from: string, specifier: string): string | null => {
        const base = path.resolve(path.dirname(from), specifier)
        for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
          if (fs.existsSync(candidate)) return candidate
        }
        return null
      }

      // Walk every module reachable from the Angular entry, collecting the
      // packages they pull in. A React import anywhere in that graph would ship
      // React to every Angular app using the SDK.
      const visited  = new Set<string>()
      const packages = new Set<string>()
      const queue    = [entry]

      while (queue.length > 0) {
        const file = queue.pop()!
        if (visited.has(file)) continue
        visited.add(file)

        for (const specifier of importsOf(file)) {
          if (specifier.startsWith('.')) {
            const resolved = resolveLocal(file, specifier)
            if (resolved) queue.push(resolved)
          } else {
            packages.add(specifier)
          }
        }
      }

      expect(visited.size).toBeGreaterThan(1)
      expect([...packages].filter((name) => /^react(-dom|-native)?(\/|$)/.test(name))).toEqual([])
    })
  })
})
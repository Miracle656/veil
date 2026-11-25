import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Keypair } from '@stellar/stellar-sdk'

import {
  calculateRandomDelay,
  getPendingStealthSweeps,
  savePendingStealthSweeps,
  scheduleStealthSweep,
  purgeEphemeralSecret,
  removePendingStealthSweep,
  executeStealthSweep,
  getStealthLinkageDisclosure,
  STEALTH_PENDING_SWEEPS_STORAGE_KEY,
} from '../stealthSweep'
import { collectWalletMetadata } from '../../backup'

// Full 56-character test identifiers — no shortened addresses
const VALID_ONE_TIME_PUBLIC_KEY = 'GDZX4M24GBL77E6V7TFFWJ6W6O6Q2UPL2H6XGY3BGYUDF63L45WGFK4W'
const VALID_DESTINATION_CONTRACT = 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA'

const mockStorage: Record<string, string> = {}

jest.mock('../../walletStorage', () => ({
  walletLocal: {
    getItem: (key: string) => mockStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      mockStorage[key] = value
    },
    removeItem: (key: string) => {
      delete mockStorage[key]
    },
  },
}))

jest.mock('../../network', () => ({
  getNetwork: () => ({
    name: 'testnet',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    factoryContractId: 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA',
  }),
  getNativeAssetContractId: () => 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
}))

const mockGetAccount = jest.fn()
const mockSimulateTransaction = jest.fn()
const mockSendTransaction = jest.fn()
const mockAssembleTransaction = jest.fn()

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: jest.fn().mockImplementation(() => ({
        getAccount: mockGetAccount,
        simulateTransaction: mockSimulateTransaction,
        sendTransaction: mockSendTransaction,
      })),
      assembleTransaction: jest.fn().mockImplementation((...args) => mockAssembleTransaction(...args)),
      Api: {
        ...actual.rpc.Api,
        isSimulationError: jest.fn().mockImplementation((sim: any) => Boolean(sim && sim.error)),
      },
    },
  }
})

describe('stealthSweep manager', () => {
  let oneTimeKp: Keypair

  beforeEach(() => {
    jest.clearAllMocks()
    for (const key of Object.keys(mockStorage)) {
      delete mockStorage[key]
    }
    oneTimeKp = Keypair.random()
  })

  describe('calculateRandomDelay', () => {
    it('returns a delay within bounds', () => {
      for (let i = 0; i < 20; i++) {
        const delay = calculateRandomDelay(100, 200)
        expect(delay).toBeGreaterThanOrEqual(100)
        expect(delay).toBeLessThanOrEqual(200)
      }
    })

    it('handles identical min and max', () => {
      expect(calculateRandomDelay(500, 500)).toBe(500)
    })

    it('handles zero or inverted bounds safely', () => {
      const delay = calculateRandomDelay(300, 100)
      expect(delay).toBe(300)
    })
  })

  describe('scheduleStealthSweep', () => {
    it('validates one-time public key and destination contract address', () => {
      expect(() =>
        scheduleStealthSweep({
          oneTimePublicKey: 'INVALID_PUBLIC_KEY',
          oneTimeSecret: oneTimeKp.secret(),
          destinationContractAddress: VALID_DESTINATION_CONTRACT,
          amount: '10.5',
        }),
      ).toThrow(/Invalid one-time stealth public key/)

      expect(() =>
        scheduleStealthSweep({
          oneTimePublicKey: oneTimeKp.publicKey(),
          oneTimeSecret: oneTimeKp.secret(),
          destinationContractAddress: 'INVALID_CONTRACT',
          amount: '10.5',
        }),
      ).toThrow(/Destination must be a valid 56-character Soroban contract address/)
    })

    it('creates and persists a pending sweep record with randomized delay', () => {
      const baseTime = 1700000000000
      const sweep = scheduleStealthSweep({
        oneTimePublicKey: oneTimeKp.publicKey(),
        oneTimeSecret: oneTimeKp.secret(),
        destinationContractAddress: VALID_DESTINATION_CONTRACT,
        amount: '25.0',
        minDelaySeconds: 60,
        maxDelaySeconds: 120,
        now: baseTime,
      })

      expect(sweep.id).toMatch(/^stealth_sweep_/)
      expect(sweep.oneTimePublicKey).toBe(oneTimeKp.publicKey())
      expect(sweep.oneTimeSecret).toBe(oneTimeKp.secret())
      expect(sweep.destinationContractAddress).toBe(VALID_DESTINATION_CONTRACT)
      expect(sweep.amount).toBe('25.0')
      expect(sweep.status).toBe('pending')
      expect(sweep.createdAt).toBe(baseTime)
      expect(sweep.delaySeconds).toBeGreaterThanOrEqual(60)
      expect(sweep.delaySeconds).toBeLessThanOrEqual(120)
      expect(sweep.scheduledExecutionTime).toBe(baseTime + sweep.delaySeconds * 1000)

      const stored = getPendingStealthSweeps()
      expect(stored).toHaveLength(1)
      expect(stored[0].id).toBe(sweep.id)
    })
  })

  describe('purgeEphemeralSecret and removal', () => {
    it('purges ephemeral secret while preserving receipt metadata', () => {
      const sweep = scheduleStealthSweep({
        oneTimePublicKey: oneTimeKp.publicKey(),
        oneTimeSecret: oneTimeKp.secret(),
        destinationContractAddress: VALID_DESTINATION_CONTRACT,
        amount: '15.0',
      })

      expect(getPendingStealthSweeps()[0].oneTimeSecret).toBe(oneTimeKp.secret())

      purgeEphemeralSecret(sweep.id)

      const updated = getPendingStealthSweeps()[0]
      expect(updated.oneTimeSecret).toBe('')
      expect(updated.id).toBe(sweep.id)
      expect(updated.amount).toBe('15.0')
    })

    it('removes pending sweep entry', () => {
      const sweep = scheduleStealthSweep({
        oneTimePublicKey: oneTimeKp.publicKey(),
        oneTimeSecret: oneTimeKp.secret(),
        destinationContractAddress: VALID_DESTINATION_CONTRACT,
        amount: '5.0',
      })

      expect(getPendingStealthSweeps()).toHaveLength(1)
      removePendingStealthSweep(sweep.id)
      expect(getPendingStealthSweeps()).toHaveLength(0)
    })
  })

  describe('executeStealthSweep', () => {
    it('throws when sweep is not found', async () => {
      await expect(executeStealthSweep('nonexistent_id')).rejects.toThrow(/Stealth sweep not found/)
    })

    it('enforces delay unless force override is passed', async () => {
      const futureTime = Date.now() + 500000
      const sweep = scheduleStealthSweep({
        oneTimePublicKey: oneTimeKp.publicKey(),
        oneTimeSecret: oneTimeKp.secret(),
        destinationContractAddress: VALID_DESTINATION_CONTRACT,
        amount: '10.0',
        minDelaySeconds: 500,
        maxDelaySeconds: 1000,
      })

      await expect(executeStealthSweep(sweep.id, { force: false })).rejects.toThrow(
        /Sweep is delayed for decorrelation/,
      )
    })

    it('executes sweep with force override and purges one-time secret on completion', async () => {
      const sweep = scheduleStealthSweep({
        oneTimePublicKey: oneTimeKp.publicKey(),
        oneTimeSecret: oneTimeKp.secret(),
        destinationContractAddress: VALID_DESTINATION_CONTRACT,
        amount: '12.34',
        minDelaySeconds: 900,
        maxDelaySeconds: 1800,
      })

      mockGetAccount.mockResolvedValue({
        accountId: () => oneTimeKp.publicKey(),
        sequenceNumber: () => '100',
        incrementSequenceNumber: () => '101',
      })

      mockSimulateTransaction.mockResolvedValue({
        minResourceFee: '100',
        transactionData: { build: () => ({}) },
      })

      const mockAssembled = {
        sign: jest.fn(),
      }
      mockAssembleTransaction.mockReturnValue({
        build: () => mockAssembled,
      })

      mockSendTransaction.mockResolvedValue({
        status: 'PENDING',
        hash: '8f27ab9635f11cb208e8b9cd7469a91176b5c3b9b00cb3e20ecf9c2d15d65824',
      })

      const result = await executeStealthSweep(sweep.id, { force: true })

      expect(result.txHash).toBe('8f27ab9635f11cb208e8b9cd7469a91176b5c3b9b00cb3e20ecf9c2d15d65824')

      const stored = getPendingStealthSweeps()[0]
      expect(stored.status).toBe('completed')
      expect(stored.txHash).toBe('8f27ab9635f11cb208e8b9cd7469a91176b5c3b9b00cb3e20ecf9c2d15d65824')
      expect(stored.oneTimeSecret).toBe('') // Purged!
    })

    it('records failure and marks status failed on submission error', async () => {
      const sweep = scheduleStealthSweep({
        oneTimePublicKey: oneTimeKp.publicKey(),
        oneTimeSecret: oneTimeKp.secret(),
        destinationContractAddress: VALID_DESTINATION_CONTRACT,
        amount: '8.0',
      })

      mockGetAccount.mockRejectedValue(new Error('Network connection timeout'))

      await expect(executeStealthSweep(sweep.id, { force: true })).rejects.toThrow(
        /Network connection timeout/,
      )

      const stored = getPendingStealthSweeps()[0]
      expect(stored.status).toBe('failed')
      expect(stored.error).toContain('Network connection timeout')
    })
  })

  describe('honest linkage disclosure', () => {
    it('returns explicit lists of hidden guarantees and observable linkages', () => {
      const disclosure = getStealthLinkageDisclosure()

      expect(disclosure.title).toContain('Private Receipt')
      expect(disclosure.summary).toBeDefined()

      // Verifies hidden guarantees
      expect(disclosure.hiddenGuarantees.length).toBeGreaterThan(0)
      expect(disclosure.hiddenGuarantees.some((g) => g.toLowerCase().includes('sender'))).toBe(true)
      expect(disclosure.hiddenGuarantees.some((g) => g.toLowerCase().includes('delay') || g.toLowerCase().includes('timestamp'))).toBe(true)

      // Verifies honest disclosure of observer correlation
      expect(disclosure.observableLinkage.length).toBeGreaterThan(0)
      expect(disclosure.observableLinkage.some((l) => l.toLowerCase().includes('public stellar blockchain ledger') || l.toLowerCase().includes('ledger'))).toBe(true)
      expect(disclosure.observableLinkage.some((l) => l.toLowerCase().includes('graph') || l.toLowerCase().includes('address'))).toBe(true)

      // Verifies shielded pool recommendation
      expect(disclosure.recommendation).toContain('Shielded Pool')
    })
  })

  describe('cloud backup isolation', () => {
    it('never leaks ephemeral stealth secrets into wallet backup metadata', () => {
      mockStorage['invisible_wallet_address'] = VALID_DESTINATION_CONTRACT
      mockStorage['invisible_wallet_public_key'] = '04' + 'ab'.repeat(64)

      const secretSeed = oneTimeKp.secret()
      scheduleStealthSweep({
        oneTimePublicKey: oneTimeKp.publicKey(),
        oneTimeSecret: secretSeed,
        destinationContractAddress: VALID_DESTINATION_CONTRACT,
        amount: '100.0',
      })

      // Ensure storage has the pending sweep
      expect(mockStorage[STEALTH_PENDING_SWEEPS_STORAGE_KEY]).toContain(secretSeed)

      // Metadata collected for cloud backup must NOT include the stealth key
      const metadata = collectWalletMetadata()
      const json = JSON.stringify(metadata)

      expect(json).not.toContain(secretSeed)
      expect(json).not.toContain(STEALTH_PENDING_SWEEPS_STORAGE_KEY)
      expect(json).not.toContain(oneTimeKp.publicKey())
    })
  })
})

/**
 * @jest-environment jsdom
 */
import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import {
  Keypair,
  Account,
  xdr,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'
import {
  checkPrivacyEnrollment,
  enrolPrivacyPublicKey,
  getEnrollmentStorageKey,
} from '../enrollment'
import * as feePayer from '@/lib/feePayer'

describe('SPP Privacy Key Enrollment (V132 / #798)', () => {
  const originalEnv = process.env
  const mockAddress = 'CAUK4MWO3TTFM6PLURSH2GPK3AB747SZGABKTCVLKCU7W2MGKHKP35GA'
  const mockSigner = Keypair.random()

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...originalEnv, NEXT_PUBLIC_PRIVACY_FEATURE_FLAG: '1' }
    localStorage.clear()
    jest.spyOn(feePayer, 'getFeePayerMode').mockReturnValue('prf-raw')
    jest.spyOn(feePayer, 'peekFeePayerKeypair').mockReturnValue(mockSigner)
  })

  afterEach(() => {
    process.env = originalEnv
    jest.restoreAllMocks()
  })

  it('bypasses enrollment when privacy flag is off', async () => {
    process.env.NEXT_PUBLIC_PRIVACY_FEATURE_FLAG = '0'

    const checkRes = await checkPrivacyEnrollment({ address: mockAddress })
    expect(checkRes.enrolled).toBe(false)

    const enrolRes = await enrolPrivacyPublicKey({
      address: mockAddress,
      signerKeypair: mockSigner,
    })
    expect(enrolRes.success).toBe(false)
    expect(enrolRes.error).toContain('disabled')
  })

  it('bypasses enrollment on mainnet', async () => {
    const checkRes = await checkPrivacyEnrollment({
      address: mockAddress,
      networkName: 'mainnet',
    })
    expect(checkRes.enrolled).toBe(false)

    const enrolRes = await enrolPrivacyPublicKey({
      address: mockAddress,
      networkName: 'mainnet',
      signerKeypair: mockSigner,
    })
    expect(enrolRes.success).toBe(false)
  })

  it('detects already-cached enrollment in localStorage', async () => {
    const key = getEnrollmentStorageKey('testnet', mockAddress)
    localStorage.setItem(key, 'true')

    const mockServer = {
      simulateTransaction: jest.fn(),
    } as unknown as SorobanRpc.Server

    const res = await checkPrivacyEnrollment({
      address: mockAddress,
      rpcServer: mockServer,
    })

    expect(res.enrolled).toBe(true)
    expect(mockServer.simulateTransaction).not.toHaveBeenCalled()
  })

  it('probes on-chain registration on a restored wallet / new device and updates localStorage', async () => {
    const key = getEnrollmentStorageKey('testnet', mockAddress)
    expect(localStorage.getItem(key)).toBeNull()

    const mockServer = {
      simulateTransaction: jest.fn().mockResolvedValue({
        result: {
          retval: xdr.ScVal.scvBytes(Buffer.alloc(32, 1)),
        },
      }),
    } as unknown as SorobanRpc.Server

    const res = await checkPrivacyEnrollment({
      address: mockAddress,
      rpcServer: mockServer,
    })

    expect(res.enrolled).toBe(true)
    expect(mockServer.simulateTransaction).toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBe('true')
  })

  it('enrols a fresh wallet successfully and caches confirmation', async () => {
    const key = getEnrollmentStorageKey('testnet', mockAddress)
    expect(localStorage.getItem(key)).toBeNull()

    const expectedTxHash = 'a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0'

    const mockServer = {
      simulateTransaction: jest.fn().mockResolvedValue({
        result: {
          retval: null, // Initial probe: not registered yet
        },
        transactionData: {
          build: jest.fn(),
        },
        minResourceFee: '100',
      }),
      getAccount: jest.fn().mockResolvedValue(
        new Account(mockSigner.publicKey(), '1')
      ),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: expectedTxHash,
      }),
      getTransaction: jest.fn().mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      }),
    } as unknown as SorobanRpc.Server

    const res = await enrolPrivacyPublicKey({
      address: mockAddress,
      signerKeypair: mockSigner,
      rpcServer: mockServer,
    })

    expect(res.success).toBe(true)
    expect(res.alreadyEnrolled).toBe(false)
    expect(res.txHash).toBe(expectedTxHash)
    expect(localStorage.getItem(key)).toBe('true')
  })

  it('second enrolment is an idempotent no-op without submitting a transaction', async () => {
    const key = getEnrollmentStorageKey('testnet', mockAddress)
    localStorage.setItem(key, 'true')

    const mockServer = {
      sendTransaction: jest.fn(),
      simulateTransaction: jest.fn(),
    } as unknown as SorobanRpc.Server

    const res = await enrolPrivacyPublicKey({
      address: mockAddress,
      signerKeypair: mockSigner,
      rpcServer: mockServer,
    })

    expect(res.success).toBe(true)
    expect(res.alreadyEnrolled).toBe(true)
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
  })

  it('fails cleanly on simulation error without fabricating a hash or updating cache', async () => {
    const key = getEnrollmentStorageKey('testnet', mockAddress)

    const mockServer = {
      simulateTransaction: jest.fn()
        .mockResolvedValueOnce({
          result: { retval: null }, // initial check: not enrolled
        })
        .mockResolvedValueOnce({
          error: 'Host error: insufficient balance', // registration simulation failed
        }),
      getAccount: jest.fn().mockResolvedValue(
        new Account(mockSigner.publicKey(), '1')
      ),
      sendTransaction: jest.fn(),
    } as unknown as SorobanRpc.Server

    const res = await enrolPrivacyPublicKey({
      address: mockAddress,
      signerKeypair: mockSigner,
      rpcServer: mockServer,
    })

    expect(res.success).toBe(false)
    expect(res.error).toContain('Simulation failed')
    expect(mockServer.sendTransaction).not.toHaveBeenCalled()
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('fails cleanly on submission rejection without fabricating a hash or updating cache', async () => {
    const key = getEnrollmentStorageKey('testnet', mockAddress)

    const mockServer = {
      simulateTransaction: jest.fn()
        .mockResolvedValueOnce({
          result: { retval: null },
        })
        .mockResolvedValueOnce({
          result: { retval: xdr.ScVal.scvBool(true) },
          transactionData: { build: jest.fn() },
          minResourceFee: '100',
        }),
      getAccount: jest.fn().mockResolvedValue(
        new Account(mockSigner.publicKey(), '1')
      ),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'ERROR',
        errorResult: { toXDR: () => 'tx_bad_auth' },
      }),
    } as unknown as SorobanRpc.Server

    const res = await enrolPrivacyPublicKey({
      address: mockAddress,
      signerKeypair: mockSigner,
      rpcServer: mockServer,
    })

    expect(res.success).toBe(false)
    expect(res.error).toContain('Transaction rejected')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('fails cleanly when transaction execution fails on chain', async () => {
    const key = getEnrollmentStorageKey('testnet', mockAddress)
    const txHash = 'failed_tx_hash_12345'

    const mockServer = {
      simulateTransaction: jest.fn()
        .mockResolvedValueOnce({
          result: { retval: null },
        })
        .mockResolvedValueOnce({
          result: { retval: xdr.ScVal.scvBool(true) },
          transactionData: { build: jest.fn() },
          minResourceFee: '100',
        }),
      getAccount: jest.fn().mockResolvedValue(
        new Account(mockSigner.publicKey(), '1')
      ),
      sendTransaction: jest.fn().mockResolvedValue({
        status: 'PENDING',
        hash: txHash,
      }),
      getTransaction: jest.fn().mockResolvedValue({
        status: SorobanRpc.Api.GetTransactionStatus.FAILED,
      }),
    } as unknown as SorobanRpc.Server

    const res = await enrolPrivacyPublicKey({
      address: mockAddress,
      signerKeypair: mockSigner,
      rpcServer: mockServer,
    })

    expect(res.success).toBe(false)
    expect(res.error).toContain('failed on chain')
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('refuses enrollment when signer is in legacy mode', async () => {
    jest.spyOn(feePayer, 'getFeePayerMode').mockReturnValue('legacy')

    const mockServer = {
      simulateTransaction: jest.fn().mockResolvedValue({
        result: { retval: null },
      }),
    } as unknown as SorobanRpc.Server

    const res = await enrolPrivacyPublicKey({
      address: mockAddress,
      signerKeypair: mockSigner,
      rpcServer: mockServer,
    })

    expect(res.success).toBe(false)
    expect(res.error).toContain('Passkey does not support PRF key derivation')
  })
})

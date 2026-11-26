import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Keypair } from '@stellar/stellar-sdk'
import { previewBillSpendFee, sendBillPayment } from '../billSpend'

const mockFeePayerKeypair = Keypair.random()
const mockDestination = Keypair.random().publicKey()
const mockFeeDestination = Keypair.random().publicKey()

jest.mock('@/lib/network', () => ({
  getNetwork: () => ({
    name: 'mainnet',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
  }),
}))

jest.mock('@/lib/fees', () => ({
  inclusionFee: () => '100',
}))

jest.mock('@/lib/passkeyAuth', () => ({
  requirePasskey: jest.fn(async () => undefined),
}))

const mockFetchPlatformFee = jest.fn()
jest.mock('@/lib/platformFee', () => ({
  fetchPlatformFee: (...args: unknown[]) => mockFetchPlatformFee(...args),
}))

const mockSubmitTransaction = jest.fn()
const mockLoadAccount = jest.fn()

jest.mock('@stellar/stellar-sdk', () => {
  const actual = jest.requireActual('@stellar/stellar-sdk')
  const MockServer = jest.fn().mockImplementation(() => ({
    loadAccount: mockLoadAccount,
    submitTransaction: mockSubmitTransaction,
  }))
  return {
    ...actual,
    Server: MockServer,
    Horizon: {
      ...actual.Horizon,
      Server: MockServer,
    },
  }
})

describe('billSpend', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSubmitTransaction.mockResolvedValue({ hash: '0xtxhash_mock_123' })
  })

  describe('previewBillSpendFee', () => {
    it('returns platform fee when fee-payer balance can cover amount + fee', async () => {
      mockFetchPlatformFee.mockResolvedValue({
        amount: '0.1',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destination: mockFeeDestination,
      })

      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            balance: '10.0',
          },
        ],
      })

      const fee = await previewBillSpendFee({
        amount: '5.0',
        coin: 'usdc',
        feePayerAddress: mockFeePayerKeypair.publicKey(),
      })

      expect(fee).toEqual({
        amount: '0.1',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destination: mockFeeDestination,
      })
    })

    it('returns null when balance cannot cover amount + fee', async () => {
      mockFetchPlatformFee.mockResolvedValue({
        amount: '1.0',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destination: mockFeeDestination,
      })

      mockLoadAccount.mockResolvedValue({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            balance: '5.0',
          },
        ],
      })

      const fee = await previewBillSpendFee({
        amount: '4.5', // 4.5 + 1.0 = 5.5 > 5.0
        coin: 'usdc',
        feePayerAddress: mockFeePayerKeypair.publicKey(),
      })

      expect(fee).toBeNull()
    })

    it('returns null when fee is not configured or fails', async () => {
      mockFetchPlatformFee.mockResolvedValue(null)

      const fee = await previewBillSpendFee({
        amount: '5.0',
        coin: 'xlm',
        feePayerAddress: mockFeePayerKeypair.publicKey(),
      })

      expect(fee).toBeNull()
    })
  })

  describe('sendBillPayment', () => {
    it('submits payment to destination with platform fee when affordable', async () => {
      mockFetchPlatformFee.mockResolvedValue({
        amount: '0.05',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destination: mockFeeDestination,
      })

      mockLoadAccount.mockResolvedValue({
        accountId: () => mockFeePayerKeypair.publicKey(),
        sequenceNumber: () => '100',
        incrementSequenceNumber: () => {},
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            balance: '20.0',
          },
        ],
      })

      const hash = await sendBillPayment({
        destination: mockDestination,
        amount: '2.5',
        coin: 'usdc',
        signerSecret: mockFeePayerKeypair.secret(),
        skipPasskey: true,
      })

      expect(hash).toBe('0xtxhash_mock_123')
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1)
      const submittedTx = mockSubmitTransaction.mock.calls[0][0]
      // Should have 2 operations: recipient payment + platform fee
      expect(submittedTx.operations).toHaveLength(2)
      expect(submittedTx.operations[0].destination).toBe(mockDestination)
      expect(submittedTx.operations[0].amount).toBe('2.5000000')
      expect(submittedTx.operations[1].destination).toBe(mockFeeDestination)
      expect(submittedTx.operations[1].amount).toBe('0.0500000')
    })

    it('submits payment without platform fee when fee would cause insufficient balance', async () => {
      mockFetchPlatformFee.mockResolvedValue({
        amount: '0.5',
        assetCode: 'USDC',
        assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        destination: mockFeeDestination,
      })

      mockLoadAccount.mockResolvedValue({
        accountId: () => mockFeePayerKeypair.publicKey(),
        sequenceNumber: () => '100',
        incrementSequenceNumber: () => {},
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            balance: '3.0',
          },
        ],
      })

      const hash = await sendBillPayment({
        destination: mockDestination,
        amount: '2.8', // 2.8 + 0.5 = 3.3 > 3.0, fee not added
        coin: 'usdc',
        signerSecret: mockFeePayerKeypair.secret(),
        skipPasskey: true,
      })

      expect(hash).toBe('0xtxhash_mock_123')
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1)
      const submittedTx = mockSubmitTransaction.mock.calls[0][0]
      // Only 1 operation (payment), no fee
      expect(submittedTx.operations).toHaveLength(1)
      expect(submittedTx.operations[0].destination).toBe(mockDestination)
      expect(submittedTx.operations[0].amount).toBe('2.8000000')
    })

    it('throws error if wallet balance cannot cover the payment amount', async () => {
      mockLoadAccount.mockResolvedValue({
        accountId: () => mockFeePayerKeypair.publicKey(),
        sequenceNumber: () => '100',
        incrementSequenceNumber: () => {},
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            balance: '1.0',
          },
        ],
      })

      await expect(
        sendBillPayment({
          destination: mockDestination,
          amount: '5.0',
          coin: 'usdc',
          signerSecret: mockFeePayerKeypair.secret(),
          skipPasskey: true,
        }),
      ).rejects.toThrow(/less than this top-up needs/)

      expect(mockSubmitTransaction).not.toHaveBeenCalled()
    })
  })
})

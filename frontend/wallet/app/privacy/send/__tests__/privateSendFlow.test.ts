/**
 * Tests for the Private Send Flow logic and Acceptance Criteria (#716).
 */

if (typeof TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util')
  global.TextEncoder = TextEncoder
  global.TextDecoder = TextDecoder
}

import {
  lookupRecipient,
  registerWalletPrivacy,
  getPrivateBalance,
  setPrivateBalance,
  executePrivateSend,
  getPrivateExplorerDetails,
  parsePrivacyError,
  resetPrivacyStore,
} from '@/lib/privacy/client'
import {
  isPrivacySupportedOnNetwork,
  SPP_TESTNET_CONFIG,
} from '@/lib/privacy/config'
import { Networks } from '@stellar/stellar-sdk'

describe('Private Send Flow (Issue #716)', () => {
  const SENDER_ADDR = 'GCMVDH4OXFPZWDXFALZKXXAQWR56ZN3TXCYCNYOXD5JDWX22QSTHY226'
  const REGISTERED_RECIPIENT = 'GATP64QMC2BIFWL3PI4DKDAMKA4HYTHHJ437R2U4VGIYEUHIHU6PRCLF'
  const UNREGISTERED_RECIPIENT = 'GCT2V4ONHF2Z2PUWS3LDL6DYIQPLBTXA4SWTAJ54Y6FSXXT2U7BFQDQO'

  beforeEach(() => {
    resetPrivacyStore()
  })

  afterEach(() => {
    resetPrivacyStore()
  })

  describe('Step 1: Choose recipient and look up in SPP Public-Key Registry', () => {
    it('identifies unregistered recipient and formats standard send fallback', async () => {
      // Recipient is not in registry
      const lookup = await lookupRecipient(UNREGISTERED_RECIPIENT)
      expect(lookup.registered).toBe(false)
      expect(lookup.reason).toMatch(/not registered/i)

      // Fallback: format standard send url
      const amount = '15.00'
      const fallbackUrl = `/send?to=${encodeURIComponent(UNREGISTERED_RECIPIENT)}&amount=${encodeURIComponent(amount)}`
      expect(fallbackUrl).toBe(
        `/send?to=${UNREGISTERED_RECIPIENT}&amount=15.00`
      )
    })

    it('identifies registered recipient and verifies privacy public key', async () => {
      // Register recipient
      const entry = registerWalletPrivacy(REGISTERED_RECIPIENT)
      expect(entry.privacyPublicKey).toBeDefined()

      const lookup = await lookupRecipient(REGISTERED_RECIPIENT)
      expect(lookup.registered).toBe(true)
      expect(lookup.privacyPublicKey).toBe(entry.privacyPublicKey)
    })
  })

  describe('Step 2 & 3: Amount, Review, and Balance Constraints', () => {
    it('validates amount against available private balance', async () => {
      setPrivateBalance(SENDER_ADDR, '50.00', 'XLM')
      const bal = await getPrivateBalance(SENDER_ADDR, 'XLM')
      expect(bal.balance).toBe('50.00')

      // Attempting to send 60.00 XLM exceeds 50.00
      registerWalletPrivacy(REGISTERED_RECIPIENT)
      await expect(
        executePrivateSend({
          senderAddress: SENDER_ADDR,
          recipientAddress: REGISTERED_RECIPIENT,
          amount: '60.00',
          assetCode: 'XLM',
        })
      ).rejects.toThrow(/Insufficient private balance/)
    })
  })

  describe('Acceptance Criterion 1: Two testnet wallets complete a private send; recipient private balance increases', () => {
    it('successfully transfers private value between two testnet wallets', async () => {
      registerWalletPrivacy(SENDER_ADDR)
      registerWalletPrivacy(REGISTERED_RECIPIENT)

      setPrivateBalance(SENDER_ADDR, '100.00', 'XLM')
      setPrivateBalance(REGISTERED_RECIPIENT, '20.00', 'XLM')

      const sendAmount = '35.00'
      const result = await executePrivateSend({
        senderAddress: SENDER_ADDR,
        recipientAddress: REGISTERED_RECIPIENT,
        amount: sendAmount,
        assetCode: 'XLM',
      })

      expect(result.isPrivate).toBe(true)
      expect(result.amount).toBe('35.00')
      expect(result.txHash).toHaveLength(64)
      expect(result.nullifier).toBeDefined()
      expect(result.commitment).toBeDefined()

      // Sender balance decreased
      const senderBal = await getPrivateBalance(SENDER_ADDR, 'XLM')
      expect(senderBal.balance).toBe('65.00')

      // Recipient balance increased
      const recipientBal = await getPrivateBalance(REGISTERED_RECIPIENT, 'XLM')
      expect(recipientBal.balance).toBe('55.00')
    })
  })

  describe('Acceptance Criterion 2: Explorer entry shows neither amount nor recipient', () => {
    it('verifies on-chain public fields completely omit amount and recipient', async () => {
      registerWalletPrivacy(SENDER_ADDR)
      registerWalletPrivacy(REGISTERED_RECIPIENT)
      setPrivateBalance(SENDER_ADDR, '100.00', 'XLM')

      const result = await executePrivateSend({
        senderAddress: SENDER_ADDR,
        recipientAddress: REGISTERED_RECIPIENT,
        amount: '10.00',
        assetCode: 'XLM',
      })

      const explorerView = getPrivateExplorerDetails(result.txHash)
      expect(explorerView.publicAmount).toBeNull()
      expect(explorerView.publicRecipient).toBeNull()
      expect(explorerView.contractId).toBe(SPP_TESTNET_CONFIG.pools.XLM)
      expect(explorerView.functionName).toBe('transact')
      expect(explorerView.nullifierHash).toBeDefined()
      expect(explorerView.commitmentHash).toBeDefined()
    })
  })

  describe('Acceptance Criterion 3: Unregistered recipient is handled with clear message and fallback', () => {
    it('blocks execution for unregistered recipient with user-friendly message', async () => {
      registerWalletPrivacy(SENDER_ADDR)
      setPrivateBalance(SENDER_ADDR, '100.00', 'XLM')

      try {
        await executePrivateSend({
          senderAddress: SENDER_ADDR,
          recipientAddress: UNREGISTERED_RECIPIENT,
          amount: '10.00',
          assetCode: 'XLM',
        })
        fail('Should have thrown')
      } catch (err) {
        const userMsg = parsePrivacyError(err)
        expect(userMsg).toContain('has not registered their privacy keys')
        expect(userMsg).toContain('send via standard transfer')
      }
    })
  })

  describe('Network Rules', () => {
    it('allows privacy on Testnet and locks out Mainnet', () => {
      expect(isPrivacySupportedOnNetwork(Networks.TESTNET)).toBe(true)
      expect(isPrivacySupportedOnNetwork(Networks.PUBLIC)).toBe(false)
    })
  })
})

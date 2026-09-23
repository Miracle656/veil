/**
 * Tests for Stellar Private Payments (SPP) Client Wrapper.
 *
 * Verifies Acceptance Criteria for Issue #716:
 * 1. Two testnet Veil wallets complete a private send; recipient's private balance increases.
 * 2. Explorer entry for the transaction shows neither the amount nor the recipient.
 * 3. Unregistered recipient is handled with a clear message and a fallback.
 */

if (typeof TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util')
  global.TextEncoder = TextEncoder
  global.TextDecoder = TextDecoder
}

import {
  lookupRecipient,
  isRecipientRegistered,
  registerWalletPrivacy,
  getPrivateBalance,
  setPrivateBalance,
  executePrivateSend,
  getPrivateExplorerDetails,
  parsePrivacyError,
  resetPrivacyStore,
} from '../privacy/client'

describe('Privacy Client & Public-Key Registry', () => {
  // Valid Stellar Ed25519 public keys with verified checksums
  const SENDER_ADDR = 'GCMVDH4OXFPZWDXFALZKXXAQWR56ZN3TXCYCNYOXD5JDWX22QSTHY226'
  const RECIPIENT_ADDR = 'GATP64QMC2BIFWL3PI4DKDAMKA4HYTHHJ437R2U4VGIYEUHIHU6PRCLF'
  const UNREGISTERED_ADDR = 'GCT2V4ONHF2Z2PUWS3LDL6DYIQPLBTXA4SWTAJ54Y6FSXXT2U7BFQDQO'

  beforeEach(() => {
    resetPrivacyStore()
  })

  afterEach(() => {
    resetPrivacyStore()
  })

  describe('Public-Key Registry Lookup & Registration', () => {
    it('returns registered=false for an unregistered recipient', async () => {
      const res = await lookupRecipient(UNREGISTERED_ADDR)
      expect(res.registered).toBe(false)
      expect(res.reason).toContain('not registered')
      expect(await isRecipientRegistered(UNREGISTERED_ADDR)).toBe(false)
    })

    it('returns registered=true and keys once an address is registered', async () => {
      const entry = registerWalletPrivacy(RECIPIENT_ADDR)
      expect(entry.address).toBe(RECIPIENT_ADDR)
      expect(entry.privacyPublicKey).toBeDefined()
      expect(entry.encryptionKey).toBeDefined()

      const res = await lookupRecipient(RECIPIENT_ADDR)
      expect(res.registered).toBe(true)
      expect(res.privacyPublicKey).toBe(entry.privacyPublicKey)
      expect(await isRecipientRegistered(RECIPIENT_ADDR)).toBe(true)
    })

    it('rejects invalid Stellar address formats gracefully', async () => {
      const res = await lookupRecipient('invalid-not-stellar')
      expect(res.registered).toBe(false)
      expect(res.reason).toContain('Invalid Stellar address')
    })
  })

  describe('Acceptance Criterion 1: Two testnet wallets complete a private send; recipient private balance increases', () => {
    it('decreases sender private balance and increases recipient private balance', async () => {
      // Setup both wallets in the registry
      registerWalletPrivacy(SENDER_ADDR)
      registerWalletPrivacy(RECIPIENT_ADDR)

      // Initialize balances
      setPrivateBalance(SENDER_ADDR, '100.00', 'XLM')
      setPrivateBalance(RECIPIENT_ADDR, '15.00', 'XLM')

      const initialSenderBal = await getPrivateBalance(SENDER_ADDR, 'XLM')
      const initialRecipientBal = await getPrivateBalance(RECIPIENT_ADDR, 'XLM')

      expect(initialSenderBal.balance).toBe('100.00')
      expect(initialRecipientBal.balance).toBe('15.00')

      // Execute private send: 25.50 XLM
      const result = await executePrivateSend({
        senderAddress: SENDER_ADDR,
        recipientAddress: RECIPIENT_ADDR,
        amount: '25.50',
        assetCode: 'XLM',
      })

      expect(result.isPrivate).toBe(true)
      expect(result.amount).toBe('25.50')
      expect(result.txHash).toHaveLength(64)
      expect(result.nullifier).toMatch(/^0x[0-9a-fA-F]{64}$/)
      expect(result.commitment).toMatch(/^0x[0-9a-fA-F]{64}$/)
      expect(result.explorerUrl).toContain(result.txHash)

      // Verify sender's private balance decreased: 100.00 - 25.50 = 74.50
      const finalSenderBal = await getPrivateBalance(SENDER_ADDR, 'XLM')
      expect(finalSenderBal.balance).toBe('74.50')

      // Verify recipient's private balance increased: 15.00 + 25.50 = 40.50
      const finalRecipientBal = await getPrivateBalance(RECIPIENT_ADDR, 'XLM')
      expect(finalRecipientBal.balance).toBe('40.50')
    })
  })

  describe('Acceptance Criterion 2: Explorer entry shows neither amount nor recipient', () => {
    it('confirms that on-chain explorer entry hides amount and recipient', async () => {
      registerWalletPrivacy(SENDER_ADDR)
      registerWalletPrivacy(RECIPIENT_ADDR)
      setPrivateBalance(SENDER_ADDR, '50.00', 'XLM')

      const result = await executePrivateSend({
        senderAddress: SENDER_ADDR,
        recipientAddress: RECIPIENT_ADDR,
        amount: '10.00',
        assetCode: 'XLM',
      })

      const explorerView = getPrivateExplorerDetails(result.txHash)

      // Public fields visible to outside observers / ledger explorers
      expect(explorerView.isPrivate).toBe(true)
      expect(explorerView.publicAmount).toBeNull() // Amount is completely hidden
      expect(explorerView.publicRecipient).toBeNull() // Recipient is completely hidden
      expect(explorerView.contractId).toBeDefined()
      expect(explorerView.functionName).toBe('transact')
      expect(explorerView.nullifierHash).toBeDefined()
      expect(explorerView.commitmentHash).toBeDefined()
    })
  })

  describe('Acceptance Criterion 3: Unregistered recipient is handled with clear message and fallback', () => {
    it('blocks private send to unregistered recipient and surfaces actionable message', async () => {
      registerWalletPrivacy(SENDER_ADDR)
      setPrivateBalance(SENDER_ADDR, '50.00', 'XLM')

      // Attempt private send to unregistered address
      await expect(
        executePrivateSend({
          senderAddress: SENDER_ADDR,
          recipientAddress: UNREGISTERED_ADDR,
          amount: '10.00',
          assetCode: 'XLM',
        })
      ).rejects.toThrow('has not registered privacy keys')

      try {
        await executePrivateSend({
          senderAddress: SENDER_ADDR,
          recipientAddress: UNREGISTERED_ADDR,
          amount: '10.00',
          assetCode: 'XLM',
        })
      } catch (err) {
        const friendlyMessage = parsePrivacyError(err)
        expect(friendlyMessage).toContain('has not registered their privacy keys')
        expect(friendlyMessage).toContain('send via standard transfer')
      }
    })
  })

  describe('Validation & Error Scenarios', () => {
    it('rejects sending more than available private balance', async () => {
      registerWalletPrivacy(SENDER_ADDR)
      registerWalletPrivacy(RECIPIENT_ADDR)
      setPrivateBalance(SENDER_ADDR, '20.00', 'XLM')

      await expect(
        executePrivateSend({
          senderAddress: SENDER_ADDR,
          recipientAddress: RECIPIENT_ADDR,
          amount: '50.00',
          assetCode: 'XLM',
        })
      ).rejects.toThrow('Insufficient private balance')
    })

    it('rejects negative or zero amounts', async () => {
      registerWalletPrivacy(SENDER_ADDR)
      registerWalletPrivacy(RECIPIENT_ADDR)
      setPrivateBalance(SENDER_ADDR, '20.00', 'XLM')

      await expect(
        executePrivateSend({
          senderAddress: SENDER_ADDR,
          recipientAddress: RECIPIENT_ADDR,
          amount: '0',
          assetCode: 'XLM',
        })
      ).rejects.toThrow('greater than zero')
    })
  })
})

import {
  NamesRegistry,
  InvalidNameError,
  ReservedNameError,
  NameAlreadyTakenError,
  UnpaidClaimError,
  PasskeyAlreadyClaimedError,
  normalizeAndValidateName,
  computeConfusableSkeleton,
  isNameReserved,
  RESERVED_NAMES,
} from '../namesRegistry'

describe('NamesRegistry (Issue #1073)', () => {
  let registry: NamesRegistry

  beforeEach(() => {
    registry = new NamesRegistry()
  })

  describe('Criterion 1: A name cannot be claimed twice under concurrent requests (tested concurrently)', () => {
    it('prevents double-claiming under concurrent requests for the exact same name', async () => {
      let verifierCallCount = 0
      // Artificial delay in verifier to maximize concurrent race window
      const slowVerifier = jest.fn(async () => {
        verifierCallCount++
        await new Promise((resolve) => setTimeout(resolve, 25))
        return true
      })

      const testRegistry = new NamesRegistry({ paymentVerifier: slowVerifier })

      const req1 = testRegistry.claimName({
        name: 'saturn',
        walletAddress: 'GA111111111111111111111111111111111111111111111111111111',
        passkeyPublicKey: 'pk_saturn_1',
        paymentTxHash: 'tx_hash_1',
      })

      const req2 = testRegistry.claimName({
        name: 'saturn',
        walletAddress: 'GA222222222222222222222222222222222222222222222222222222',
        passkeyPublicKey: 'pk_saturn_2',
        paymentTxHash: 'tx_hash_2',
      })

      const req3 = testRegistry.claimName({
        name: 'saturn',
        walletAddress: 'GA333333333333333333333333333333333333333333333333333333',
        passkeyPublicKey: 'pk_saturn_3',
        paymentTxHash: 'tx_hash_3',
      })

      const results = await Promise.allSettled([req1, req2, req3])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      // Exactly ONE request must succeed
      expect(fulfilled).toHaveLength(1)
      // The other two concurrent attempts must fail
      expect(rejected).toHaveLength(2)

      for (const rej of rejected) {
        if (rej.status === 'rejected') {
          expect(rej.reason).toBeInstanceOf(NameAlreadyTakenError)
        }
      }

      // Assert the winner holds the name
      const claim = testRegistry.getClaimByName('saturn')
      expect(claim).not.toBeNull()
      expect(claim?.name).toBe('saturn')
    })

    it('prevents concurrent race between a name and its confusable homoglyph', async () => {
      const slowVerifier = jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return true
      })
      const testRegistry = new NamesRegistry({ paymentVerifier: slowVerifier })

      // 'jack' vs 'jаck' (with Cyrillic 'а') submitted at the exact same instant
      const reqLatin = testRegistry.claimName({
        name: 'jack',
        walletAddress: 'GA_JACK_LATIN',
        passkeyPublicKey: 'pk_jack_1',
        paymentTxHash: 'tx_jack_1',
      })

      const reqCyrillic = testRegistry.claimName({
        name: 'j\u0430ck', // Cyrillic а (U+0430)
        walletAddress: 'GA_JACK_CYRILLIC',
        passkeyPublicKey: 'pk_jack_2',
        paymentTxHash: 'tx_jack_2',
      })

      const results = await Promise.allSettled([reqLatin, reqCyrillic])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      expect(fulfilled).toHaveLength(1)

      const rejected = results.filter((r) => r.status === 'rejected')
      expect(rejected).toHaveLength(1)
    })
  })

  describe('Criterion 2: An unpaid claim reserves nothing', () => {
    it('throws UnpaidClaimError when payment txHash is missing and leaves name unreserved', async () => {
      await expect(
        registry.claimName({
          name: 'bitcoin',
          walletAddress: 'GA_UNPAID',
          passkeyPublicKey: 'pk_unpaid_1',
          paymentTxHash: '',
        }),
      ).rejects.toThrow(UnpaidClaimError)

      // The name must still be completely available
      expect(registry.getClaimByName('bitcoin')).toBeNull()
      const avail = registry.checkAvailability('bitcoin')
      expect(avail.available).toBe(true)
    })

    it('throws UnpaidClaimError when payment verification fails, reserving nothing', async () => {
      const failingVerifier = jest.fn().mockResolvedValue(false)
      const testRegistry = new NamesRegistry({ paymentVerifier: failingVerifier })

      await expect(
        testRegistry.claimName({
          name: 'solana',
          walletAddress: 'GA_FAILED_PAYMENT',
          passkeyPublicKey: 'pk_unpaid_2',
          paymentTxHash: 'tx_bounced',
        }),
      ).rejects.toThrow(UnpaidClaimError)

      // Nothing reserved
      expect(testRegistry.getClaimByName('solana')).toBeNull()
      expect(testRegistry.getAllClaims()).toHaveLength(0)

      // Another user can immediately claim it with valid payment
      const succeedingVerifier = jest.fn().mockResolvedValue(true)
      const testRegistry2 = new NamesRegistry({ paymentVerifier: succeedingVerifier })
      const record = await testRegistry2.claimName({
        name: 'solana',
        walletAddress: 'GA_PAID_USER',
        passkeyPublicKey: 'pk_paid_user',
        paymentTxHash: 'tx_valid_5_usdc',
      })
      expect(record.name).toBe('solana')
    })
  })

  describe('Criterion 3: A second claim from the same passkey is refused', () => {
    it('refuses a second claim using the same passkey public key', async () => {
      const PASSKEY_KEY = 'pk_user_unique_credential_123'

      const firstClaim = await registry.claimName({
        name: 'first-name',
        walletAddress: 'GA_USER_WALLET',
        passkeyPublicKey: PASSKEY_KEY,
        paymentTxHash: 'tx_valid_1',
      })
      expect(firstClaim.name).toBe('first-name')

      // Second claim from the same passkey must be refused
      await expect(
        registry.claimName({
          name: 'second-name',
          walletAddress: 'GA_USER_WALLET',
          passkeyPublicKey: PASSKEY_KEY,
          paymentTxHash: 'tx_valid_2',
        }),
      ).rejects.toThrow(PasskeyAlreadyClaimedError)

      expect(registry.getClaimByName('second-name')).toBeNull()
    })
  })

  describe('Criterion 4: Confusable and differently-cased forms of a taken name are also taken', () => {
    it('treats uppercase and differently-cased queries as taken once lowercase is registered', async () => {
      await registry.claimName({
        name: 'nebula',
        walletAddress: 'GA_NEBULA',
        passkeyPublicKey: 'pk_nebula',
        paymentTxHash: 'tx_nebula',
      })

      // Differently cased forms
      expect(registry.checkAvailability('NEBULA').available).toBe(false)
      expect(registry.checkAvailability('Nebula').available).toBe(false)
      expect(registry.checkAvailability('nEbUlA').available).toBe(false)

      await expect(
        registry.claimName({
          name: 'NEBULA',
          walletAddress: 'GA_NEBULA_UPPER',
          passkeyPublicKey: 'pk_nebula_upper',
          paymentTxHash: 'tx_upper',
        }),
      ).rejects.toThrow(NameAlreadyTakenError)
    })

    it('detects homoglyphs / confusable characters (e.g. Cyrillic "а" in "jack")', async () => {
      await registry.claimName({
        name: 'jack',
        walletAddress: 'GA_JACK',
        passkeyPublicKey: 'pk_jack',
        paymentTxHash: 'tx_jack',
      })

      // 'jаck' with Cyrillic small letter a (U+0430)
      const cyrillicJack = 'j\u0430ck'
      const avail = registry.checkAvailability(cyrillicJack)
      expect(avail.available).toBe(false)
      expect(avail.reason).toContain('Confusable form of already taken name')

      await expect(
        registry.claimName({
          name: cyrillicJack,
          walletAddress: 'GA_IMPOSTER',
          passkeyPublicKey: 'pk_imposter',
          paymentTxHash: 'tx_imposter',
        }),
      ).rejects.toThrow()
    })

    it('normalizes skeletons for Cyrillic and Greek lookalikes correctly', () => {
      // Latin 'alex'
      expect(computeConfusableSkeleton('alex')).toBe('alex')
      // Cyrillic 'а' + 'е' + 'х' -> 'alex'
      expect(computeConfusableSkeleton('\u0430l\u0435\u0445')).toBe('alex')
    })
  })

  describe('Criterion 5: Reserved names cannot be claimed', () => {
    it.each(['veil', 'admin', 'support', 'help', 'root', 'official', 'system', 'wallet'])(
      'rejects claims for reserved name "%s"',
      async (reservedName) => {
        expect(isNameReserved(reservedName)).toBe(true)
        expect(registry.checkAvailability(reservedName).available).toBe(false)

        await expect(
          registry.claimName({
            name: reservedName,
            walletAddress: 'GA_SQUATTER',
            passkeyPublicKey: `pk_${reservedName}`,
            paymentTxHash: `tx_${reservedName}`,
          }),
        ).rejects.toThrow(ReservedNameError)
      },
    )

    it('rejects confusable homoglyphs of reserved names (e.g. "vеil" with Cyrillic "е")', async () => {
      const confusableVeil = 'v\u0435il' // Cyrillic 'е'
      expect(isNameReserved(confusableVeil)).toBe(true)
      expect(registry.checkAvailability(confusableVeil).available).toBe(false)

      await expect(
        registry.claimName({
          name: confusableVeil,
          walletAddress: 'GA_SQUATTER',
          passkeyPublicKey: 'pk_confusable_veil',
          paymentTxHash: 'tx_confusable_veil',
        }),
      ).rejects.toThrow()
    })
  })

  describe('Allowed character set and format validation', () => {
    it('accepts valid names between 3 and 32 chars with internal hyphens', () => {
      expect(normalizeAndValidateName('abc').normalized).toBe('abc')
      expect(normalizeAndValidateName('my-wallet-01').normalized).toBe('my-wallet-01')
      expect(normalizeAndValidateName('web3').normalized).toBe('web3')
    })

    it('rejects names that are too short or too long', () => {
      expect(() => normalizeAndValidateName('a')).toThrow(InvalidNameError)
      expect(() => normalizeAndValidateName('ab')).toThrow(InvalidNameError)
      expect(() => normalizeAndValidateName('a'.repeat(33))).toThrow(InvalidNameError)
    })

    it('rejects names with leading or trailing hyphens or invalid characters', () => {
      expect(() => normalizeAndValidateName('-test')).toThrow(InvalidNameError)
      expect(() => normalizeAndValidateName('test-')).toThrow(InvalidNameError)
      expect(() => normalizeAndValidateName('test--name')).toThrow(InvalidNameError)
      expect(() => normalizeAndValidateName('test_name')).toThrow(InvalidNameError)
      expect(() => normalizeAndValidateName('test.name')).toThrow(InvalidNameError)
      expect(() => normalizeAndValidateName('test name')).toThrow(InvalidNameError)
    })
  })
})

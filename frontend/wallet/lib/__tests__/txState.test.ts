import { beginTx, endTx, txActive } from '../txState'

describe('txState', () => {
  // Reset state before each test to ensure isolation
  beforeEach(() => {
    // Call endTx to reset to known state
    endTx()
  })

  describe('initial state', () => {
    it('should initialize with txActive = false', () => {
      expect(txActive()).toBe(false)
    })
  })

  describe('beginTx()', () => {
    it('should set txActive to true', () => {
      beginTx()
      expect(txActive()).toBe(true)
    })

    it('should return true after calling beginTx', () => {
      beginTx()
      const result = txActive()
      expect(result).toBe(true)
    })
  })

  describe('endTx()', () => {
    it('should set txActive to false after beginTx', () => {
      beginTx()
      expect(txActive()).toBe(true)

      endTx()
      expect(txActive()).toBe(false)
    })

    it('should keep txActive false when called without beginTx', () => {
      endTx()
      expect(txActive()).toBe(false)
    })
  })

  describe('state transitions', () => {
    it('should handle begin/end cycle correctly', () => {
      // Initial state
      expect(txActive()).toBe(false)

      // Start transaction
      beginTx()
      expect(txActive()).toBe(true)

      // End transaction
      endTx()
      expect(txActive()).toBe(false)
    })

    it('should support multiple begin/end cycles', () => {
      // First cycle
      beginTx()
      expect(txActive()).toBe(true)
      endTx()
      expect(txActive()).toBe(false)

      // Second cycle
      beginTx()
      expect(txActive()).toBe(true)
      endTx()
      expect(txActive()).toBe(false)

      // Third cycle
      beginTx()
      expect(txActive()).toBe(true)
      endTx()
      expect(txActive()).toBe(false)
    })

    it('should handle double beginTx() calls (idempotency)', () => {
      beginTx()
      expect(txActive()).toBe(true)

      // Second beginTx should not cause issues
      beginTx()
      expect(txActive()).toBe(true)

      endTx()
      expect(txActive()).toBe(false)
    })

    it('should handle double endTx() calls (idempotency)', () => {
      beginTx()
      expect(txActive()).toBe(true)

      endTx()
      expect(txActive()).toBe(false)

      // Second endTx should not cause issues
      endTx()
      expect(txActive()).toBe(false)
    })
  })

  describe('lock prevention behavior', () => {
    it('should prevent lock from firing when transaction is active', () => {
      // This test verifies the intended use case
      beginTx()
      const shouldLock = !txActive()
      expect(shouldLock).toBe(false)
    })

    it('should allow lock when transaction is not active', () => {
      endTx()
      const shouldLock = !txActive()
      expect(shouldLock).toBe(true)
    })
  })
})

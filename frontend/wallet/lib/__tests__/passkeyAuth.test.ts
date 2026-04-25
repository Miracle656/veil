import { requirePasskey } from '../passkeyAuth'

describe('requirePasskey', () => {
  // Mock localStorage
  const localStorageMock = (() => {
    let store: Record<string, string> = {}
    return {
      getItem: (key: string) => store[key] || null,
      setItem: (key: string, value: string) => {
        store[key] = value.toString()
      },
      removeItem: (key: string) => {
        delete store[key]
      },
      clear: () => {
        store = {}
      },
    }
  })()

  // Mock navigator.credentials.get
  const originalNavigator = window.navigator
  const mockCredentialsGet = jest.fn()

  // Mock crypto.getRandomValues
  const mockGetRandomValues = jest.fn()

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks()
    localStorageMock.clear()

    // Set up localStorage mock
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      writable: true,
    })

    // Set up navigator.credentials mock
    Object.defineProperty(navigator, 'credentials', {
      value: {
        get: mockCredentialsGet,
      },
      configurable: true,
    })

    // Set up crypto.getRandomValues mock to return predictable values
    mockGetRandomValues.mockImplementation((arr: Uint8Array) => {
      // Fill with sequential values for predictability in tests
      for (let i = 0; i < arr.length; i++) {
        arr[i] = i % 256
      }
      return arr
    })

    Object.defineProperty(global.crypto, 'getRandomValues', {
      value: mockGetRandomValues,
      configurable: true,
    })
  })

  afterEach(() => {
    // Clean up
    Object.defineProperty(window, 'localStorage', {
      value: Storage.prototype,
      writable: true,
    })
  })

  describe('prerequisites', () => {
    it('should throw error when no passkey is registered (localStorage empty)', async () => {
      await expect(requirePasskey()).rejects.toThrow(
        'No passkey found. Please register the wallet first.'
      )
      expect(mockCredentialsGet).not.toHaveBeenCalled()
    })

    it('should throw error when credential ID is not found in localStorage', async () => {
      localStorageMock.setItem('some_other_key', 'value')
      await expect(requirePasskey()).rejects.toThrow(
        'No passkey found. Please register the wallet first.'
      )
      expect(mockCredentialsGet).not.toHaveBeenCalled()
    })
  })

  describe('successful biometric authentication', () => {
    beforeEach(() => {
      // Set up a valid base64url-encoded credential ID
      // Using standard base64: 'test_credential_id' -> 'dGVzdF9jcmVkZW50aWFsX2lk'
      localStorageMock.setItem('invisible_wallet_key_id', 'dGVzdF9jcmVkZW50aWFsX2lk')
    })

    it('should successfully resolve when WebAuthn assertion succeeds', async () => {
      // Mock a successful WebAuthn response
      const mockAssertion = {
        id: 'test-id',
        response: {
          clientJSON: {},
        },
      }
      mockCredentialsGet.mockResolvedValue(mockAssertion)

      await expect(requirePasskey()).resolves.toBeUndefined()

      // Verify credentials.get was called with correct parameters
      expect(mockCredentialsGet).toHaveBeenCalledTimes(1)
      const callArgs = mockCredentialsGet.mock.calls[0][0]
      expect(callArgs.publicKey).toBeDefined()
      expect(callArgs.publicKey.userVerification).toBe('required')
      expect(callArgs.publicKey.timeout).toBe(60_000)
    })

    it('should call navigator.credentials.get with correct challenge', async () => {
      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await requirePasskey()

      expect(mockGetRandomValues).toHaveBeenCalledTimes(1)
      const callArgs = mockCredentialsGet.mock.calls[0][0]
      expect(callArgs.publicKey.challenge).toBeInstanceOf(Uint8Array)
      expect(callArgs.publicKey.challenge.length).toBe(32)
    })

    it('should correctly decode and pass credential ID to WebAuthn', async () => {
      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await requirePasskey()

      const callArgs = mockCredentialsGet.mock.calls[0][0]
      const allowCredentials = callArgs.publicKey.allowCredentials

      expect(allowCredentials).toHaveLength(1)
      expect(allowCredentials[0].type).toBe('public-key')
      expect(allowCredentials[0].id).toBeInstanceOf(Uint8Array)
    })

    it('should handle base64url encoding with dashes and underscores', async () => {
      // Base64url uses - instead of + and _ instead of /
      const base64urlEncoded = 'SGVsbG8tV29ybGRfVGVzdA'
      localStorageMock.setItem('invisible_wallet_key_id', base64urlEncoded)

      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await expect(requirePasskey()).resolves.toBeUndefined()
      expect(mockCredentialsGet).toHaveBeenCalledTimes(1)
    })
  })

  describe('user cancellation', () => {
    beforeEach(() => {
      localStorageMock.setItem('invisible_wallet_key_id', 'dGVzdF9jcmVkZW50aWFsX2lk')
    })

    it('should reject with user-friendly message when user cancels (assertion is null)', async () => {
      mockCredentialsGet.mockResolvedValue(null)

      await expect(requirePasskey()).rejects.toThrow(
        'Passkey verification was cancelled.'
      )
    })

    it('should reject with user-friendly message when assertion is undefined', async () => {
      mockCredentialsGet.mockResolvedValue(undefined)

      await expect(requirePasskey()).rejects.toThrow(
        'Passkey verification was cancelled.'
      )
    })

    it('should reject with NotAllowedError when user denies biometric permission', async () => {
      const notAllowedError = new DOMException('User denied permission', 'NotAllowedError')
      mockCredentialsGet.mockRejectedValue(notAllowedError)

      await expect(requirePasskey()).rejects.toThrow('NotAllowedError')
    })

    it('should reject when credentials.get throws SecurityError', async () => {
      const securityError = new DOMException('Security error', 'SecurityError')
      mockCredentialsGet.mockRejectedValue(securityError)

      await expect(requirePasskey()).rejects.toThrow('SecurityError')
    })
  })

  describe('edge cases', () => {
    beforeEach(() => {
      localStorageMock.setItem('invisible_wallet_key_id', 'dGVzdF9jcmVkZW50aWFsX2lk')
    })

    it('should call getRandomValues with 32-byte Uint8Array', async () => {
      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await requirePasskey()

      expect(mockGetRandomValues).toHaveBeenCalled()
      const arg = mockGetRandomValues.mock.calls[0][0]
      expect(arg).toBeInstanceOf(Uint8Array)
      expect(arg.length).toBe(32)
    })

    it('should generate a new challenge on each call', async () => {
      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await requirePasskey()
      const firstChallenge = mockCredentialsGet.mock.calls[0][0].publicKey.challenge

      // Reset and call again
      jest.clearAllMocks()
      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await requirePasskey()
      const secondChallenge = mockCredentialsGet.mock.calls[0][0].publicKey.challenge

      // Challenges should be different (or at least can be)
      expect(firstChallenge).not.toBe(secondChallenge)
    })

    it('should set timeout to 60 seconds', async () => {
      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await requirePasskey()

      const callArgs = mockCredentialsGet.mock.calls[0][0]
      expect(callArgs.publicKey.timeout).toBe(60_000)
    })

    it('should require user verification', async () => {
      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await requirePasskey()

      const callArgs = mockCredentialsGet.mock.calls[0][0]
      expect(callArgs.publicKey.userVerification).toBe('required')
    })
  })

  describe('integration scenarios', () => {
    beforeEach(() => {
      localStorageMock.setItem('invisible_wallet_key_id', 'dGVzdF9jcmVkZW50aWFsX2lk')
    })

    it('should handle multiple sequential successful calls', async () => {
      mockCredentialsGet.mockResolvedValue({ id: 'test-id' })

      await requirePasskey()
      await requirePasskey()
      await requirePasskey()

      expect(mockCredentialsGet).toHaveBeenCalledTimes(3)
    })

    it('should handle alternating success and cancellation', async () => {
      mockCredentialsGet.mockResolvedValueOnce({ id: 'test-id' })
      await expect(requirePasskey()).resolves.toBeUndefined()

      mockCredentialsGet.mockResolvedValueOnce(null)
      await expect(requirePasskey()).rejects.toThrow('Passkey verification was cancelled.')

      mockCredentialsGet.mockResolvedValueOnce({ id: 'test-id' })
      await expect(requirePasskey()).resolves.toBeUndefined()
    })
  })
})

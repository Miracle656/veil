/**
 * @jest-environment jsdom
 *
 * Tests for lib/passkeySigner.ts:
 * fee-payer retrieval and precedence, wallet signing availability checks,
 * credential normalization, buffer slicing, user-verification requirements,
 * and dismissal error handling.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

// jsdom provides neither WebCrypto nor these encoders; @stellar/stellar-sdk —
// pulled in transitively by lib/network.ts — needs them at import time.
Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Keypair } from '@stellar/stellar-sdk'
import { walletLocal, walletSession } from '../walletStorage'
import {
  PasskeySignerUnavailable,
  buildSignAuthEntry,
  canSignAsWallet,
  getFeePayerKeypair,
} from '../passkeySigner'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  Object.defineProperty(navigator, 'credentials', {
    value: { get: jest.fn() },
    configurable: true,
    writable: true,
  })
})

describe('getFeePayerKeypair', () => {
  it('throws PasskeySignerUnavailable when neither storage has a key', () => {
    expect(() => getFeePayerKeypair()).toThrow(PasskeySignerUnavailable)
    expect(() => getFeePayerKeypair()).toThrow(/Signing key not found/)
  })

  it('prefers session storage over local storage', () => {
    const sessionKp = Keypair.random()
    const localKp = Keypair.random()

    walletLocal.setItem('veil_signer_secret', localKp.secret())
    expect(getFeePayerKeypair().secret()).toBe(localKp.secret())

    walletSession.setItem('veil_signer_secret', sessionKp.secret())
    expect(getFeePayerKeypair().secret()).toBe(sessionKp.secret())
  })
})

describe('canSignAsWallet', () => {
  it('is true only with both a passkey and a fee payer', () => {
    expect(canSignAsWallet()).toBe(false)

    // Fee payer only (local)
    const feePayer = Keypair.random()
    walletLocal.setItem('veil_signer_secret', feePayer.secret())
    expect(canSignAsWallet()).toBe(false)

    // Passkey partial (only key id)
    walletLocal.setItem('invisible_wallet_key_id', 'test-key-id')
    expect(canSignAsWallet()).toBe(false)

    // Passkey complete with local fee payer
    walletLocal.setItem('invisible_wallet_public_key', '04'.repeat(32))
    expect(canSignAsWallet()).toBe(true)

    // Fee payer in session storage only
    walletLocal.removeItem('veil_signer_secret')
    expect(canSignAsWallet()).toBe(false)
    walletSession.setItem('veil_signer_secret', feePayer.secret())
    expect(canSignAsWallet()).toBe(true)

    // Missing passkey public key
    walletLocal.removeItem('invisible_wallet_public_key')
    expect(canSignAsWallet()).toBe(false)
  })
})

describe('buildSignAuthEntry', () => {
  it('throws PasskeySignerUnavailable with no passkey', async () => {
    const sign = buildSignAuthEntry()
    await expect(sign(new Uint8Array(32))).rejects.toThrow(PasskeySignerUnavailable)
    await expect(sign(new Uint8Array(32))).rejects.toThrow(/No passkey found on this device/)
  })

  it('decodes a base64url credential id with stripped padding', async () => {
    // Base64url credential id with chars '-' and '_' and stripped padding (length 6 -> 2 pad chars stripped)
    const keyId = '---_QA'
    walletLocal.setItem('invisible_wallet_key_id', keyId)
    walletLocal.setItem('invisible_wallet_public_key', '04'.repeat(32))

    let capturedCredId: Uint8Array | null = null
    const mockGet = jest.fn(async (options: any) => {
      capturedCredId = options?.publicKey?.allowCredentials?.[0]?.id
      return null
    })
    Object.defineProperty(navigator, 'credentials', {
      value: { get: mockGet },
      configurable: true,
      writable: true,
    })

    const sign = buildSignAuthEntry()
    await sign(new Uint8Array(32))

    expect(capturedCredId).not.toBeNull()
    const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const expected = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    expect(capturedCredId).toEqual(expected)
  })

  it("passes only the view's bytes as the challenge when the payload is a slice of a larger buffer", async () => {
    walletLocal.setItem('invisible_wallet_key_id', 'test-key-id')
    walletLocal.setItem('invisible_wallet_public_key', '04'.repeat(32))

    let capturedChallenge: ArrayBuffer | null = null
    const mockGet = jest.fn(async (options: any) => {
      capturedChallenge = options?.publicKey?.challenge
      return null
    })
    Object.defineProperty(navigator, 'credentials', {
      value: { get: mockGet },
      configurable: true,
      writable: true,
    })

    const backing = new ArrayBuffer(64)
    const backingView = new Uint8Array(backing)
    for (let i = 0; i < 64; i++) backingView[i] = i

    const slice = new Uint8Array(backing, 16, 32)
    const sign = buildSignAuthEntry()
    await sign(slice)

    expect(capturedChallenge).not.toBeNull()
    expect(capturedChallenge!.byteLength).toBe(32)
    expect(new Uint8Array(capturedChallenge!)).toEqual(new Uint8Array(backing, 16, 32))
  })

  it('asks for userVerification: "required"', async () => {
    walletLocal.setItem('invisible_wallet_key_id', 'test-key-id')
    walletLocal.setItem('invisible_wallet_public_key', '04'.repeat(32))

    let capturedUserVerification: string | null = null
    const mockGet = jest.fn(async (options: any) => {
      capturedUserVerification = options?.publicKey?.userVerification
      return null
    })
    Object.defineProperty(navigator, 'credentials', {
      value: { get: mockGet },
      configurable: true,
      writable: true,
    })

    const sign = buildSignAuthEntry()
    await sign(new Uint8Array(32))

    expect(capturedUserVerification).toBe('required')
  })

  it('returns null on NotAllowedError and rethrows any other error', async () => {
    walletLocal.setItem('invisible_wallet_key_id', 'test-key-id')
    walletLocal.setItem('invisible_wallet_public_key', '04'.repeat(32))

    // 1. NotAllowedError returns null
    const notAllowedError = new DOMException(
      'The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/',
      'NotAllowedError',
    )
    let mockGet = jest.fn().mockRejectedValue(notAllowedError)
    Object.defineProperty(navigator, 'credentials', {
      value: { get: mockGet },
      configurable: true,
      writable: true,
    })

    const sign = buildSignAuthEntry()
    const result1 = await sign(new Uint8Array(32))
    expect(result1).toBeNull()

    // 2. AbortError returns null
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    mockGet = jest.fn().mockRejectedValue(abortError)
    Object.defineProperty(navigator, 'credentials', {
      value: { get: mockGet },
      configurable: true,
      writable: true,
    })
    const result2 = await sign(new Uint8Array(32))
    expect(result2).toBeNull()

    // 3. Other errors are rethrown
    const otherError = new Error('RPC failure or hardware disconnected')
    mockGet = jest.fn().mockRejectedValue(otherError)
    Object.defineProperty(navigator, 'credentials', {
      value: { get: mockGet },
      configurable: true,
      writable: true,
    })
    await expect(sign(new Uint8Array(32))).rejects.toThrow(otherError)

    const securityError = new DOMException('Security violation', 'SecurityError')
    mockGet = jest.fn().mockRejectedValue(securityError)
    Object.defineProperty(navigator, 'credentials', {
      value: { get: mockGet },
      configurable: true,
      writable: true,
    })
    await expect(sign(new Uint8Array(32))).rejects.toThrow(securityError)
  })
})

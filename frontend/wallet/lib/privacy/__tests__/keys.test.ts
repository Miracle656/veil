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

import { Keypair } from '@stellar/stellar-sdk'
import {
  SPP_KEY_DERIVATION_MESSAGE,
  derivePrivacyKeysFromSigner,
  getWalletPrivacyKeys,
} from '../keys'
import * as feePayer from '@/lib/feePayer'

describe('SPP Privacy Keys Derivation (V132)', () => {
  const keypair = Keypair.random()

  it('uses the fixed SPP derivation message', () => {
    expect(SPP_KEY_DERIVATION_MESSAGE).toBe('Privacy Pool Key Derivation [v1]')
  })

  it('derives deterministic privacy keys for the same signer', () => {
    const keys1 = derivePrivacyKeysFromSigner(keypair)
    const keys2 = derivePrivacyKeysFromSigner(keypair)

    expect(keys1.signature).toEqual(keys2.signature)
    expect(keys1.noteSpendingKey).toEqual(keys2.noteSpendingKey)
    expect(keys1.publicKeyBytes).toEqual(keys2.publicKeyBytes)
    expect(keys1.publicKeyHex).toBe(keys2.publicKeyHex)
    expect(keys1.publicKeyBytes.length).toBe(32)
    expect(keys1.signature.length).toBe(64)
  })

  it('verifies that the signature is made over the canonical SPP message', () => {
    const keys = derivePrivacyKeysFromSigner(keypair)
    const verified = keypair.verify(
      Buffer.from(SPP_KEY_DERIVATION_MESSAGE, 'utf8'),
      keys.signature
    )
    expect(verified).toBe(true)
  })

  it('produces distinct privacy keys for different signers', () => {
    const otherKp = Keypair.random()
    const keys1 = derivePrivacyKeysFromSigner(keypair)
    const keys2 = derivePrivacyKeysFromSigner(otherKp)

    expect(keys1.publicKeyHex).not.toBe(keys2.publicKeyHex)
    expect(keys1.signature).not.toEqual(keys2.signature)
  })

  it('throws on invalid signer', () => {
    expect(() => derivePrivacyKeysFromSigner(null as any)).toThrow(
      'Invalid signer keypair provided'
    )
  })

  it('refuses derivation when wallet is in legacy mode (non-PRF)', async () => {
    jest.spyOn(feePayer, 'getFeePayerMode').mockReturnValue('legacy')

    await expect(getWalletPrivacyKeys()).rejects.toThrow(
      'Passkey does not support PRF key derivation'
    )
  })

  it('derives keys from wallet session when in prf mode', async () => {
    jest.spyOn(feePayer, 'getFeePayerMode').mockReturnValue('prf-raw')
    jest.spyOn(feePayer, 'peekFeePayerKeypair').mockReturnValue(keypair)

    const keys = await getWalletPrivacyKeys()
    expect(keys.publicKeyBytes.length).toBe(32)
    expect(keys.publicKeyHex).toBeTruthy()
  })
})

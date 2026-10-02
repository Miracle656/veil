import { test, expect } from '@playwright/test'
import { Keypair } from '@stellar/stellar-sdk'
import { VeilPrivacyClient } from '../lib/privacy/client'
import { isPrivacyEnabled, getSppConfig } from '../lib/privacy/config'
import { derivePrivacyKeys } from '../lib/privacy/keys'

test.describe('End-to-end Private Payment Test on Testnet', () => {
  test('feature flag enforces testnet only', () => {
    expect(isPrivacyEnabled('testnet')).toBe(true)
    expect(isPrivacyEnabled('mainnet')).toBe(false)
    expect(getSppConfig('testnet')).not.toBeNull()
    expect(getSppConfig('mainnet')).toBeNull()
  })

  test('privacy keys derive deterministically from wallet signer', () => {
    const keypair = Keypair.random()
    const keys1 = derivePrivacyKeys(keypair)
    const keys2 = derivePrivacyKeys(keypair)

    expect(keys1.notePublicKey).toBe(keys2.notePublicKey)
    expect(keys1.encryptionPublicKey).toBe(keys2.encryptionPublicKey)
    expect(keys1.noteSecretKey).toBe(keys2.noteSecretKey)
    expect(keys1.encryptionSecretKey).toBe(keys2.encryptionSecretKey)
  })

  test('refuses instantiation on mainnet', () => {
    const keypair = Keypair.random()
    expect(() => new VeilPrivacyClient(keypair, 'mainnet')).toThrow(/disabled on network 'mainnet'/)
  })
})

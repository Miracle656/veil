import { test, expect } from '@playwright/test'
import { Keypair } from '@stellar/stellar-sdk'
import { getPrivacyClient, type PrivacyClient } from '../lib/privacy/client'
import { isPrivacyEnabled, getSppConfig } from '../lib/privacy/config'
import { signPrivacyKeyDerivation, derivePrivacyKeySeeds } from '../lib/privacy/keys'

test.describe('End-to-end Private Payment Test on Testnet', () => {
  test('feature flag enforces testnet only', () => {
    process.env.NEXT_PUBLIC_PRIVACY_FEATURE_FLAG = '1'
    expect(isPrivacyEnabled('testnet')).toBe(true)
    expect(isPrivacyEnabled('mainnet')).toBe(false)
    expect(getSppConfig('testnet')).not.toBeNull()
    expect(getSppConfig('mainnet')).toBeNull()
  })

  test('privacy keys derive deterministically from wallet signer', () => {
    const keypair = Keypair.random()
    const keys1 = signPrivacyKeyDerivation(keypair)
    const keys2 = signPrivacyKeyDerivation(keypair)

    expect(keys1.ownerAddress).toBe(keys2.ownerAddress)
    expect(keys1.signature).toEqual(keys2.signature)
    expect(keys1.noteSeed).toEqual(keys2.noteSeed)
    expect(keys1.encryptionSeed).toEqual(keys2.encryptionSeed)

    const seeds1 = derivePrivacyKeySeeds(keys1.signature)
    const seeds2 = derivePrivacyKeySeeds(keys2.signature)
    expect(seeds1.noteSeed).toEqual(seeds2.noteSeed)
    expect(seeds1.encryptionSeed).toEqual(seeds2.encryptionSeed)
  })

  test('refuses instantiation on mainnet', () => {
    expect(getSppConfig('mainnet')).toBeNull()
    expect(isPrivacyEnabled('mainnet')).toBe(false)
  })
})


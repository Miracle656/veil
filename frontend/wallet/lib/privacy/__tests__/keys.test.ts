if (typeof TextEncoder === 'undefined') {
  const { TextEncoder: TE, TextDecoder: TD } = require('util')
  global.TextEncoder = TE
  global.TextDecoder = TD
}

import { Keypair } from '@stellar/stellar-sdk'
import {
  PRIVACY_KEY_DERIVATION_MESSAGE,
  derivePrivacyPublicKeyFromKeypair,
  derivePrivacyPublicKeyFromSecret,
} from '../keys'

describe('privacy key derivation (V132, #798)', () => {
  it('uses the fixed SPP derivation message', () => {
    expect(PRIVACY_KEY_DERIVATION_MESSAGE).toBe('Privacy Pool Key Derivation [v1]')
  })

  it('deterministically derives the same public key from the same signer secret', () => {
    const kp = Keypair.random()
    const pub1 = derivePrivacyPublicKeyFromSecret(kp.secret())
    const pub2 = derivePrivacyPublicKeyFromSecret(kp.secret())
    const pubFromKp = derivePrivacyPublicKeyFromKeypair(kp)

    expect(pub1).toBe(pub2)
    expect(pub1).toBe(pubFromKp)
    expect(pub1).toHaveLength(64) // 32-byte hex string
  })

  it('derives different privacy keys for different passkeys / signers', () => {
    const kp1 = Keypair.random()
    const kp2 = Keypair.random()

    const pub1 = derivePrivacyPublicKeyFromSecret(kp1.secret())
    const pub2 = derivePrivacyPublicKeyFromSecret(kp2.secret())

    expect(pub1).not.toBe(pub2)
  })
})

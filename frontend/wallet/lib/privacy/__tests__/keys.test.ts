/**
 * @jest-environment jsdom
 *
 * Privacy key derivation (lib/privacy/keys.ts) — #711.
 *
 * The golden vector below is SHARED with the mobile app's
 * `frontend/mobile/lib/privacy/__tests__/keys.test.ts`. Both suites derive
 * from the same fixed PRF output and pin the same signature and key-seed
 * hexes, which is the cross-platform half of "same passkey → same privacy
 * public keys on web and mobile": same seed → same spend key → same SEP-53
 * signature → same SPP note / encryption seeds (upstream materialises the
 * BN254 and X25519 keys from these exact bytes, identically on both
 * platforms).
 *
 * jsdom gives us localStorage / sessionStorage; the PRF ceremony is injected,
 * so no authenticator is needed — same harness as feePayer.test.ts.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Keypair, hash } from '@stellar/stellar-sdk'
import type { PrfEvaluator } from '@veil/prf'
import { clearFeePayer, ensureFeePayer, peekFeePayerKeypair, resetFeePayer } from '../../feePayer'
import { deriveFeePayerKeypair } from '../../deriveFeePayer'
import {
  KEY_DERIVATION_MESSAGE,
  LEGACY_FEE_PAYER_MESSAGE,
  SEP53_MESSAGE_PREFIX,
  derivePrivacyKeySeeds,
  isPrivacyRecoverySupported,
  keyDerivationPayload,
  preparePrivacySigner,
  signPrivacyKeyDerivation,
} from '../keys'

const KEY_ID = 'invisible_wallet_key_id'
const MODE = 'veil_feepayer_mode'

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function fromHex(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'hex'))
}

// The fixed PRF output both suites feed their spend-key derivation — i.e. the
// bytes a real passkey's PRF would return under the fee-payer salt.
const PRF_OUTPUT = '030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc'
const CRED = 'QUJDRA' // arbitrary but valid credential id, for the legacy paths

// Golden values computed against the convention in encryption.rs upstream
// (NethermindEth/stellar-private-payments). Identical in the mobile suite.
const GOLDEN_ADDRESS = 'GB2VYTFZEVWKPTOEVT64NT7O3KCJAF7FXH4VCTUZDEN5M7QLBVBHNSPM'
const GOLDEN_DIGEST = '1bd9450dd9c1e416ce63515b16c44107669d94f7240c9390c74b4f4e04a4b9d9'
const GOLDEN_SIGNATURE =
  '0f2e9c92ed62c4916cc5a304efa295629af1d28d72a8a9e684713ee51e736cce' +
  '0df02e47da4daf956f9eb7d1380c70e8e0ca3cab1f7a7c65ab049537aea2f60c'
const GOLDEN_NOTE_SEED = '40b92dbcaeb7c32d788494b142c96efb2d2beae8a3aae38e36f8835208731afb'
const GOLDEN_ENCRYPTION_SEED = '56e862ebb5f87cc57b2cba94407b8d7924b6459f890a83d6cf6f2e40449db2ea'

const withPrf: PrfEvaluator = async () => fromHex(PRF_OUTPUT)
const noPrf: PrfEvaluator = async () => null

beforeEach(() => {
  resetFeePayer()
  localStorage.clear()
  sessionStorage.clear()
})

describe('SPP key-derivation convention', () => {
  it('signs the SEP-53 payload for the fixed message', () => {
    expect(KEY_DERIVATION_MESSAGE).toBe('Privacy Pool Key Derivation [v1]')
    expect(Buffer.from(keyDerivationPayload()).toString('utf8')).toBe(
      SEP53_MESSAGE_PREFIX + KEY_DERIVATION_MESSAGE,
    )
    expect(hex(hash(Buffer.from(keyDerivationPayload())))).toBe(GOLDEN_DIGEST)
  })

  it('derives SPP note / encryption seeds from the raw signature', () => {
    const seeds = derivePrivacyKeySeeds(fromHex(GOLDEN_SIGNATURE))
    expect(hex(seeds.noteSeed)).toBe(GOLDEN_NOTE_SEED)
    expect(hex(seeds.encryptionSeed)).toBe(GOLDEN_ENCRYPTION_SEED)
  })

  it('rejects a signature that is not the 64 bytes upstream demands', () => {
    expect(() => derivePrivacyKeySeeds(new Uint8Array(63))).toThrow(/64-byte/)
  })
})

describe('signPrivacyKeyDerivation', () => {
  it('turns the PRF-derived spend key into the golden signature and seeds', () => {
    const kp = Keypair.fromRawEd25519Seed(Buffer.from(PRF_OUTPUT, 'hex'))
    const result = signPrivacyKeyDerivation(kp)
    expect(result.ownerAddress).toBe(GOLDEN_ADDRESS)
    expect(hex(result.signature)).toBe(GOLDEN_SIGNATURE)
    expect(hex(result.noteSeed)).toBe(GOLDEN_NOTE_SEED)
    expect(hex(result.encryptionSeed)).toBe(GOLDEN_ENCRYPTION_SEED)
    expect(result.recoverySupported).toBe(true)
    // The signature must verify under the owner address — SPP's own check.
    expect(kp.verify(hash(Buffer.from(keyDerivationPayload())), Buffer.from(result.signature))).toBe(true)
  })
})

describe('preparePrivacySigner — PRF wallet', () => {
  it('signs with the established PRF fee payer and matches the mobile golden vector', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(withPrf)

    const result = await preparePrivacySigner(withPrf)

    expect(result.ownerAddress).toBe(GOLDEN_ADDRESS)
    expect(hex(result.signature)).toBe(GOLDEN_SIGNATURE)
    expect(hex(result.noteSeed)).toBe(GOLDEN_NOTE_SEED)
    expect(result.recoverySupported).toBe(true)
  })

  it('never persists the signature or the seeds', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(withPrf)

    const result = await preparePrivacySigner(withPrf)
    const sigHex = hex(result.signature)
    const seedHex = hex(result.noteSeed)
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const value = store.getItem(store.key(i)!)!
        expect(value).not.toContain(sigHex)
        expect(value).not.toContain(seedHex)
      }
    }
  })

  it('restores the same privacy keys after a cold re-derivation (new device)', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(withPrf)
    const first = await preparePrivacySigner(withPrf)

    // Lock / new device: every session copy of the key is gone and the fee
    // payer is re-derived from the same passkey PRF output. The privacy keys
    // must come back identical — that is the recovery promise.
    clearFeePayer()
    expect(peekFeePayerKeypair()).toBeNull()
    await ensureFeePayer(withPrf)

    const afterRecovery = await preparePrivacySigner(withPrf)
    expect(afterRecovery.ownerAddress).toBe(first.ownerAddress)
    expect(hex(afterRecovery.signature)).toBe(hex(first.signature))
    expect(hex(afterRecovery.noteSeed)).toBe(hex(first.noteSeed))
    expect(hex(afterRecovery.encryptionSeed)).toBe(hex(first.encryptionSeed))
    expect(hex(afterRecovery.noteSeed)).toBe(GOLDEN_NOTE_SEED)
  })

  it('reports recovery unsupported when the passkey stops answering with PRF', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(withPrf) // key established…
    localStorage.setItem(MODE, 'prf-raw')

    const result = await preparePrivacySigner(noPrf) // …but the re-check fails
    expect(result.ownerAddress).toBe(GOLDEN_ADDRESS)
    expect(result.recoverySupported).toBe(false)
  })
})

describe('preparePrivacySigner — pre-PRF wallets', () => {
  it('refuses to sign with a legacy fee payer (V132: never HKDF(credentialId))', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const legacy = await deriveFeePayerKeypair(CRED)
    localStorage.setItem('veil_signer_secret', legacy.secret())
    localStorage.setItem(MODE, 'legacy')

    await expect(preparePrivacySigner()).rejects.toThrow(LEGACY_FEE_PAYER_MESSAGE)
    expect(LEGACY_FEE_PAYER_MESSAGE).toMatch(/cannot be re-derived/)
    expect(LEGACY_FEE_PAYER_MESSAGE).toMatch(/PRF-capable passkey/)
  })

  it('flags legacy wallets as recovery-unsupported without any ceremony', async () => {
    localStorage.setItem(KEY_ID, CRED)
    localStorage.setItem(MODE, 'legacy')
    let prfCalled = false
    const spying: PrfEvaluator = async () => {
      prfCalled = true
      return fromHex(PRF_OUTPUT)
    }
    await expect(isPrivacyRecoverySupported(spying)).resolves.toBe(false)
    expect(prfCalled).toBe(false)
  })

  it('throws when no wallet is established for the session', async () => {
    await expect(preparePrivacySigner()).rejects.toThrow(/No wallet/)
    await expect(preparePrivacySigner()).rejects.toThrow(/session/)
  })
})

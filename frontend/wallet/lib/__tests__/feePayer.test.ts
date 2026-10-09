/**
 * @jest-environment jsdom
 *
 * Tests for the fee-payer accessor (lib/feePayer.ts) — the single source of
 * truth for the sponsor key (ADR 0003). jsdom gives us localStorage /
 * sessionStorage; we install Node's real WebCrypto so the HKDF derivations run.
 * The PRF ceremony is injected, so no authenticator is needed.
 */

import { webcrypto } from 'crypto'
import { TextEncoder, TextDecoder } from 'util'

Object.defineProperty(globalThis, 'crypto', {
  value: webcrypto,
  configurable: true,
  writable: true,
})
// jsdom does not provide these globals; @stellar/stellar-sdk needs them at import.
Object.assign(globalThis, { TextEncoder, TextDecoder })

import { Keypair } from '@stellar/stellar-sdk'
import type { PrfEvaluator } from '@veil/prf'
import {
  ensureFeePayer,
  establishRecoveredFeePayer,
  FeePayerConflictError,
  peekFeePayerSecret,
  getFeePayerMode,
  clearFeePayer,
  resetFeePayer,
} from '../feePayer'
import { deriveFeePayerKeypair } from '../deriveFeePayer'

const KEY_ID = 'invisible_wallet_key_id'
const SECRET = 'veil_signer_secret'
const CRED = 'QUJDRA' // base64url, arbitrary but valid credential id

const withPrf: PrfEvaluator = async () => new Uint8Array(32).fill(7)
const noPrf: PrfEvaluator = async () => null

beforeEach(() => {
  resetFeePayer() // clears the module-level cache + storage
  localStorage.clear()
  sessionStorage.clear()
})

describe('fresh wallet with PRF (secure path)', () => {
  it('pins prf mode and keeps the seed in sessionStorage only (C2 + C3)', async () => {
    localStorage.setItem(KEY_ID, CRED)

    const kp = await ensureFeePayer(withPrf)

    expect(kp).not.toBeNull()
    // 'prf-raw' = PRF output used directly, matching the mobile app so the
    // same passkey yields the same fee-payer on both clients.
    expect(getFeePayerMode()).toBe('prf-raw')
    // C3: the seed is NOT in localStorage…
    expect(localStorage.getItem(SECRET)).toBeNull()
    // …only in sessionStorage (cleared on lock / tab close).
    expect(sessionStorage.getItem(SECRET)).toBe(kp!.secret())
    // C2: the address is PRF-derived, NOT the credential-ID derivation.
    const legacy = await deriveFeePayerKeypair(CRED)
    expect(kp!.publicKey()).not.toBe(legacy.publicKey())
  })

  it('re-derives the same address on a cold session (post-lock), no persistence leak', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const kp1 = await ensureFeePayer(withPrf)

    clearFeePayer() // simulate inactivity lock: cache + session cleared, mode pinned
    expect(peekFeePayerSecret()).toBeNull() // nothing recoverable at rest

    const kp2 = await ensureFeePayer(withPrf) // cold session → PRF re-derivation
    expect(kp2!.publicKey()).toBe(kp1!.publicKey()) // deterministic
    expect(sessionStorage.getItem(SECRET)).toBe(kp2!.secret())
  })
})

describe('fallback when PRF is unavailable', () => {
  it('falls back to the legacy derivation and persists as before (no brick)', async () => {
    localStorage.setItem(KEY_ID, CRED)

    const kp = await ensureFeePayer(noPrf)

    expect(getFeePayerMode()).toBe('legacy')
    const legacy = await deriveFeePayerKeypair(CRED)
    expect(kp!.publicKey()).toBe(legacy.publicKey()) // exactly today's address
    expect(localStorage.getItem(SECRET)).toBe(kp!.secret()) // unchanged persistence
  })
})

describe('pre-existing wallet stays legacy (no address move)', () => {
  it('does not run PRF when a secret is already persisted', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const legacy = await deriveFeePayerKeypair(CRED)
    localStorage.setItem(SECRET, legacy.secret()) // pre-upgrade state

    let prfCalled = false
    const spyingPrf: PrfEvaluator = async () => {
      prfCalled = true
      return new Uint8Array(32).fill(9)
    }

    const kp = await ensureFeePayer(spyingPrf)

    expect(prfCalled).toBe(false)
    expect(getFeePayerMode()).toBe('legacy')
    expect(kp!.publicKey()).toBe(legacy.publicKey()) // funded G-address preserved
  })

  it('reuses a pinned legacy secret with no derivation at all', async () => {
    const legacy = Keypair.random()
    localStorage.setItem(KEY_ID, CRED)
    localStorage.setItem(SECRET, legacy.secret())
    localStorage.setItem('veil_feepayer_mode', 'legacy')

    let prfCalled = false
    const kp = await ensureFeePayer(async () => {
      prfCalled = true
      return null
    })

    expect(prfCalled).toBe(false)
    expect(kp!.secret()).toBe(legacy.secret())
  })

  it('reuses an existing fee-payer during address recovery', async () => {
    const fundedKey = Keypair.random()
    localStorage.setItem(KEY_ID, CRED)
    localStorage.setItem(SECRET, fundedKey.secret())
    localStorage.setItem('veil_feepayer_mode', 'prf-raw')

    const recovered = await establishRecoveredFeePayer(null, CRED)

    expect(recovered.secret()).toBe(fundedKey.secret())
    expect(getFeePayerMode()).toBe('prf-raw')
    expect(localStorage.getItem(SECRET)).toBe(fundedKey.secret())
  })

  it('refuses to replace a fee-payer bound to a different passkey and preserves it', async () => {
    const fundedKey = Keypair.random()
    localStorage.setItem(KEY_ID, CRED)
    localStorage.setItem(SECRET, fundedKey.secret())
    localStorage.setItem('veil_feepayer_mode', 'legacy')

    await expect(establishRecoveredFeePayer(null, 'REPLACEMENT_CREDENTIAL'))
      .rejects.toBeInstanceOf(FeePayerConflictError)
    expect(localStorage.getItem(SECRET)).toBe(fundedKey.secret())
  })

  it('refuses to reuse an unbound fee-payer when recovering another wallet', async () => {
    const fundedKey = Keypair.random()
    localStorage.setItem(SECRET, fundedKey.secret())

    await expect(establishRecoveredFeePayer(null, CRED))
      .rejects.toBeInstanceOf(FeePayerConflictError)
    expect(localStorage.getItem(SECRET)).toBe(fundedKey.secret())
  })

  it('replaces an existing fee-payer only when explicitly requested', async () => {
    const fundedKey = Keypair.random()
    localStorage.setItem(KEY_ID, CRED)
    localStorage.setItem(SECRET, fundedKey.secret())
    localStorage.setItem('veil_feepayer_mode', 'legacy')

    const recovered = await establishRecoveredFeePayer(null, 'REPLACEMENT_CREDENTIAL', true)
    expect(recovered.secret()).not.toBe(fundedKey.secret())
    expect(localStorage.getItem(SECRET)).toBe(recovered.secret())
  })

  it('creates a random legacy key only when no fee-payer exists', async () => {
    localStorage.setItem(KEY_ID, CRED)

    const recovered = await establishRecoveredFeePayer(null)

    expect(recovered).toBeInstanceOf(Keypair)
    expect(getFeePayerMode()).toBe('legacy')
    expect(localStorage.getItem(SECRET)).toBe(recovered.secret())
  })

  it('preserves the deterministic fee-payer supplied by paper recovery', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const recoveredKey = Keypair.random()

    const result = await establishRecoveredFeePayer(null, 'recovery', false, recoveredKey)

    expect(result.secret()).toBe(recoveredKey.secret())
    expect(localStorage.getItem(SECRET)).toBe(recoveredKey.secret())
  })
})

describe('clearFeePayer', () => {
  it('leaves a legacy wallet recoverable (unlock without a prompt)', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(noPrf) // legacy

    clearFeePayer()

    // legacy seed is still in localStorage, so peek restores it
    expect(peekFeePayerSecret()).toBe(localStorage.getItem(SECRET))
    expect(peekFeePayerSecret()).not.toBeNull()
  })
})

describe('cross-platform key agreement (issue #682 acceptance criterion)', () => {
  it('derives the same fee-payer address as the mobile app for the same PRF output', async () => {
    // 'prf-raw' uses the PRF output directly as the Ed25519 seed (no HKDF) —
    // see the comment on FeePayerMode. That means web and mobile MUST produce
    // byte-identical addresses for the same passkey, or a user's fee payer
    // (and the funds/trustlines it needs to pay for) differs per device.
    //
    // This fixture (PRF output = 32 bytes of 0x07) and its expected address are
    // pinned identically in frontend/mobile/lib/__tests__/passkeyWallet.test.ts
    // ("PRF_FIXTURE_PUBLIC_KEY"). If either side's derivation ever changes
    // (e.g. someone "helpfully" adds an HKDF step to match the legacy path),
    // this test and its mobile twin diverge instead of silently drifting.
    const GOLDEN_PRF_OUTPUT = new Uint8Array(32).fill(7)
    const GOLDEN_FEE_PAYER_ADDRESS = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57'

    localStorage.setItem(KEY_ID, CRED)
    const kp = await ensureFeePayer(async () => GOLDEN_PRF_OUTPUT)

    expect(getFeePayerMode()).toBe('prf-raw')
    expect(kp!.publicKey()).toBe(GOLDEN_FEE_PAYER_ADDRESS)
  })
})

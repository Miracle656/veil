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

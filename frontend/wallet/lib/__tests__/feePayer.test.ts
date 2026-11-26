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
  retryPrfFeePayer,
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
  it('falls back to a random keypair for a fresh wallet (not derived from public credential ID)', async () => {
    localStorage.setItem(KEY_ID, CRED)

    const kp = await ensureFeePayer(noPrf)

    expect(getFeePayerMode()).toBe('random')
    const legacy = await deriveFeePayerKeypair(CRED)
    expect(kp!.publicKey()).not.toBe(legacy.publicKey()) // not derived from public credential ID
    expect(localStorage.getItem(SECRET)).toBe(kp!.secret()) // local persistence so gas wallet works
    expect(sessionStorage.getItem(SECRET)).toBe(kp!.secret())
  })

  it('preserves an existing legacy account if funded on-chain when PRF is unavailable', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const legacy = await deriveFeePayerKeypair(CRED)

    // Mock fetch to simulate that legacy.publicKey() exists on-chain
    const originalFetch = globalThis.fetch
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL) => {
      if (typeof url === 'string' && url.includes(legacy.publicKey())) {
        return { ok: true, status: 200 } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    try {
      const kp = await ensureFeePayer(noPrf)
      expect(getFeePayerMode()).toBe('legacy')
      expect(kp!.publicKey()).toBe(legacy.publicKey())
      expect(localStorage.getItem(SECRET)).toBe(legacy.secret())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('preserves an existing legacy account if funded on-chain even when PRF is available', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const legacy = await deriveFeePayerKeypair(CRED)

    // Mock fetch: PRF candidates 404, legacy exists on-chain
    const originalFetch = globalThis.fetch
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL) => {
      if (typeof url === 'string' && url.includes(legacy.publicKey())) {
        return { ok: true, status: 200 } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    try {
      const kp = await ensureFeePayer(withPrf)
      expect(getFeePayerMode()).toBe('legacy')
      expect(kp!.publicKey()).toBe(legacy.publicKey())
      expect(localStorage.getItem(SECRET)).toBe(legacy.secret())
    } finally {
      globalThis.fetch = originalFetch
    }
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
    const legacy = await deriveFeePayerKeypair(CRED)
    localStorage.setItem(SECRET, legacy.secret())
    localStorage.setItem('veil_feepayer_mode', 'legacy')

    await ensureFeePayer(noPrf) // legacy

    clearFeePayer()

    // legacy seed is still in localStorage, so peek restores it
    expect(peekFeePayerSecret()).toBe(legacy.secret())
    expect(peekFeePayerSecret()).not.toBeNull()
  })

  it('leaves a random fallback wallet recoverable (unlock without a prompt)', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const kp = await ensureFeePayer(noPrf) // random
    expect(getFeePayerMode()).toBe('random')

    clearFeePayer()

    expect(peekFeePayerSecret()).toBe(kp!.secret())
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

/**
 * Getting out of the random fallback.
 *
 * A dismissed passkey sheet lands a wallet on `random`, which `ensureFeePayer`
 * then pins and never revisits - deliberately, because silently re-deriving
 * would move the address out from under a funded account. That left the person
 * who tapped "cancel" once with no way back at all, which is what this path is
 * for. It only ever runs from a tap, because both mobile platforms refuse a
 * WebAuthn ceremony without a user gesture.
 */
describe('recovering from a cancelled PRF ceremony', () => {
  const missing = async () => ({ ok: false, status: 404 }) as unknown as Response

  it('adopts the passkey-derived key when the random account is empty', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const random = await ensureFeePayer(noPrf)
    expect(getFeePayerMode()).toBe('random')
    expect(localStorage.getItem(SECRET)).toBe(random!.secret())

    const originalFetch = globalThis.fetch
    globalThis.fetch = jest.fn(missing)
    try {
      const result = await retryPrfFeePayer(withPrf)
      expect(result.ok).toBe(true)
      expect(getFeePayerMode()).toBe('prf-raw')
      if (result.ok) expect(result.publicKey).not.toBe(random!.publicKey())
      // C3 again: a PRF seed is re-derivable, so the localStorage copy the
      // random key needed must not be left behind.
      expect(localStorage.getItem(SECRET)).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refuses, and changes nothing, when the random account exists on chain', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const random = await ensureFeePayer(noPrf)

    const originalFetch = globalThis.fetch
    globalThis.fetch = jest.fn(async () => ({ ok: true, status: 200 }) as Response)
    try {
      const result = await retryPrfFeePayer(withPrf)
      expect(result).toMatchObject({ ok: false, reason: 'funded' })
      // The key that can reach the balance is still the one on this device.
      expect(getFeePayerMode()).toBe('random')
      expect(localStorage.getItem(SECRET)).toBe(random!.secret())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refuses when the network cannot be reached, rather than assuming empty', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const random = await ensureFeePayer(noPrf)

    const originalFetch = globalThis.fetch
    globalThis.fetch = jest.fn(async () => { throw new Error('offline') })
    try {
      const result = await retryPrfFeePayer(withPrf)
      expect(result).toMatchObject({ ok: false, reason: 'network' })
      expect(localStorage.getItem(SECRET)).toBe(random!.secret())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports a dismissed prompt as a cancellation, not as a missing extension', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(noPrf)

    const cancelled = async () => {
      const err = new Error('The request is not allowed by the user agent or the platform in the current context.')
      err.name = 'NotAllowedError'
      throw err
    }
    const result = await retryPrfFeePayer(cancelled)
    expect(result).toMatchObject({ ok: false, reason: 'cancelled' })
    expect(getFeePayerMode()).toBe('random')
  })

  it('says so when the wallet is already on a passkey-derived fee payer', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(withPrf)
    const result = await retryPrfFeePayer(withPrf)
    expect(result).toMatchObject({ ok: false, reason: 'already-prf' })
  })
})

/**
 * A wallet must never move to a different address because a passkey prompt
 * failed.
 *
 * On 2026-11-19 an iPhone user created a wallet in Safari, funded its spending
 * account, and a few hours later the wallet showed a different, empty address.
 * Nothing had been cleared. Safari blocks any passkey prompt that does not come
 * from a tap, the wallet asks for the key while the page loads, and the code
 * that handled the failure took the first other key it had (the legacy one)
 * and pinned it. The money stayed on the real address.
 */
describe('a blocked passkey prompt never moves the wallet to another address', () => {
  const blocked: PrfEvaluator = async () => {
    throw new DOMException('The request is not allowed by the user agent', 'NotAllowedError')
  }

  it('keeps a passkey-derived wallet on its address and pins nothing new', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const first = await ensureFeePayer(withPrf)
    expect(getFeePayerMode()).toBe('prf-raw')

    // A later visit: the session is cold and the prompt is blocked.
    clearFeePayer()
    const later = await ensureFeePayer(blocked)

    expect(later).toBeNull()
    expect(getFeePayerMode()).toBe('prf-raw')
    expect(localStorage.getItem(SECRET)).toBeNull()
    expect(sessionStorage.getItem(SECRET)).toBeNull()

    // And the tap that follows gets the same address back.
    const afterTap = await ensureFeePayer(withPrf)
    expect(afterTap!.publicKey()).toBe(first!.publicKey())
  })

  it('does not fall back to the legacy key, which is what used to be pinned', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(withPrf)
    clearFeePayer()

    await ensureFeePayer(blocked)

    const legacy = await deriveFeePayerKeypair(CRED)
    expect(peekFeePayerSecret()).toBeNull()
    expect(sessionStorage.getItem('veil_signer_public_key')).not.toBe(legacy.publicKey())
    expect(getFeePayerMode()).not.toBe('legacy')
  })

  it('does not replace a random key that has gone missing with the legacy one', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(noPrf)
    expect(getFeePayerMode()).toBe('random')

    // The stored key is gone but the mode is still pinned.
    clearFeePayer()
    localStorage.removeItem(SECRET)
    localStorage.removeItem('veil_signer_public_key')

    expect(await ensureFeePayer(noPrf)).toBeNull()
    expect(getFeePayerMode()).toBe('random')
  })
})

describe('a page load never gives a new wallet a random key', () => {
  const blocked: PrfEvaluator = async () => {
    throw new DOMException('The request is not allowed by the user agent', 'NotAllowedError')
  }

  it('leaves the spending account unset when the prompt was blocked on page load', async () => {
    localStorage.setItem(KEY_ID, CRED)

    expect(await ensureFeePayer(blocked, { passive: true })).toBeNull()
    expect(getFeePayerMode()).toBeNull()
    expect(localStorage.getItem(SECRET)).toBeNull()
  })

  it('then sets it up from the passkey when the user taps', async () => {
    localStorage.setItem(KEY_ID, CRED)
    await ensureFeePayer(blocked, { passive: true })

    const kp = await ensureFeePayer(withPrf)
    expect(kp).not.toBeNull()
    expect(getFeePayerMode()).toBe('prf-raw')
  })

  it('still finds an account that already exists, even on page load', async () => {
    localStorage.setItem(KEY_ID, CRED)
    const legacy = await deriveFeePayerKeypair(CRED)
    const originalFetch = globalThis.fetch
    globalThis.fetch = jest.fn(async (url: RequestInfo | URL) => {
      const found = String(url).endsWith(`/accounts/${legacy.publicKey()}`)
      return { ok: found, status: found ? 200 : 404 } as Response
    })
    try {
      const kp = await ensureFeePayer(blocked, { passive: true })
      expect(kp!.publicKey()).toBe(legacy.publicKey())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps the old behaviour for a tap-driven call: a failed prompt falls back to a random key', async () => {
    localStorage.setItem(KEY_ID, CRED)
    expect(await ensureFeePayer(blocked)).not.toBeNull()
    expect(getFeePayerMode()).toBe('random')
  })
})

describe('finding the spending account a wallet was moved off', () => {
  const prfBytes = new Uint8Array(32).fill(7)
  const rawKey = Keypair.fromRawEd25519Seed(Buffer.from(prfBytes))

  /** Put the wallet in the state the bug left it in: pinned to the legacy key. */
  async function strandOnLegacy() {
    localStorage.setItem(KEY_ID, CRED)
    const legacy = await deriveFeePayerKeypair(CRED)
    localStorage.setItem('veil_feepayer_mode', 'legacy')
    localStorage.setItem(SECRET, legacy.secret())
    return legacy
  }

  /** Horizon, where only the listed accounts exist. */
  function horizonWith(existing: string[]) {
    return jest.fn(async (url: RequestInfo | URL) => {
      const found = existing.some((publicKey) => String(url).endsWith(`/accounts/${publicKey}`))
      return { ok: found, status: found ? 200 : 404 } as Response
    })
  }

  it('goes back to the passkey-made account that exists on chain', async () => {
    const legacy = await strandOnLegacy()
    const originalFetch = globalThis.fetch
    globalThis.fetch = horizonWith([rawKey.publicKey()])
    try {
      const result = await retryPrfFeePayer(withPrf)
      expect(result).toMatchObject({
        ok: true,
        mode: 'prf-raw',
        publicKey: rawKey.publicKey(),
        previousPublicKey: legacy.publicKey(),
        foundOnChain: true,
      })
      expect(getFeePayerMode()).toBe('prf-raw')
      expect(peekFeePayerSecret()).toBe(rawKey.secret())
      expect(localStorage.getItem(SECRET)).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('picks the older derivation when that is the account that exists', async () => {
    await strandOnLegacy()
    const originalFetch = globalThis.fetch
    // Find out which address the older derivation makes, by letting every
    // lookup miss first: the result names both candidates in its diagnostics.
    globalThis.fetch = horizonWith([])
    let hkdfAddress = ''
    try {
      await retryPrfFeePayer(withPrf)
      const recorded = JSON.parse(sessionStorage.getItem('veil_feepayer_diagnostics') ?? '{}')
      hkdfAddress = recorded.candidates.find((c: { mode: string }) => c.mode === 'prf-hkdf').publicKey
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(hkdfAddress).not.toBe(rawKey.publicKey())

    resetFeePayer()
    localStorage.clear()
    sessionStorage.clear()
    await strandOnLegacy()
    globalThis.fetch = horizonWith([hkdfAddress])
    try {
      const result = await retryPrfFeePayer(withPrf)
      expect(result).toMatchObject({ ok: true, mode: 'prf-hkdf', publicKey: hkdfAddress, foundOnChain: true })
      expect(getFeePayerMode()).toBe('prf-hkdf')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('changes nothing when it cannot tell which account exists', async () => {
    const legacy = await strandOnLegacy()
    const originalFetch = globalThis.fetch
    // The current account is confirmed empty; the lookups after it fail.
    let calls = 0
    globalThis.fetch = jest.fn(async () => {
      calls += 1
      if (calls === 1) return { ok: false, status: 404 } as Response
      throw new Error('offline')
    })
    try {
      const result = await retryPrfFeePayer(withPrf)
      expect(result).toMatchObject({ ok: false, reason: 'network' })
      expect(getFeePayerMode()).toBe('legacy')
      expect(localStorage.getItem(SECRET)).toBe(legacy.secret())
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('still refuses when the address the wallet is on now holds something', async () => {
    const legacy = await strandOnLegacy()
    const originalFetch = globalThis.fetch
    globalThis.fetch = horizonWith([legacy.publicKey(), rawKey.publicKey()])
    try {
      const result = await retryPrfFeePayer(withPrf)
      expect(result).toMatchObject({ ok: false, reason: 'funded' })
      expect(getFeePayerMode()).toBe('legacy')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})


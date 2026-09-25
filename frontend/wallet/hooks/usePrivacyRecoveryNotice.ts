'use client'

import { useEffect, useState } from 'react'

import { isPrivacyEnabled } from '@/lib/privacy/config'
import { isPrivacyRecoverySupported } from '@/lib/privacy/keys'
import { getFeePayerMode, peekFeePayerKeypair } from '@/lib/feePayer'

/**
 * Gates the privacy UI behind an honest warning (#711).
 *
 * SPP's privacy keys are re-derived from the passkey's PRF output, so a
 * wallet whose spend key is not passkey-bound — a pre-PRF (legacy) wallet, or
 * a passkey whose current device no longer answers PRF challenges — can never
 * recover private balances on another device. The dashboard surfaces that
 * notice before the user can move anything into the pool.
 *
 * Returns `true` only when the check actually ran and failed: feature-off
 * builds, sessions with no established wallet, and errored checks all return
 * `false` so nothing prompts spuriously. A legacy wallet is flagged without
 * any ceremony; a PRF wallet gets one PRF re-check (platforms answer PRF
 * challenges silently on already-unlocked devices).
 */
export function usePrivacyRecoveryNotice(): boolean {
  const [unsupported, setUnsupported] = useState(false)

  useEffect(() => {
    if (!isPrivacyEnabled()) return
    const mode = getFeePayerMode()
    if (!mode) return // no established wallet — nothing to warn about
    if (mode === 'legacy') {
      // V132: a legacy fee payer cannot even sign privacy keys.
      setUnsupported(true)
      return
    }
    if (!peekFeePayerKeypair()) return // session not restored yet
    let alive = true
    isPrivacyRecoverySupported()
      .then((ok) => {
        if (alive && !ok) setUnsupported(true)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return unsupported
}

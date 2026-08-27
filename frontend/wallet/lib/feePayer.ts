import { Keypair } from '@stellar/stellar-sdk'
import { deriveFeePayerSeedFromPrf, evaluateFeePayerPrf, type PrfEvaluator } from '@veil/prf'

import { deriveFeePayerKeypair } from './deriveFeePayer'
import { getNetwork } from './network'
import { walletLocal, walletSession } from '@/lib/walletStorage'

/**
 * Single accessor for the fee-payer (sponsor) key — the one place the rest of
 * the app reads it from (ADR 0003). Two derivation modes, pinned per wallet:
 *
 *  - **prf** — the seed is derived from a WebAuthn PRF output, so it is
 *    passkey-bound (only an authenticator holding the credential can produce it)
 *    and the plaintext seed is kept in `sessionStorage` only, never
 *    `localStorage`. This fixes C2 (was derived from the non-secret credential
 *    ID) and C3 (was persisted in plaintext across sessions), and makes the
 *    inactivity lock meaningful — the seed is gone once the tab closes / locks.
 *
 *  - **legacy** — today's behaviour: seed = HKDF(credentialId), persisted in
 *    `localStorage`. Used for wallets created before this change and as the
 *    fallback when the authenticator does not support PRF, so no device is ever
 *    bricked (the fallback preserves the exact prior behaviour).
 *
 * The mode is decided once, at first establishment, and pinned in
 * `veil_feepayer_mode` so a wallet's fee-payer address never changes mid-life:
 * a wallet with an already-persisted secret stays legacy; a brand-new wallet
 * tries PRF and pins whichever mode actually worked.
 */

const KEY_ID = 'invisible_wallet_key_id'
const SECRET = 'veil_signer_secret'
const PUBKEY = 'veil_signer_public_key'
const MODE = 'veil_feepayer_mode'
const DIAGNOSTICS = 'veil_feepayer_diagnostics'

/**
 * How the fee-payer seed is produced.
 *
 *  - **prf-raw**   PRF output used directly as the Ed25519 seed. This is what
 *                  the MOBILE app does, so it is the interoperable variant and
 *                  the default for new wallets.
 *  - **prf-hkdf**  PRF output run through HKDF first. What the web wallet used
 *                  to do unconditionally — kept so wallets already pinned that
 *                  way keep their existing G-address.
 *  - **legacy**    HKDF over the (non-secret) credential ID. Pre-PRF wallets.
 */
export type FeePayerMode = 'prf-raw' | 'prf-hkdf' | 'legacy'

/** Outcome of one candidate's on-chain existence probe (see {@link pickFundedCandidate}). */
export type FeePayerProbeStatus = 'exists' | 'not-found' | 'network-error' | 'not-probed'

/** One derivation candidate considered while establishing the fee-payer, and what the probe found. */
export type FeePayerCandidateResult = {
  mode: FeePayerMode
  publicKey: string
  status: FeePayerProbeStatus
}

/**
 * A record of how the active fee-payer was chosen, kept so Settings can show
 * "which G… am I paying from and why" without a debugger (issue #629), and so
 * a user can copy it verbatim into a bug report.
 */
export type FeePayerDiagnostics = {
  /** ISO timestamp of when this record was captured. */
  at: string
  /** Whether a PRF ceremony was attempted this run (skipped for an already-pinned legacy wallet). */
  prfAttempted: boolean
  /** Outcome of the PRF ceremony, when attempted; null when not attempted. */
  prfOutcome: 'success' | 'unavailable' | 'error' | null
  /** Error message from the PRF ceremony, when prfOutcome === 'error'. */
  prfError?: string
  /** Whether the Horizon existence probe actually ran (skipped once the mode is pinned). */
  probed: boolean
  /** Every derivation candidate considered, and its probe result. */
  candidates: FeePayerCandidateResult[]
  /** The derivation mode ultimately selected. */
  chosenMode: FeePayerMode
  /** The public key ultimately selected. */
  chosenPublicKey: string
}

// Session-scoped, in-memory cache. For the PRF mode this (plus sessionStorage)
// is the ONLY place the seed lives — it is re-derived via a passkey assertion
// when the session is cold. Cleared on lock via clearFeePayer().
let cached: Keypair | null = null
let cachedDiagnostics: FeePayerDiagnostics | null = null

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

/** The pinned derivation mode for this wallet, or null if not yet established. */
export function getFeePayerMode(): FeePayerMode | null {
  if (!hasWindow()) return null
  const m = localStorage.getItem(MODE)
  // 'prf' is what older builds wrote, and it meant the HKDF variant.
  if (m === 'prf') return 'prf-hkdf'
  return m === 'prf-raw' || m === 'prf-hkdf' || m === 'legacy' ? m : null
}

/**
 * Synchronous read of the established fee-payer secret for this session, without
 * triggering a passkey prompt. Returns the in-memory cache first, then the
 * session/local persisted secret (legacy). Callers that only need to *use* an
 * already-established key (the common case, mid-session) use this.
 */
export function peekFeePayerSecret(): string | null {
  if (cached) return cached.secret()
  if (!hasWindow()) return null
  return walletSession.getItem(SECRET) || walletLocal.getItem(SECRET)
}

/** Convenience: the established fee-payer Keypair, or null. Sync, no prompt. */
export function peekFeePayerKeypair(): Keypair | null {
  const secret = peekFeePayerSecret()
  if (!secret) return null
  try {
    return Keypair.fromSecret(secret)
  } catch {
    return null
  }
}

/**
 * The diagnostic record from the last time {@link ensureFeePayer} ran in this
 * session — which candidates were derived, which existed on-chain, and whether
 * a PRF ceremony was attempted/failed. Falls back to the persisted copy in
 * sessionStorage so a Settings page opened after the establishing call (e.g. a
 * fresh render of the same tab) can still show it. Returns null before
 * {@link ensureFeePayer} has run at least once this session.
 */
export function getFeePayerDiagnostics(): FeePayerDiagnostics | null {
  if (cachedDiagnostics) return cachedDiagnostics
  if (!hasWindow()) return null
  const raw = walletSession.getItem(DIAGNOSTICS)
  if (!raw) return null
  try {
    return JSON.parse(raw) as FeePayerDiagnostics
  } catch {
    return null
  }
}

/**
 * True when the active fee-payer is a silent PRF→legacy downgrade: a PRF
 * ceremony was attempted but did not produce a usable key, and legacy is what
 * ended up chosen. A wallet in this state will NOT reproduce the same
 * fee-payer address on a PRF-capable device (issue #629).
 */
export function isFeePayerPrfDowngrade(diagnostics: FeePayerDiagnostics | null = getFeePayerDiagnostics()): boolean {
  if (!diagnostics) return false
  return diagnostics.prfAttempted && diagnostics.prfOutcome !== 'success' && diagnostics.chosenMode === 'legacy'
}

/** Render a diagnostics record as plain text suitable for pasting into a bug report. */
export function formatFeePayerDiagnostics(diagnostics: FeePayerDiagnostics): string {
  const lines = [
    `Veil fee-payer diagnostics — ${diagnostics.at}`,
    `Chosen: ${diagnostics.chosenMode} (${diagnostics.chosenPublicKey})`,
    `PRF: ${diagnostics.prfAttempted ? diagnostics.prfOutcome ?? 'unknown' : 'not attempted'}${diagnostics.prfError ? ` — ${diagnostics.prfError}` : ''}`,
    `Probe: ${diagnostics.probed ? 'ran' : 'skipped (mode already pinned)'}`,
    'Candidates:',
    ...diagnostics.candidates.map((c) => `  - ${c.mode}: ${c.publicKey} [${c.status}]`),
  ]
  return lines.join('\n')
}

/**
 * Establish the fee-payer for this session, deriving it if necessary. Idempotent
 * and memoised — the interactive PRF assertion runs at most once per cold
 * session. Call this at session entry points (wallet create, recover, unlock,
 * dashboard mount) so later synchronous {@link peekFeePayerSecret} reads succeed.
 *
 * On any PRF failure (unsupported authenticator, cancelled ceremony, error) it
 * falls back to the legacy credential-ID derivation, so it never leaves the
 * caller without a key on a device that worked before.
 *
 * @param evaluator injectable PRF ceremony, for tests / non-browser platforms.
 */
export async function ensureFeePayer(evaluator?: PrfEvaluator): Promise<Keypair | null> {
  if (cached) return cached
  if (!hasWindow()) return null

  const pinned = getFeePayerMode()
  const existing = peekFeePayerSecret()

  // Fast path: the session already holds a secret under a pinned mode → reuse it
  // with no prompt. Still records a diagnostics entry (unless one from a fuller
  // run already exists this session) so Settings has something to show even
  // though no new derivation/probe happened.
  if (existing && pinned) {
    cached = Keypair.fromSecret(existing)
    if (!getFeePayerDiagnostics()) {
      setDiagnostics({
        at: new Date().toISOString(),
        prfAttempted: false,
        prfOutcome: null,
        probed: false,
        candidates: [{ mode: pinned, publicKey: cached.publicKey(), status: 'not-probed' }],
        chosenMode: pinned,
        chosenPublicKey: cached.publicKey(),
      })
    }
    return cached
  }

  const credentialId = walletLocal.getItem(KEY_ID)
  if (!credentialId) {
    // No passkey registered yet — best-effort from any persisted secret.
    cached = existing ? Keypair.fromSecret(existing) : null
    return cached
  }

  // A persisted secret with no pinned mode is a wallet from before modes
  // existed: it is legacy by definition, and its G-address may be funded. Treat
  // it as pinned so no PRF ceremony runs and the address cannot move.
  const effectiveMode: FeePayerMode | null = pinned ?? (existing ? 'legacy' : null)

  const candidates: Array<{ mode: FeePayerMode; kp: Keypair }> = []

  let prfAttempted = false
  let prfOutcome: FeePayerDiagnostics['prfOutcome'] = null
  let prfError: string | undefined

  if (effectiveMode !== 'legacy') {
    prfAttempted = true
    try {
      const prf = await evaluateFeePayerPrf(credentialId, undefined, evaluator)
      if (prf && prf.length >= 32) {
        // Mobile uses the PRF output directly; the web used to HKDF it. Same
        // passkey, same PRF output, different seed — which is why a wallet
        // created on the phone resolved to a different (unfunded) G-address
        // here. Both are derived so whichever one actually exists can win.
        candidates.push({ mode: 'prf-raw', kp: Keypair.fromRawEd25519Seed(Buffer.from(prf.subarray(0, 32))) })
        const hkdf = await deriveFeePayerSeedFromPrf(prf)
        candidates.push({ mode: 'prf-hkdf', kp: Keypair.fromRawEd25519Seed(Buffer.from(hkdf)) })
        prfOutcome = 'success'
      } else {
        // Authenticator did not surface a PRF result — unsupported, not an error.
        prfOutcome = 'unavailable'
      }
    } catch (err) {
      // PRF cancelled/unsupported → the legacy candidate below still applies.
      prfOutcome = 'error'
      prfError = err instanceof Error ? err.message : String(err)
    }
  }

  candidates.push({ mode: 'legacy', kp: await deriveFeePayerKeypair(credentialId) })

  // If the wallet was pinned, honour that exactly — moving a funded account
  // because a probe failed would be worse than a failed probe.
  let chosen: { mode: FeePayerMode; kp: Keypair }
  let probed = false
  let probeResults: FeePayerCandidateResult[] | null = null

  if (effectiveMode) {
    chosen = candidates.find((c) => c.mode === effectiveMode) ?? candidates[0]!
  } else {
    probed = true
    const picked = await pickFundedCandidate(candidates)
    probeResults = picked.results
    chosen = picked.chosen ?? candidates[0]!
  }

  cached = chosen.kp
  localStorage.setItem(MODE, chosen.mode)
  walletSession.setItem(SECRET, chosen.kp.secret())
  walletSession.setItem(PUBKEY, chosen.kp.publicKey())
  // Only the legacy variant is recoverable without the passkey, so only it is
  // persisted; PRF seeds stay session-scoped (ADR 0003, C3).
  if (chosen.mode === 'legacy') {
    walletLocal.setItem(SECRET, chosen.kp.secret())
    walletLocal.setItem(PUBKEY, chosen.kp.publicKey())
  }

  setDiagnostics({
    at: new Date().toISOString(),
    prfAttempted,
    prfOutcome,
    prfError,
    probed,
    candidates: probeResults ?? candidates.map((c) => ({ mode: c.mode, publicKey: c.kp.publicKey(), status: 'not-probed' as const })),
    chosenMode: chosen.mode,
    chosenPublicKey: chosen.kp.publicKey(),
  })

  return chosen.kp
}

/** Cache + persist a diagnostics record (sessionStorage — metadata only, no secret). */
function setDiagnostics(diagnostics: FeePayerDiagnostics): void {
  cachedDiagnostics = diagnostics
  walletSession.setItem(DIAGNOSTICS, JSON.stringify(diagnostics))
}

/**
 * Pick the candidate whose account already exists on-chain.
 *
 * The variants are all deterministic, so the only question is which one this
 * wallet was actually created with — and the ledger already knows. Probing beats
 * guessing: guessing wrong strands the user on an unfunded fee-payer with no
 * error message and no way to pay the fee that would fix it.
 *
 * Stops at the first hit — the remaining candidates are recorded as
 * `not-probed` rather than checked, so a genuinely new wallet still only costs
 * up to 3 requests. Returns a null `chosen` when none exist (a genuinely new
 * wallet), leaving the caller to take the first candidate — prf-raw, which is
 * what mobile produces, so a wallet created here stays recoverable there.
 */
async function pickFundedCandidate(
  candidates: Array<{ mode: FeePayerMode; kp: Keypair }>,
): Promise<{ chosen: { mode: FeePayerMode; kp: Keypair } | null; results: FeePayerCandidateResult[] }> {
  const { horizonUrl } = getNetwork()
  const results: FeePayerCandidateResult[] = []
  let chosen: { mode: FeePayerMode; kp: Keypair } | null = null

  for (const candidate of candidates) {
    if (chosen) {
      results.push({ mode: candidate.mode, publicKey: candidate.kp.publicKey(), status: 'not-probed' })
      continue
    }
    try {
      const res = await fetch(`${horizonUrl}/accounts/${candidate.kp.publicKey()}`)
      if (res.ok) {
        results.push({ mode: candidate.mode, publicKey: candidate.kp.publicKey(), status: 'exists' })
        chosen = candidate
      } else {
        results.push({ mode: candidate.mode, publicKey: candidate.kp.publicKey(), status: 'not-found' })
      }
    } catch {
      // Network trouble — try the next rather than claiming this one is absent.
      results.push({ mode: candidate.mode, publicKey: candidate.kp.publicKey(), status: 'network-error' })
    }
  }
  return { chosen, results }
}

/**
 * Drop the in-memory + session copies of the fee-payer (call on inactivity
 * lock). For a PRF-mode wallet nothing recoverable remains afterwards — the seed
 * is re-derived from the passkey on the next {@link ensureFeePayer}. Legacy
 * wallets still have their seed in localStorage (unchanged), so unlock restores
 * it without a prompt.
 */
export function clearFeePayer(): void {
  cached = null
  if (!hasWindow()) return
  walletSession.removeItem(SECRET)
  walletSession.removeItem(PUBKEY)
}

/**
 * Full teardown (logout / wipe): drop every copy of the fee-payer, including the
 * pinned mode and the legacy localStorage seed.
 */
export function resetFeePayer(): void {
  cached = null
  cachedDiagnostics = null
  if (!hasWindow()) return
  walletSession.removeItem(SECRET)
  walletSession.removeItem(PUBKEY)
  walletSession.removeItem(DIAGNOSTICS)
  walletLocal.removeItem(SECRET)
  walletLocal.removeItem(PUBKEY)
  localStorage.removeItem(MODE)
}

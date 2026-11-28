'use client'

/**
 * Blend backstop — open, queue, cancel and close a first-loss position.
 *
 * Everything on this screen is per (pool, backstop) pair, because that is how
 * the contract stores a deposit: a user's backstop shares in pool A are not
 * the same balance as their shares in pool B. Positions are loaded through
 * `lib/backstop.ts`, which reads from the ledger with the same Blend SDK
 * estimate the mobile client uses, so the two cannot disagree about what a
 * position is worth.
 *
 * Units: a **deposit** is BLND:USDC LP tokens, while **queue, cancel and
 * withdraw** all take **shares**. The screen says which unit every input is in,
 * and the review step repeats the amount and the unit next to the wallet's
 * prompt so nothing is signed that the user was not shown.
 *
 * Nothing is signed straight from a form: every action passes through `review`,
 * where the amount, the unit and (for a queue) the unlock date are shown, and
 * where the fee/LP pre-flight either clears or blocks the signature.
 *
 * The signing path is the wallet's existing one: build XDR, ask for the
 * passkey, hand the XDR to `signAndSubmitSorobanXdr` (see CR-1 in the audit —
 * there is one simulate/assemble/sign implementation and this screen does not
 * get a second).
 *
 * No issuer `stellar.toml` read happens here: BLND and USDC marks are the
 * wallet's own, so the CSP never has to be widened for this screen.
 */
import { useCallback, useEffect, useState } from 'react'
import { Keypair } from '@stellar/stellar-sdk'

import {
  Card,
  DisplayNumber,
  ListRow,
  Mono,
  PageHeader,
  Pill,
  PrimaryAction,
  SectionLabel,
  Tag,
} from '@/components/ui/primitives'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  FALLBACK_QUEUE_LOCK_SECONDS,
  buildBackstopCancelWithdrawalXdr,
  buildBackstopDepositXdr,
  buildBackstopQueueWithdrawalXdr,
  buildBackstopWithdrawXdr,
  configuredBackstopId,
  formatLockDuration,
  formatUnlockDate,
  loadBackstopPositions,
  loadBackstopQueueLockSeconds,
  runBackstopPreflight,
  sharesToStroops,
  stroopsToShares,
  type BackstopPosition,
} from '@/lib/backstop'
import { isBackstopEnabled } from '@/lib/backstopFeature'
import { configuredPoolIds } from '@/lib/blend'
import { getNetwork } from '@/lib/network'
import { PasskeyCeremonyError, isPasskeyCancellation } from '@/lib/passkeyOutcome'
import { requirePasskey } from '@/lib/passkeyAuth'
import { signAndSubmitSorobanXdr } from '@/lib/sorobanTx'
import { beginTx, endTx } from '@/lib/txState'
import { walletLocal, walletSession } from '@/lib/walletStorage'

const network = getNetwork()

// Resolved once. `configuredPoolIds()` builds a fresh array on every call, so
// reading it inside the component would give the load callback a new identity
// each render and re-run the effect forever.
const BACKSTOP_ID = configuredBackstopId()
const CONFIGURED_POOLS = configuredPoolIds()

type Step =
  | 'view'
  | 'deposit-form'
  | 'queue-form'
  | 'manage'
  | 'review'
  | 'signing'
  | 'done'
  | 'error'

/** The four contract calls this screen can build. */
type ActionKind = 'deposit' | 'queue' | 'cancel' | 'withdraw'

interface ActionCopy {
  /** Button/heading wording. */
  title: string
  /** What the amount is denominated in, word for word, on the review step. */
  unit: string
  method: 'deposit' | 'queueWithdrawal' | 'dequeueWithdrawal' | 'withdraw'
  /** Where a cancelled passkey prompt returns to. */
  formStep: Step
}

const ACTION_COPY: Record<ActionKind, ActionCopy> = {
  deposit: {
    title: 'Deposit',
    unit: 'BLND:USDC LP tokens',
    method: 'deposit',
    formStep: 'deposit-form',
  },
  queue: {
    title: 'Queue withdrawal',
    unit: 'backstop shares',
    method: 'queueWithdrawal',
    formStep: 'queue-form',
  },
  // The contract calls this `dequeue_withdrawal`; the screen says cancel
  // because that is what it does to the user's queue.
  cancel: {
    title: 'Cancel queued shares',
    unit: 'backstop shares',
    method: 'dequeueWithdrawal',
    formStep: 'manage',
  },
  withdraw: {
    title: 'Withdraw',
    unit: 'backstop shares',
    method: 'withdraw',
    formStep: 'manage',
  },
}

const EMPTY_AMOUNTS: Record<ActionKind, string> = {
  deposit: '',
  queue: '',
  cancel: '',
  withdraw: '',
}

/** What the review step is about to sign. */
interface ReviewAction {
  kind: ActionKind
  /** Raw 7-decimal amount, in the unit `kind` takes. */
  amount: bigint
  /** Unix seconds when a queued withdrawal unlocks. */
  unlockAt?: number
}

interface PreflightState {
  status: 'checking' | 'ok' | 'blocked'
  problems: string[]
}

/** `12,345.6789` — four decimals is enough to compare two clients on. */
function lp(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  })
}

/** "in 4 days" / "ready" for a queued entry's expiry, in unix seconds. */
function unlockLabel(exp: number, now: number): string {
  const seconds = exp - now
  if (seconds <= 0) return 'ready'
  return `in ${formatLockDuration(seconds)}`
}

export default function BackstopPage() {
  useInactivityLock()

  const [step, setStep] = useState<Step>('view')
  const [accountAddress, setAccountAddress] = useState<string | null>(null)
  const [positions, setPositions] = useState<BackstopPosition[]>([])
  const [poolId, setPoolId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [amounts, setAmounts] = useState<Record<ActionKind, string>>(EMPTY_AMOUNTS)
  const [review, setReview] = useState<ReviewAction | null>(null)
  const [preflight, setPreflight] = useState<PreflightState>({
    status: 'checking',
    problems: [],
  })
  const [queueLockSeconds, setQueueLockSeconds] = useState(FALLBACK_QUEUE_LOCK_SECONDS)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  // Asked per render rather than captured at import so the gate follows the
  // active network and any build flag without a module-level snapshot.
  const backstopAvailable = isBackstopEnabled(network.name)

  const load = useCallback(async (address: string) => {
    setLoading(true)
    setLoadError(null)
    try {
      const result = await loadBackstopPositions(address, CONFIGURED_POOLS)
      setPositions(result.positions)
      if (result.failedPoolIds.length > 0) {
        // A failed read is not an empty position. Say so, and keep every
        // action that depends on the position disabled.
        const which = result.failedPoolIds.length === 1 ? 'this pool' : 'one or more pools'
        setLoadError(
          `We could not load your backstop position for ${which}. Nothing can be signed until it loads, because the screen cannot show what is already at risk.`,
        )
      }
      setPoolId((current) => current ?? result.positions[0]?.poolId ?? CONFIGURED_POOLS[0] ?? null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }

    // The queue lock is a contract read; if it fails the fallback already in
    // state is still a safe number, so this never blocks the screen.
    try {
      const lock = await loadBackstopQueueLockSeconds({
        backstopId: BACKSTOP_ID,
        poolId: CONFIGURED_POOLS[0],
        sourceAddress: address,
      })
      setQueueLockSeconds(lock)
    } catch {
      // Fallback stays.
    }
  }, [])

  useEffect(() => {
    // A gated screen does not touch the RPC chain at all.
    if (!backstopAvailable) {
      setLoading(false)
      return
    }
    const address = walletSession.getItem('invisible_wallet_address')
    if (!address) return
    const secret =
      walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    const publicKey = walletLocal.getItem('veil_signer_public_key')
    if (!secret && !publicKey) {
      setErrorMsg('Signing key not found. Unlock the wallet again.')
      setStep('error')
      setLoading(false)
      return
    }
    const resolved = secret ? Keypair.fromSecret(secret).publicKey() : publicKey!
    setAccountAddress(resolved)
    void load(resolved)
  }, [load, backstopAvailable])

  // The queue countdown is a date, not a subscription: tick once a minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(timer)
  }, [])

  // Pre-flight runs while the review step is open, so the user sees why a
  // signature is blocked before the passkey prompt, not after it.
  useEffect(() => {
    if (step !== 'review' || !review || !accountAddress) return
    let cancelled = false
    setPreflight({ status: 'checking', problems: [] })
    void runBackstopPreflight({
      backstopId: BACKSTOP_ID,
      method: ACTION_COPY[review.kind].method,
      sourceAddress: accountAddress,
      amountStroops: review.amount,
    })
      .then((result) => {
        if (cancelled) return
        setPreflight({ status: result.ok ? 'ok' : 'blocked', problems: result.problems })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setPreflight({
          status: 'blocked',
          problems: [
            err instanceof Error ? err.message : 'The pre-flight check could not run.',
          ],
        })
      })
    return () => {
      cancelled = true
    }
  }, [step, review, accountAddress])

  const position = positions.find((entry) => entry.poolId === poolId) ?? null

  function signerSecret(): string {
    const secret =
      walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    if (!secret) throw new Error('Signing key not found. Unlock the wallet again.')
    return secret
  }

  function setAmount(kind: ActionKind, value: string) {
    setAmounts((current) => ({ ...current, [kind]: value }))
  }

  /** The typed amount as raw stroops; `0n` empty, `-1n` unparseable. */
  function parseAmount(kind: ActionKind): bigint {
    const raw = amounts[kind].trim()
    if (!raw) return 0n
    try {
      return sharesToStroops(raw)
    } catch {
      return -1n
    }
  }

  async function sign(action: ReviewAction) {
    if (!accountAddress || !poolId) return
    beginTx()
    setStep('signing')
    setErrorMsg(null)
    try {
      await requirePasskey()
      const secret = signerSecret()
      const params = {
        backstopId: BACKSTOP_ID,
        poolId,
        sourceAddress: accountAddress,
        from: accountAddress,
        amountStroops: action.amount,
      }
      const xdr =
        action.kind === 'deposit'
          ? await buildBackstopDepositXdr(params)
          : action.kind === 'queue'
            ? await buildBackstopQueueWithdrawalXdr(params)
            : action.kind === 'cancel'
              ? await buildBackstopCancelWithdrawalXdr(params)
              : await buildBackstopWithdrawXdr(params)
      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret: secret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
      })
      setTxHash(hash)
      setAmounts(EMPTY_AMOUNTS)
      setReview(null)
      setStep('done')
      void load(accountAddress)
    } catch (err) {
      // A cancelled passkey prompt is not an error: nothing was submitted.
      if (isPasskeyCancellation(err)) {
        setErrorMsg(null)
        setStep(action.kind === 'deposit' || action.kind === 'queue' ? ACTION_COPY[action.kind].formStep : 'manage')
        return
      }
      setErrorMsg(
        err instanceof PasskeyCeremonyError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
      )
      setStep('error')
    } finally {
      endTx()
    }
  }

  /** Move a form to the review step; signing only ever starts from there. */
  function startReview(kind: ActionKind) {
    const amount = parseAmount(kind)
    if (amount <= 0n) return
    setReview({
      kind,
      amount,
      unlockAt: kind === 'queue' ? Math.floor(Date.now() / 1000) + queueLockSeconds : undefined,
    })
    setStep('review')
  }

  const hasPosition = position !== null && position.shares > 0n
  const queuedShares = position?.queuedShares ?? 0n
  const unlockedShares = position?.unlockedShares ?? 0n

  const depositAmount = parseAmount('deposit')
  const queueAmount = parseAmount('queue')
  const cancelAmount = parseAmount('cancel')
  const withdrawAmount = parseAmount('withdraw')

  const canDeposit = depositAmount > 0n && !loading && loadError === null
  const canQueue = hasPosition && queueAmount > 0n && queueAmount <= (position?.shares ?? 0n)
  // The cancel limit is what is queued — not the un-queued balance. Cancelling
  // more than queued is not a bigger cancel, it is a transaction the contract
  // rejects (`InsufficientFunds`).
  const canCancel = queuedShares > 0n && cancelAmount > 0n && cancelAmount <= queuedShares
  const canWithdraw = withdrawAmount > 0n && withdrawAmount <= unlockedShares

  if (!backstopAvailable) {
    return (
      <>
        <PageHeader eyebrow="Restaking" title="Backstop" />
        <Card className="mt-6">
          <p style={{ fontSize: '14px', color: 'rgba(246,247,248,0.6)', lineHeight: 1.6 }}>
            Backstop is not available on {network.displayName} yet. It opens on testnet first and
            only becomes available on mainnet once the live testnet cycle is complete.
          </p>
        </Card>
      </>
    )
  }

  if (!BACKSTOP_ID || CONFIGURED_POOLS.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Restaking" title="Backstop" />
        <Card className="mt-6">
          <p style={{ fontSize: '14px', color: 'rgba(246,247,248,0.6)', lineHeight: 1.6 }}>
            Blend has no backstop on {network.displayName}. The pool and backstop contracts are
            configured per network, and neither is set here.
          </p>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader eyebrow="Restaking" title="Backstop" />

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem 0' }}>
          <div className="spinner spinner-light" />
        </div>
      ) : step === 'signing' ? (
        <Card className="mt-6" >
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <div className="spinner spinner-light" style={{ margin: '0 auto 1rem' }} />
            <p style={{ fontWeight: 500 }}>Waiting for passkey…</p>
            <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', marginTop: '6px' }}>
              Approve with Face ID / fingerprint to sign this backstop transaction.
            </p>
          </div>
        </Card>
      ) : step === 'done' ? (
        <Card className="mt-6">
          <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
            <p
              style={{
                fontFamily: 'Lora, Georgia, serif',
                fontStyle: 'italic',
                fontWeight: 600,
                fontSize: '20px',
              }}
            >
              Backstop transaction submitted
            </p>
            {txHash && (
              // The whole hash: the success screen is where a user copies it
              // for an explorer, and an ellipsis makes that impossible.
              <p style={{ marginTop: '8px', padding: '0 6px', wordBreak: 'break-all' }}>
                <Mono>{txHash}</Mono>
              </p>
            )}
            <div style={{ marginTop: '20px' }}>
              <PrimaryAction onClick={() => setStep('view')}>Back to backstop</PrimaryAction>
            </div>
          </div>
        </Card>
      ) : step === 'error' ? (
        <Card className="mt-6">
          <div style={{ textAlign: 'center', padding: '0.5rem 0' }}>
            <p style={{ fontWeight: 500 }}>That backstop transaction did not go through</p>
            <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.5)', marginTop: '8px', lineHeight: 1.5 }}>
              {errorMsg}
            </p>
            <p style={{ marginTop: '12px' }}>
              <Mono>Nothing was submitted if the passkey prompt was dismissed.</Mono>
            </p>
            <div style={{ marginTop: '20px' }}>
              <Pill onClick={() => setStep('view')}>Try again</Pill>
            </div>
          </div>
        </Card>
      ) : step === 'review' && review ? (
        <ReviewScreen
          action={review}
          position={position}
          queueLockSeconds={queueLockSeconds}
          preflight={preflight}
          onBack={() => setStep(ACTION_COPY[review.kind].formStep)}
          onConfirm={() => void sign(review)}
        />
      ) : (
        <>
          {/* What the position is — shown before the first deposit, and kept
              above it afterwards so the risk is never only on the empty state. */}
          <Card className="mt-6">
            <SectionLabel>What this position is</SectionLabel>
            <p style={{ fontSize: '14px', lineHeight: 1.65, color: 'rgba(246,247,248,0.72)', marginTop: '12px' }}>
              Backstopping is first-loss capital for a Blend lending pool. You deposit the pool
              token for BLND and USDC, and in return you earn emissions and a share of the interest
              the pool charges borrowers. If a borrower&apos;s debt cannot be liquidated, the shortfall
              is taken from this deposit before anyone else&apos;s. Withdrawing is not instant: you
              queue it, wait out the {formatLockDuration(queueLockSeconds)} lock, then withdraw.
            </p>
            {!hasPosition && !loadError && (
              <p style={{ fontSize: '13px', lineHeight: 1.6, color: 'rgba(246,247,248,0.45)', marginTop: '12px' }}>
                You have no backstop position in this pool yet, so nothing of yours is at risk here.
                The figures below start at zero and appear once your first deposit confirms.
              </p>
            )}
          </Card>

          {loadError && (
            <Card className="mt-5">
              <SectionLabel tone="dim">Position unavailable</SectionLabel>
              <p style={{ fontSize: '13px', lineHeight: 1.6, color: 'rgba(246,247,248,0.6)', marginTop: '12px' }}>
                {loadError}
              </p>
              <div style={{ marginTop: '14px' }}>
                <Pill onClick={() => accountAddress && void load(accountAddress)}>Try again</Pill>
              </div>
            </Card>
          )}

          {CONFIGURED_POOLS.length > 1 && (
            <div className="vw-more" style={{ marginTop: '18px' }}>
              {CONFIGURED_POOLS.map((id: string) => (
                <button
                  key={id}
                  type="button"
                  className={id === poolId ? 'vw-chip vw-chip--active' : 'vw-chip'}
                  aria-pressed={id === poolId}
                  onClick={() => setPoolId(id)}
                >
                  Pool {id.slice(0, 6)}…
                </button>
              ))}
            </div>
          )}

          {/* Position, with emissions kept out of the position value. */}
          <Card className="mt-5">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
              <div>
                <SectionLabel>Your position</SectionLabel>
                <DisplayNumber size={38} className="mt-[10px]">
                  {lp(position?.shareValue ?? 0)}
                </DisplayNumber>
                <div style={{ marginTop: '8px' }}>
                  <Mono>LP tokens · current share value</Mono>
                </div>
              </div>
              <Tag tone={hasPosition ? 'teal' : 'dim'}>
                {loadError ? 'unavailable' : hasPosition ? 'backstopping' : 'no deposit'}
              </Tag>
            </div>

            <div style={{ marginTop: '18px' }}>
              <ListRow>
                <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>BLND leg</span>
                <Mono>{lp(position?.blnd ?? 0)} BLND</Mono>
              </ListRow>
              <ListRow>
                <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>USDC leg</span>
                <Mono>{lp(position?.usdc ?? 0)} USDC</Mono>
              </ListRow>
              <ListRow>
                <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>
                  Shares held
                </span>
                <Mono>{position ? stroopsToShares(position.shares) : '0'}</Mono>
              </ListRow>
              <ListRow last>
                <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>
                  Emissions earned
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                  <span className="font-mono" style={{ fontSize: '13px', color: 'var(--teal)' }}>
                    {lp(position?.emissions ?? 0)} BLND
                  </span>
                  <Tag tone="dim">separate</Tag>
                </span>
              </ListRow>
            </div>
            <p style={{ fontSize: '12px', lineHeight: 1.55, color: 'rgba(246,247,248,0.4)', marginTop: '14px' }}>
              Emissions are rewards already earned and are not part of the share value above. The
              share value moves with pool interest and with any bad debt the backstop covers.
            </p>
          </Card>

          {/* Queue */}
          <Card className="mt-5">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <SectionLabel tone={unlockedShares > 0n ? 'teal' : 'dim'}>
                Queued withdrawals
              </SectionLabel>
              <Mono>
                {queuedShares > 0n ? `${stroopsToShares(queuedShares)} shares queued` : 'nothing queued'}
              </Mono>
            </div>

            {position && position.queued.length > 0 ? (
              <div style={{ marginTop: '12px' }}>
                {position.queued.map((entry, index) => (
                  <ListRow key={`${entry.exp}-${index}`} last={index === position.queued.length - 1}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      <Mono>{stroopsToShares(entry.shares)} shares</Mono>
                      <span style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)' }}>
                        {unlockLabel(entry.exp, now)} · {formatUnlockDate(entry.exp)}
                      </span>
                    </span>
                    <Tag tone={entry.exp <= now ? 'teal' : 'dim'}>
                      {entry.exp <= now ? 'withdrawable' : 'locked'}
                    </Tag>
                  </ListRow>
                ))}
              </div>
            ) : (
              <p style={{ fontSize: '13px', lineHeight: 1.6, color: 'rgba(246,247,248,0.45)', marginTop: '12px' }}>
                Queued shares keep backing the pool and stop earning emissions until you either
                cancel the queue or withdraw once the {formatLockDuration(queueLockSeconds)} lock
                expires.
              </p>
            )}
          </Card>

          {/* Actions */}
          {step === 'view' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '20px' }}>
              <PrimaryAction
                onClick={() => { setAmount('deposit', ''); setStep('deposit-form') }}
                disabled={loading || loadError !== null}
              >
                Deposit
              </PrimaryAction>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <Pill
                  className="flex-1"
                  onClick={() => { setAmount('queue', ''); setStep('queue-form') }}
                  disabled={!hasPosition || loadError !== null}
                >
                  Queue withdrawal
                </Pill>
                <Pill
                  className="flex-1"
                  onClick={() => { setAmount('cancel', ''); setAmount('withdraw', ''); setStep('manage') }}
                  disabled={queuedShares <= 0n || loadError !== null}
                >
                  Manage queue
                </Pill>
              </div>
            </div>
          )}

          {step === 'deposit-form' && (
            <Card className="mt-5">
              <SectionLabel>Deposit LP tokens</SectionLabel>
              <input
                className="input-field"
                type="number"
                inputMode="decimal"
                min={0}
                aria-label="Deposit amount in BLND:USDC LP tokens"
                placeholder="0.00"
                value={amounts.deposit}
                onChange={(e) => setAmount('deposit', e.target.value)}
                style={{ fontSize: '24px', marginTop: '12px', width: '100%' }}
              />
              <Mono>Amount is in BLND:USDC LP tokens</Mono>
              <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)', marginTop: '10px', lineHeight: 1.55 }}>
                You need BLND:USDC pool tokens to backstop with — they are the LP tokens of the
                Blend BLND:USDC pool, and you get them by supplying BLND and USDC to that pool in{' '}
                <a href="/earn" style={{ color: 'var(--teal)', textDecoration: 'underline' }}>
                  Earn
                </a>
                . The deposit earns emissions from the moment it confirms, and cannot be withdrawn
                without the {formatLockDuration(queueLockSeconds)} queue.
              </p>
              {loadError && (
                <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.6)', marginTop: '10px', lineHeight: 1.55 }}>
                  Deposit is disabled until your position loads.
                </p>
              )}
              <div style={{ display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' }}>
                <PrimaryAction
                  onClick={() => startReview('deposit')}
                  disabled={!canDeposit}
                  className="flex-1"
                >
                  Review deposit
                </PrimaryAction>
                <Pill className="flex-1" onClick={() => setStep('view')}>Cancel</Pill>
              </div>
            </Card>
          )}

          {step === 'queue-form' && (
            <Card className="mt-5">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <SectionLabel>Queue shares for withdrawal</SectionLabel>
                <button
                  type="button"
                  className="vw-pill"
                  onClick={() => setAmount('queue', position ? stroopsToShares(position.shares) : '')}
                >
                  Use all
                </button>
              </div>
              <input
                className="input-field"
                type="number"
                inputMode="decimal"
                min={0}
                aria-label="Queue amount in backstop shares"
                placeholder="0.00"
                value={amounts.queue}
                onChange={(e) => setAmount('queue', e.target.value)}
                style={{ fontSize: '24px', marginTop: '12px', width: '100%' }}
              />
              <Mono>Amount is in shares · {position ? stroopsToShares(position.shares) : '0'} available</Mono>
              <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)', marginTop: '10px', lineHeight: 1.55 }}>
                Queued shares stay in the backstop for {formatLockDuration(queueLockSeconds)} and
                stop earning emissions for that time. You can cancel the queue before you withdraw.
              </p>
              <div style={{ display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' }}>
                <PrimaryAction
                  onClick={() => startReview('queue')}
                  disabled={!canQueue}
                  className="flex-1"
                >
                  Review queue
                </PrimaryAction>
                <Pill className="flex-1" onClick={() => setStep('view')}>Cancel</Pill>
              </div>
            </Card>
          )}

          {step === 'manage' && (
            <>
              <Card className="mt-5">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <SectionLabel>Withdraw unlocked shares</SectionLabel>
                  <Mono>{stroopsToShares(unlockedShares)} shares ready</Mono>
                </div>
                <input
                  className="input-field"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  aria-label="Withdraw amount in backstop shares"
                  placeholder="0.00"
                  value={amounts.withdraw}
                  onChange={(e) => setAmount('withdraw', e.target.value)}
                  style={{ fontSize: '24px', marginTop: '12px', width: '100%' }}
                />
                <Mono>Amount is in shares</Mono>
                <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)', marginTop: '10px', lineHeight: 1.55 }}>
                  Withdraw releases shares whose {formatLockDuration(queueLockSeconds)} lock has
                  expired. It cannot touch shares that are still locked.
                </p>
                <div style={{ display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' }}>
                  <PrimaryAction
                    onClick={() => startReview('withdraw')}
                    disabled={!canWithdraw}
                    className="flex-1"
                  >
                    Review withdraw
                  </PrimaryAction>
                  <button
                    type="button"
                    className="vw-pill flex-1"
                    onClick={() => setAmount('withdraw', stroopsToShares(unlockedShares))}
                  >
                    Use all unlockable
                  </button>
                </div>
              </Card>

              <Card className="mt-5">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <SectionLabel>Cancel queued shares</SectionLabel>
                  <Mono>{stroopsToShares(queuedShares)} shares queued</Mono>
                </div>
                <input
                  className="input-field"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  aria-label="Cancel amount in backstop shares"
                  placeholder="0.00"
                  value={amounts.cancel}
                  onChange={(e) => setAmount('cancel', e.target.value)}
                  style={{ fontSize: '24px', marginTop: '12px', width: '100%' }}
                />
                <Mono>Amount is in shares</Mono>
                <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)', marginTop: '10px', lineHeight: 1.55 }}>
                  Cancel returns queued shares to your position, where they start earning emissions
                  again. The limit is what is queued — including shares that are still locked — not
                  your un-queued balance.
                </p>
                <div style={{ display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' }}>
                  <PrimaryAction
                    onClick={() => startReview('cancel')}
                    disabled={!canCancel}
                    className="flex-1"
                  >
                    Review cancel
                  </PrimaryAction>
                  <button
                    type="button"
                    className="vw-pill flex-1"
                    onClick={() => setAmount('cancel', stroopsToShares(queuedShares))}
                  >
                    Use all queued
                  </button>
                </div>
              </Card>

              <div style={{ marginTop: '12px' }}>
                <Pill onClick={() => setStep('view')}>Back</Pill>
              </div>
            </>
          )}
        </>
      )}
    </>
  )
}

/** The confirm step: amount, unit and unlock date, then the pre-flight. */
function ReviewScreen({
  action,
  position,
  queueLockSeconds,
  preflight,
  onBack,
  onConfirm,
}: {
  action: ReviewAction
  position: BackstopPosition | null
  queueLockSeconds: number
  preflight: PreflightState
  onBack: () => void
  onConfirm: () => void
}) {
  const copy = ACTION_COPY[action.kind]
  const amount = stroopsToShares(action.amount)

  return (
    <Card className="mt-5">
      <SectionLabel>Review {copy.title.toLowerCase()}</SectionLabel>
      <div style={{ marginTop: '14px' }}>
        <ListRow>
          <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>Amount</span>
          <Mono>{amount}</Mono>
        </ListRow>
        <ListRow>
          <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>Unit</span>
          <Mono>{copy.unit}</Mono>
        </ListRow>

        {action.kind === 'queue' && action.unlockAt !== undefined && (
          <ListRow>
            <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>Unlocks</span>
            <span style={{ textAlign: 'right' }}>
              <Mono>{formatUnlockDate(action.unlockAt)}</Mono>
              <span style={{ display: 'block', fontSize: '12px', color: 'rgba(246,247,248,0.4)' }}>
                in {formatLockDuration(queueLockSeconds)}
              </span>
            </span>
          </ListRow>
        )}

        {action.kind === 'withdraw' && (
          <ListRow>
            <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>Unlocks</span>
            <Mono>now — the lock has expired</Mono>
          </ListRow>
        )}

        {action.kind === 'cancel' && (
          <ListRow>
            <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>Unlocks</span>
            <Mono>no lock — the shares return to your position</Mono>
          </ListRow>
        )}

        <ListRow last>
          <span style={{ fontSize: '13px', color: 'rgba(246,247,248,0.6)' }}>Pool</span>
          <Mono>{position ? `Pool ${position.poolId.slice(0, 6)}…` : 'this pool'}</Mono>
        </ListRow>
      </div>

      <div style={{ marginTop: '16px' }}>
        {preflight.status === 'checking' && (
          <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.5)' }}>
            Checking your XLM fee balance
            {action.kind === 'deposit' ? ' and your BLND:USDC LP tokens' : ''}…
          </p>
        )}
        {preflight.problems.map((problem) => (
          <p
            key={problem}
            style={{ fontSize: '12px', color: 'rgba(246,160,160,0.9)', lineHeight: 1.55, marginTop: '6px' }}
          >
            {problem}
          </p>
        ))}
        {preflight.status === 'ok' && (
          <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.5)', lineHeight: 1.55 }}>
            The fee and balance check passed. Signing will show your passkey prompt.
          </p>
        )}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: '18px', flexWrap: 'wrap' }}>
        <PrimaryAction
          onClick={onConfirm}
          disabled={preflight.status !== 'ok'}
          className="flex-1"
        >
          Confirm and sign
        </PrimaryAction>
        <Pill className="flex-1" onClick={onBack}>Back</Pill>
      </div>
    </Card>
  )
}

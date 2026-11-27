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
  buildBackstopCancelWithdrawalXdr,
  buildBackstopDepositXdr,
  buildBackstopQueueWithdrawalXdr,
  buildBackstopWithdrawXdr,
  configuredBackstopId,
  loadBackstopPositions,
  sharesToStroops,
  stroopsToShares,
  type BackstopPosition,
} from '@/lib/backstop'
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
  | 'manage-form'
  | 'signing'
  | 'done'
  | 'error'

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
  const days = Math.ceil(seconds / 86_400)
  if (days >= 2) return `in ${days} days`
  const hours = Math.max(1, Math.ceil(seconds / 3_600))
  return `in ${hours} ${hours === 1 ? 'hour' : 'hours'}`
}

export default function BackstopPage() {
  useInactivityLock()

  const [step, setStep] = useState<Step>('view')
  const [accountAddress, setAccountAddress] = useState<string | null>(null)
  const [positions, setPositions] = useState<BackstopPosition[]>([])
  const [poolId, setPoolId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  const load = useCallback(async (address: string) => {
    setLoading(true)
    try {
      const loaded = await loadBackstopPositions(address, CONFIGURED_POOLS)
      setPositions(loaded)
      setPoolId((current) => current ?? loaded[0]?.poolId ?? CONFIGURED_POOLS[0] ?? null)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setStep('error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
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
  }, [load])

  // The queue countdown is a date, not a subscription: tick once a minute.
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(timer)
  }, [])

  const position = positions.find((entry) => entry.poolId === poolId) ?? null

  function signerSecret(): string {
    const secret =
      walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    if (!secret) throw new Error('Signing key not found. Unlock the wallet again.')
    return secret
  }

  async function sign(build: (secret: string) => Promise<string>, onCancel: Step) {
    if (!accountAddress || !poolId) return
    beginTx()
    setStep('signing')
    setErrorMsg(null)
    try {
      await requirePasskey()
      const secret = signerSecret()
      const xdr = await build(secret)
      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret: secret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
      })
      setTxHash(hash)
      setAmount('')
      setStep('done')
      void load(accountAddress)
    } catch (err) {
      // A cancelled passkey prompt is not an error: nothing was submitted.
      if (isPasskeyCancellation(err)) {
        setErrorMsg(null)
        setStep(onCancel)
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

  function handleDeposit() {
    if (!accountAddress || !poolId) return
    void sign(async () => {
      const amountStroops = sharesToStroops(amount)
      return buildBackstopDepositXdr({
        backstopId: BACKSTOP_ID,
        poolId,
        sourceAddress: accountAddress,
        from: accountAddress,
        amountStroops,
      })
    }, 'deposit-form')
  }

  function handleQueue() {
    if (!accountAddress || !poolId) return
    void sign(async () => {
      const amountStroops = sharesToStroops(amount)
      return buildBackstopQueueWithdrawalXdr({
        backstopId: BACKSTOP_ID,
        poolId,
        sourceAddress: accountAddress,
        from: accountAddress,
        amountStroops,
      })
    }, 'queue-form')
  }

  function handleCancelQueue() {
    if (!accountAddress || !poolId) return
    void sign(async () => {
      const amountStroops = sharesToStroops(amount)
      return buildBackstopCancelWithdrawalXdr({
        backstopId: BACKSTOP_ID,
        poolId,
        sourceAddress: accountAddress,
        from: accountAddress,
        amountStroops,
      })
    }, 'manage-form')
  }

  function handleWithdraw() {
    if (!accountAddress || !poolId) return
    void sign(async () => {
      const amountStroops = sharesToStroops(amount)
      return buildBackstopWithdrawXdr({
        backstopId: BACKSTOP_ID,
        poolId,
        sourceAddress: accountAddress,
        from: accountAddress,
        amountStroops,
      })
    }, 'manage-form')
  }

  const parsedAmount = (() => {
    try {
      return amount.trim() ? sharesToStroops(amount) : 0n
    } catch {
      return -1n
    }
  })()

  const hasPosition = position !== null && position.shares > 0n

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
              <p style={{ marginTop: '8px' }}>
                <Mono>{txHash.slice(0, 20)}…</Mono>
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
              queue it, wait out the 17-day lock, then withdraw.
            </p>
            {!hasPosition && (
              <p style={{ fontSize: '13px', lineHeight: 1.6, color: 'rgba(246,247,248,0.45)', marginTop: '12px' }}>
                You have no backstop position in this pool yet, so nothing of yours is at risk here.
                The figures below start at zero and appear once your first deposit confirms.
              </p>
            )}
          </Card>

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
                {hasPosition ? 'backstopping' : 'no deposit'}
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
              <SectionLabel tone={(position?.unlockedQueued ?? 0) > 0 ? 'teal' : 'dim'}>
                Queued withdrawals
              </SectionLabel>
              <Mono>{(position?.totalQueued ?? 0) > 0 ? `${lp(position!.totalQueued)} LP queued` : 'nothing queued'}</Mono>
            </div>

            {position && position.queued.length > 0 ? (
              <div style={{ marginTop: '12px' }}>
                {position.queued.map((entry, index) => (
                  <ListRow key={`${entry.exp}-${index}`} last={index === position.queued.length - 1}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                      <Mono>{lp(entry.amount)} LP</Mono>
                      <span style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)' }}>
                        {unlockLabel(entry.exp, now)}
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
                cancel the queue or withdraw once the lock expires.
              </p>
            )}
          </Card>

          {/* Forms */}
          {step === 'view' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '20px' }}>
              <PrimaryAction onClick={() => { setAmount(''); setStep('deposit-form') }}>
                Deposit
              </PrimaryAction>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <Pill
                  className="flex-1"
                  onClick={() => { setAmount(''); setStep('queue-form') }}
                  disabled={!hasPosition}
                >
                  Queue withdrawal
                </Pill>
                <Pill
                  className="flex-1"
                  onClick={() => { setAmount(''); setStep('manage-form') }}
                  disabled={(position?.totalQueued ?? 0) <= 0}
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
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{ fontSize: '24px', marginTop: '12px', width: '100%' }}
              />
              <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)', marginTop: '10px', lineHeight: 1.55 }}>
                You need BLND:USDC pool tokens to backstop with. The deposit earns emissions from
                the moment it confirms, and cannot be withdrawn without the 17-day queue.
              </p>
              <div style={{ display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' }}>
                <PrimaryAction
                  onClick={handleDeposit}
                  disabled={parsedAmount <= 0n}
                  className="flex-1"
                >
                  Deposit
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
                  onClick={() => setAmount(position ? stroopsToShares(position.shares) : '')}
                >
                  Use all
                </button>
              </div>
              <input
                className="input-field"
                type="number"
                inputMode="decimal"
                min={0}
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{ fontSize: '24px', marginTop: '12px', width: '100%' }}
              />
              <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)', marginTop: '10px', lineHeight: 1.55 }}>
                Queued shares stay in the backstop for 17 days and stop earning emissions for that
                time. You can cancel the queue before you withdraw.
              </p>
              <div style={{ display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' }}>
                <PrimaryAction
                  onClick={handleQueue}
                  disabled={parsedAmount <= 0n || (position !== null && parsedAmount > position.shares)}
                  className="flex-1"
                >
                  Queue
                </PrimaryAction>
                <Pill className="flex-1" onClick={() => setStep('view')}>Cancel</Pill>
              </div>
            </Card>
          )}

          {step === 'manage-form' && (
            <Card className="mt-5">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                <SectionLabel>Manage the queue</SectionLabel>
                <Mono>{lp(position?.unlockedQueued ?? 0)} LP ready</Mono>
              </div>
              <input
                className="input-field"
                type="number"
                inputMode="decimal"
                min={0}
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{ fontSize: '24px', marginTop: '12px', width: '100%' }}
              />
              <p style={{ fontSize: '12px', color: 'rgba(246,247,248,0.4)', marginTop: '10px', lineHeight: 1.55 }}>
                Withdraw releases shares whose lock has expired. Cancel returns queued shares to
                your position, where they start earning emissions again.
              </p>
              <div style={{ display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' }}>
                <PrimaryAction
                  onClick={handleWithdraw}
                  disabled={parsedAmount <= 0n || (position !== null && parsedAmount > position.unlockedShares)}
                  className="flex-1"
                >
                  Withdraw
                </PrimaryAction>
                <Pill
                  className="flex-1"
                  onClick={handleCancelQueue}
                  disabled={parsedAmount <= 0n || (position !== null && parsedAmount > position.shares + position.unlockedShares)}
                >
                  Cancel queued shares
                </Pill>
              </div>
              <div style={{ display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="vw-pill flex-1"
                  onClick={() => setAmount(position ? stroopsToShares(position.unlockedShares) : '')}
                >
                  Use all withdrawable
                </button>
                <Pill className="flex-1" onClick={() => setStep('view')}>Back</Pill>
              </div>
            </Card>
          )}
        </>
      )}
    </>
  )
}

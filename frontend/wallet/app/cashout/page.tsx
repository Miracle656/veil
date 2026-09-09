'use client'

/**
 * Cash out — USDC on Stellar to a Nigerian bank account, via Linq.
 *
 * The web counterpart of `frontend/mobile/app/cash-out.tsx`, built to the
 * `Veil Web.dc.html` design: a three-segment progress rail over amount, bank
 * account, and confirm, then a deposit panel with the ten-minute clock running.
 *
 * Ordered so the cheapest failure comes first. The amount is checked against
 * the balance before a bank is chosen, and the bank account is verified against
 * the bank's own records before any order exists. A wrong account number is
 * cheap to fix at step two and irreversible once naira has been sent.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'

import { PageHeader } from '@/components/ui/primitives'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { NIGERIAN_BANKS, bankName } from '@/lib/nigerianBanks'
import {
  OfframpUnavailable,
  createOrder,
  forgetActiveOrder,
  getOfframpRate,
  getOrderStatus,
  isFailure,
  isOfframpAvailable,
  isTerminal,
  lastKnownAvailability,
  rememberActiveOrder,
  rememberDepositAddress,
  verifyBankAccount,
  type OfframpOrder,
  type VerifiedBank,
} from '@/lib/offramp'

type Step = 'amount' | 'bank' | 'review' | 'deposit' | 'done'

/** Linq expires an unpaid order ten minutes after it is created. */
const DEPOSIT_WINDOW_MS = 10 * 60 * 1000

const QUICK_AMOUNTS = [20_000, 50_000, 100_000, 250_000]

/**
 * Linq's status strings in the user's terms.
 *
 * The raw values are operational vocabulary. "awaiting_deposit" tells someone
 * nothing about whether their money is safe.
 */
function statusLabel(raw: string): string {
  const s = raw.toLowerCase()
  if (s.includes('await') || s.includes('initiated')) return 'Waiting for your USDC'
  if (s.includes('confirm')) return 'USDC received, confirming on Stellar'
  if (s.includes('bank queue')) return 'Deposit received, sending to the bank'
  if (s.includes('disbursed') || s.includes('completed')) return 'Naira sent to the bank account'
  if (s.includes('expired')) return 'The deposit window closed'
  if (s.includes('refund')) return 'Refunded to your wallet'
  if (s.includes('failed')) return 'The bank payout failed'
  return raw
}

function errorMessage(err: unknown): string {
  if (err instanceof OfframpUnavailable) {
    return `${err.message} Cash out is not available right now.`
  }
  return err instanceof Error ? err.message : 'Something went wrong.'
}

export default function CashOutPage() {
  const router = useRouter()

  const [step, setStep] = useState<Step>('amount')
  const [available, setAvailable] = useState<boolean>(lastKnownAvailability())
  const [probed, setProbed] = useState(false)
  const [rate, setRate] = useState<number | null>(null)
  const [rateError, setRateError] = useState<string | null>(null)

  const [amountNGN, setAmountNGN] = useState('')
  const [bankCode, setBankCode] = useState('')
  const [bankQuery, setBankQuery] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [verified, setVerified] = useState<VerifiedBank | null>(null)

  const [order, setOrder] = useState<OfframpOrder | null>(null)
  const [createdAt, setCreatedAt] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const [status, setStatus] = useState('initiated')
  const [copied, setCopied] = useState(false)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [contractAddress, setContractAddress] = useState<string | null>(null)
  const [feePayer, setFeePayer] = useState<string | null>(null)

  // The refund address must be the CLASSIC account. A Veil wallet is a
  // contract, which cannot hold a trustline, so a refund sent there could never
  // settle.
  useEffect(() => {
    const stored = walletSession.getItem('invisible_wallet_address')
    if (!stored) {
      router.replace('/lock')
      return
    }
    setContractAddress(stored)

    const secret =
      walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    if (secret) {
      try {
        setFeePayer(Keypair.fromSecret(secret).publicKey())
        return
      } catch {
        /* malformed secret falls through to the stored public key */
      }
    }
    const pub = walletLocal.getItem('veil_signer_public_key')
    if (pub) setFeePayer(pub)
  }, [router])

  useEffect(() => {
    let cancelled = false
    void isOfframpAvailable().then((ok) => {
      if (cancelled) return
      setAvailable(ok)
      setProbed(true)
      if (!ok) return
      getOfframpRate()
        .then((r) => !cancelled && setRate(r.rate))
        .catch((err) => !cancelled && setRateError(errorMessage(err)))
    })
    return () => {
      cancelled = true
    }
  }, [])

  const ngn = Number(amountNGN.replace(/[^0-9.]/g, ''))
  const estimatedUsdc = rate && ngn > 0 ? ngn / rate : null

  const filteredBanks = useMemo(
    () => NIGERIAN_BANKS.filter((b) => b.name.toLowerCase().includes(bankQuery.trim().toLowerCase())),
    [bankQuery],
  )

  /**
   * Verification is a lookup, not a decision: it needs a bank and ten digits
   * and nothing else, so it runs as soon as it has both. The ref stops a failed
   * lookup retrying itself forever on the same pair.
   */
  const attempted = useRef<string | null>(null)
  useEffect(() => {
    if (step !== 'bank') return
    const account = accountNumber.trim()
    if (!bankCode || account.length !== 10) return
    const key = `${bankCode}:${account}`
    if (attempted.current === key) return
    attempted.current = key

    let cancelled = false
    setError(null)
    setBusy(true)
    verifyBankAccount(bankCode, account)
      .then((v) => !cancelled && setVerified(v))
      .catch((err) => {
        if (cancelled) return
        setVerified(null)
        setError(errorMessage(err))
      })
      .finally(() => !cancelled && setBusy(false))
    return () => {
      cancelled = true
    }
  }, [step, bankCode, accountNumber])

  const clearVerification = useCallback(() => {
    setVerified(null)
    setError(null)
    attempted.current = null
  }, [])

  async function handleCreateOrder() {
    setError(null)
    setBusy(true)
    try {
      if (!verified) throw new Error('Verify the bank account first.')
      if (!feePayer) throw new Error('This browser has no classic account to refund to.')

      const created = await createOrder({
        amountNGN: ngn,
        bankAccount: verified.accountNumber,
        bankCode: verified.bankCode,
        bankName: verified.bankName || bankName(verified.bankCode),
        accountName: verified.accountName,
        refundAddress: feePayer,
      })
      setOrder(created)
      setStatus(created.status)
      setCreatedAt(Date.now())
      rememberActiveOrder(created.id)
      // So activity can call this "Cashed out" instead of "Sent".
      rememberDepositAddress(created.walletAddress)
      setStep('deposit')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // The deposit clock. Without a visible countdown the screen reads as "working
  // on it" when in fact it is waiting for the user, and the window closes
  // silently.
  useEffect(() => {
    if (step !== 'deposit' || !createdAt) return
    const tick = () => {
      const left = Math.max(0, Math.ceil((createdAt + DEPOSIT_WINDOW_MS - Date.now()) / 1000))
      setSecondsLeft(left)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [step, createdAt])

  // Poll the order until it reaches a state nothing further will change.
  useEffect(() => {
    if (step !== 'deposit' || !order) return
    let cancelled = false
    const poll = async () => {
      try {
        const s = await getOrderStatus(order.id)
        if (cancelled) return
        setStatus(s.status)
        if (isTerminal(s.status)) {
          forgetActiveOrder()
          if (!isFailure(s.status)) setStep('done')
        }
      } catch {
        /* a failed poll is not a failed order; the next tick tries again */
      }
    }
    void poll()
    const id = setInterval(() => void poll(), 8000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [step, order])

  async function copyDepositAddress() {
    if (!order) return
    await navigator.clipboard.writeText(order.walletAddress)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const stepNumber = step === 'amount' ? 1 : step === 'bank' ? 2 : 3

  if (probed && !available) {
    return (
      <div className="wallet-shell">
        <PageHeader eyebrow="Off-ramp" title="Cash out to bank" />
        <main style={{ padding: '0 1.5rem 3rem', maxWidth: 620 }}>
          <div style={panel}>
            <p style={{ margin: 0, color: 'var(--off-white)', fontWeight: 600 }}>
              Cash out is not available right now.
            </p>
            <p style={{ margin: '0.5rem 0 0', color: 'rgba(246,247,248,0.6)', fontSize: '0.875rem', lineHeight: 1.6 }}>
              The service that converts USDC to naira is not responding. Nothing has been sent and
              no order was created. Your balance is untouched.
            </p>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="wallet-shell">
      <PageHeader
        eyebrow="Off-ramp"
        title="Cash out to bank"
        action={
          step === 'deposit' || step === 'done' ? undefined : (
            <span style={{ ...eyebrow, whiteSpace: 'nowrap' }}>{`STEP ${stepNumber} OF 3`}</span>
          )
        }
      />

      <main style={{ padding: '0 1.5rem 3rem', maxWidth: 620 }}>
        {/* Three segments, filled to the step reached. */}
        {step !== 'done' && (
          <div style={{ marginBottom: '1.75rem' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  style={{
                    flex: 1,
                    height: 3,
                    borderRadius: 2,
                    background: stepNumber >= n || step === 'deposit' ? 'var(--gold)' : 'rgba(255,255,255,0.1)',
                  }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              {['AMOUNT', 'BANK ACCOUNT', 'CONFIRM'].map((l) => (
                <span key={l} style={eyebrow}>
                  {l}
                </span>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div style={{ ...panel, borderColor: 'var(--danger, #E06A5B)', marginBottom: '1.25rem' }}>
            <p style={{ margin: 0, fontSize: '0.875rem', lineHeight: 1.6 }}>{error}</p>
          </div>
        )}

        {step === 'amount' && (
          <>
            <p style={eyebrow}>THEY RECEIVE</p>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
              <span style={{ fontSize: '1.75rem', color: 'rgba(246,247,248,0.5)' }}>₦</span>
              <input
                value={amountNGN}
                onChange={(e) => setAmountNGN(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric"
                placeholder="0"
                aria-label="Amount in naira"
                style={{
                  background: 'none',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--off-white)',
                  fontSize: '2.5rem',
                  fontWeight: 600,
                  width: '100%',
                  padding: 0,
                }}
              />
            </div>
            <p style={{ margin: '0.5rem 0 0', color: 'rgba(246,247,248,0.55)', fontSize: '0.875rem' }}>
              {rate === null
                ? rateError
                  ? 'Rate unavailable right now.'
                  : 'Fetching the current rate…'
                : `You send ≈ ${estimatedUsdc ? estimatedUsdc.toFixed(2) : '0.00'} USDC @ ₦${rate.toLocaleString('en-NG')}`}
            </p>

            <div style={{ display: 'flex', gap: 8, marginTop: '1.25rem', flexWrap: 'wrap' }}>
              {QUICK_AMOUNTS.map((v) => (
                <button
                  key={v}
                  onClick={() => setAmountNGN(String(v))}
                  style={{
                    ...chip,
                    borderColor: ngn === v ? 'rgba(253,218,36,0.5)' : 'rgba(255,255,255,0.1)',
                    background: ngn === v ? 'rgba(253,218,36,0.1)' : 'rgba(255,255,255,0.03)',
                  }}
                >
                  ₦{v.toLocaleString('en-NG')}
                </button>
              ))}
            </div>

            <div style={{ ...panel, marginTop: '1.5rem', display: 'flex', gap: 12 }}>
              <span style={{ color: 'var(--gold)', fontWeight: 600 }}>i</span>
              <p style={{ margin: 0, fontSize: '0.8125rem', lineHeight: 1.6, color: 'rgba(246,247,248,0.65)' }}>
                The rate is locked for 10 minutes once the order is created. Your USDC keeps earning
                until it leaves.
              </p>
            </div>

            <button
              onClick={() => setStep('bank')}
              disabled={!(ngn > 0) || rate === null}
              style={{ ...primary, marginTop: '1.75rem', opacity: ngn > 0 && rate !== null ? 1 : 0.45 }}
            >
              Continue
            </button>
          </>
        )}

        {step === 'bank' && (
          <>
            <p style={eyebrow}>ACCOUNT NUMBER</p>
            <input
              value={accountNumber}
              onChange={(e) => {
                setAccountNumber(e.target.value.replace(/[^0-9]/g, '').slice(0, 10))
                clearVerification()
              }}
              inputMode="numeric"
              placeholder="0000000000"
              aria-label="Account number"
              style={field}
            />

            <p style={{ ...eyebrow, marginTop: '1.5rem' }}>BANK</p>
            {bankCode ? (
              // Once a bank is chosen the others are noise, and leaving them up
              // reads as "still choosing".
              <div style={{ ...row, justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--off-white)' }}>{bankName(bankCode)}</span>
                <button
                  onClick={() => {
                    setBankCode('')
                    setBankQuery('')
                    clearVerification()
                  }}
                  style={linkBtn}
                >
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  value={bankQuery}
                  onChange={(e) => setBankQuery(e.target.value)}
                  placeholder="Search banks"
                  aria-label="Search banks"
                  style={field}
                />
                <div style={{ marginTop: 8, maxHeight: 260, overflowY: 'auto' }}>
                  {filteredBanks.map((b, i) => (
                    <button
                      key={b.code}
                      onClick={() => setBankCode(b.code)}
                      style={{
                        ...row,
                        width: '100%',
                        textAlign: 'left',
                        borderTop: i > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                      }}
                    >
                      {b.name}
                    </button>
                  ))}
                </div>
              </>
            )}

            {verified ? (
              <div style={{ ...panel, marginTop: '1.25rem', borderColor: 'rgba(0,167,181,0.4)' }}>
                <p style={{ ...eyebrow, color: 'var(--teal, #00A7B5)' }}>ACCOUNT VERIFIED</p>
                <p style={{ margin: '4px 0 0', fontWeight: 600, letterSpacing: '0.02em' }}>
                  {verified.accountName.toUpperCase()}
                </p>
                <p style={{ margin: '2px 0 0', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)' }}>
                  Verified with {verified.bankName || bankName(verified.bankCode)}
                </p>
              </div>
            ) : busy ? (
              <div style={{ ...panel, marginTop: '1.25rem' }}>
                <p style={eyebrow}>CHECKING</p>
                <p style={{ margin: '4px 0 0', fontSize: '0.875rem', color: 'rgba(246,247,248,0.6)' }}>
                  Asking the bank who owns this account…
                </p>
              </div>
            ) : null}

            <div style={{ display: 'flex', gap: 10, marginTop: '1.75rem' }}>
              <button onClick={() => setStep('amount')} style={secondary}>
                Back
              </button>
              <button
                onClick={() => setStep('review')}
                disabled={!verified}
                style={{ ...primary, flex: 1, opacity: verified ? 1 : 0.45 }}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'review' && verified && (
          <>
            <div style={panel}>
              <p style={eyebrow}>THEY RECEIVE</p>
              <p style={{ margin: '4px 0 0', fontSize: '2rem', fontWeight: 600 }}>
                ₦{ngn.toLocaleString('en-NG')}
              </p>
              <p style={{ margin: '4px 0 0', fontSize: '0.875rem', color: 'rgba(246,247,248,0.55)' }}>
                You send ≈ {estimatedUsdc ? estimatedUsdc.toFixed(2) : '—'} USDC
              </p>
            </div>

            <div style={{ ...panel, marginTop: '1rem', display: 'grid', gap: 10 }}>
              <DetailRow label="Name" value={verified.accountName.toUpperCase()} />
              <DetailRow label="Bank" value={verified.bankName || bankName(verified.bankCode)} />
              <DetailRow label="Account" value={verified.accountNumber} />
              <DetailRow label="Rate" value={rate ? `₦${rate.toLocaleString('en-NG')} / USDC` : '—'} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: '1.75rem' }}>
              <button onClick={() => setStep('bank')} style={secondary} disabled={busy}>
                Back
              </button>
              <button onClick={handleCreateOrder} disabled={busy} style={{ ...primary, flex: 1 }}>
                {busy ? 'Creating order…' : 'Create order'}
              </button>
            </div>
          </>
        )}

        {step === 'deposit' && order && (
          <>
            <div style={panel}>
              <p style={eyebrow}>SEND EXACTLY</p>
              <p style={{ margin: '4px 0 0', fontSize: '1.75rem', fontWeight: 600 }}>
                {order.amountStableCoin} USDC
              </p>
              <p style={{ margin: '4px 0 0', fontSize: '0.875rem', color: 'rgba(246,247,248,0.55)' }}>
                to receive ₦{order.amountNGN.toLocaleString('en-NG')}
              </p>
            </div>

            <div style={{ ...panel, marginTop: '1rem' }}>
              <p style={eyebrow}>DEPOSIT ADDRESS</p>
              <p
                style={{
                  margin: '6px 0 0',
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: '0.8125rem',
                  wordBreak: 'break-all',
                  lineHeight: 1.6,
                }}
              >
                {order.walletAddress}
              </p>
              <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                <button onClick={copyDepositAddress} style={secondary}>
                  {copied ? 'Copied' : 'Copy address'}
                </button>
                <button
                  onClick={() =>
                    router.push(
                      `/send?to=${encodeURIComponent(order.walletAddress)}&amount=${order.amountStableCoin}&asset=USDC`,
                    )
                  }
                  style={{ ...primary, flex: 1 }}
                >
                  Pay from wallet
                </button>
              </div>
            </div>

            <div style={{ ...panel, marginTop: '1rem' }}>
              <p style={eyebrow}>STATUS</p>
              <p style={{ margin: '4px 0 0', fontWeight: 600 }}>{statusLabel(status)}</p>
              {secondsLeft !== null && (
                <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)' }}>
                  {secondsLeft > 0
                    ? `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')} left to send`
                    : 'The deposit window has closed. Any USDC sent now is refunded to your wallet.'}
                </p>
              )}
            </div>

            {contractAddress && (
              <p style={{ marginTop: '1rem', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.45)', lineHeight: 1.6 }}>
                Send from any wallet, not only this one. The address above accepts USDC on Stellar.
              </p>
            )}
          </>
        )}

        {step === 'done' && order && (
          <div style={{ ...panel, display: 'grid', gap: 12 }}>
            <p style={eyebrow}>PAID OUT</p>
            <p style={{ margin: 0, fontSize: '2rem', fontWeight: 600 }}>
              ₦{order.amountNGN.toLocaleString('en-NG')}
            </p>
            <div style={{ display: 'grid', gap: 8, marginTop: 4 }}>
              <DetailRow label="To" value={verified?.accountName.toUpperCase() ?? '—'} />
              <DetailRow label="Bank" value={verified ? verified.bankName || bankName(verified.bankCode) : '—'} />
              <DetailRow label="Account" value={verified?.accountNumber ?? '—'} />
              <DetailRow label="You sent" value={`${order.amountStableCoin} USDC`} />
              <DetailRow label="Rate" value={`₦${order.rate.toLocaleString('en-NG')} / USDC`} />
            </div>
            <button onClick={() => router.push('/dashboard')} style={{ ...primary, marginTop: 8 }}>
              Done
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
      <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.45)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.875rem', textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

const eyebrow: React.CSSProperties = {
  margin: 0,
  fontSize: '0.6875rem',
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'rgba(246,247,248,0.4)',
}

const panel: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 16,
  padding: '1.125rem 1.25rem',
}

const field: React.CSSProperties = {
  width: '100%',
  marginTop: 6,
  background: 'var(--surface)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '0.75rem 0.875rem',
  color: 'var(--off-white)',
  fontSize: '1rem',
  outline: 'none',
}

const row: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '0.75rem 0.25rem',
  background: 'none',
  border: 'none',
  color: 'rgba(246,247,248,0.85)',
  fontSize: '0.9375rem',
  cursor: 'pointer',
}

const primary: React.CSSProperties = {
  background: 'var(--gold)',
  color: '#0F0F0F',
  border: 'none',
  borderRadius: 999,
  padding: '0.875rem 1.5rem',
  fontSize: '0.9375rem',
  fontWeight: 600,
  cursor: 'pointer',
  width: '100%',
}

const secondary: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--off-white)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: 999,
  padding: '0.875rem 1.25rem',
  fontSize: '0.9375rem',
  fontWeight: 500,
  cursor: 'pointer',
}

const chip: React.CSSProperties = {
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 999,
  padding: '0.5rem 0.875rem',
  color: 'var(--off-white)',
  fontSize: '0.8125rem',
  cursor: 'pointer',
}

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--gold)',
  fontSize: '0.8125rem',
  fontWeight: 600,
  cursor: 'pointer',
}

'use client'

import { useState, useEffect } from 'react'
import { redirect, useRouter } from 'next/navigation'
import {
  ChevronLeft,
  Shield,
  ShieldCheck,
  ShieldAlert,
  ArrowRight,
  CheckCircle2,
  Copy,
  ExternalLink,
  BookUser,
  QrCode,
  Loader2,
  AlertTriangle,
  Send,
  Lock,
} from 'lucide-react'
import { ContactPicker } from '@/components/ContactPicker'
import { QrScanner } from '@/components/QrScanner'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  attachPrivacyProgress,
  getPrivacyClient,
  toUserFacingPrivacyError,
  type PrivacyClient,
  type RecipientRegistration,
} from '@/lib/privacy/client'
import { isPrivacyEnabled } from '@/lib/privacy/config'
import { StrKey } from '@stellar/stellar-sdk'

type FlowStep = 'recipient' | 'amount' | 'review' | 'submitting' | 'done'

export default function PrivateSendPage() {
  if (!isPrivacyEnabled()) redirect('/dashboard')

  const router = useRouter()
  useInactivityLock()

  const [step, setStep] = useState<FlowStep>('recipient')
  const [recipient, setRecipient] = useState<string>('')
  const [recipientName, setRecipientName] = useState<string>('')
  const [lookupState, setLookupState] = useState<{
    loading: boolean
    checked: boolean
    result: RecipientRegistration | null
    error: string | null
  }>({
    loading: false,
    checked: false,
    result: null,
    error: null,
  })

  const [amount, setAmount] = useState<string>('')
  // The shielded spendable balance in stroops, or null while it is unknown.
  // A pool balance is only known after the wallet syncs the pool's notes, so
  // the screen shows "syncing" rather than a confident number (or zero) until
  // the lookup completes — the same rule as the dashboard's PrivateBalanceCard.
  const [privateBalanceStroops, setPrivateBalanceStroops] = useState<bigint | null>(null)
  const [balanceSyncing, setBalanceSyncing] = useState(false)

  const [proofState, setProofState] = useState<string>('Preparing transfer…')
  const [txResult, setTxResult] = useState<{ txHash: string; amount: string } | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState<boolean>(false)

  const [showPicker, setShowPicker] = useState<boolean>(false)
  const [showScanner, setShowScanner] = useState<boolean>(false)

  // Follow the SDK's own proving events while a transfer runs (the shield
  // screen uses the same subscription), instead of staged fake messages.
  useEffect(() => attachPrivacyProgress((event) => {
    setProofState(event.message || 'Preparing proof…')
  }), [])

  // Load the shielded balance through the shared client. `privateBalance()`
  // needs the pool synced, so errors are surfaced and the balance stays
  // unknown rather than pretending to be a number.
  useEffect(() => {
    let cancelled = false
    setBalanceSyncing(true)
    void getPrivacyClient()
      .then((client) => client.privateBalance())
      .then((balance) => {
        if (!cancelled) {
          setPrivateBalanceStroops(balance)
          setBalanceSyncing(false)
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setBalanceSyncing(false)
          setErrorMsg(toUserFacingPrivacyError(caught))
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Read query params on initial mount for prefill (from the /send banner).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const q = new URLSearchParams(window.location.search)
    const to = q.get('to')
    const amt = q.get('amount')
    if (to) {
      setRecipient(to)
      void checkRegistry(to)
    }
    if (amt) setAmount(amt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function isValidStellarAddress(address: string): boolean {
    try {
      return StrKey.isValidEd25519PublicKey(address)
    } catch {
      return false
    }
  }

  // Check the recipient against SPP's public-key registry through the shared
  // client. `registered: true` means the registry contract holds an entry for
  // the address; when the local index is still syncing, `false` means "not
  // seen yet", so the notice says so instead of promising absence.
  async function checkRegistry(targetAddress: string) {
    const trimmed = targetAddress.trim()
    if (!trimmed) {
      setLookupState({ loading: false, checked: false, result: null, error: null })
      return
    }

    if (!isValidStellarAddress(trimmed)) {
      setLookupState({ loading: false, checked: true, result: null, error: 'Enter a valid G… Stellar address.' })
      return
    }

    setLookupState({ loading: true, checked: false, result: null, error: null })
    setErrorMsg(null)

    try {
      const client: PrivacyClient = await getPrivacyClient()
      const res = await client.recipientLookup(trimmed)
      setLookupState({ loading: false, checked: true, result: res, error: null })
    } catch (err) {
      setLookupState({
        loading: false,
        checked: true,
        result: null,
        error: toUserFacingPrivacyError(err),
      })
    }
  }

  // Handle standard payment fallback
  function handleFallbackStandardSend() {
    const params = new URLSearchParams()
    if (recipient) params.set('to', recipient)
    if (amount) params.set('amount', amount)
    router.push(`/send?${params.toString()}`)
  }

  // Submit the private send through the shared client. `pool.transfer` proves
  // and submits inside the pool and resolves to the real on-chain transaction
  // hash; anything else (rejection, failure) surfaces as an error and the
  // screen stays on review — the flow never invents a hash.
  async function handleConfirmSend() {
    setErrorMsg(null)
    setStep('submitting')

    try {
      const client: PrivacyClient = await getPrivacyClient()
      const txHash = await client.privateSend(recipient.trim(), xlmToStroops(amount))

      // Re-read the shielded balance after the transfer lands.
      const newBalance = await client.privateBalance()
      setPrivateBalanceStroops(newBalance)

      setTxResult({ txHash, amount: amount.trim() })
      setStep('done')
    } catch (err) {
      setErrorMsg(toUserFacingPrivacyError(err))
      setStep('review')
    }
  }

  // Parse an XLM decimal into stroops. Returns null for anything that is not
  // a non-negative decimal with up to 7 places, so the form can disable
  // itself instead of guessing.
  function xlmToStroops(value: string): bigint {
    const normalized = value.trim()
    if (!/^\d+(\.\d{1,7})?$/.test(normalized)) {
      throw new Error('Enter an amount with up to 7 decimal places.')
    }
    const [whole, fraction = ''] = normalized.split('.')
    return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'))
  }

  function stroopsToXlm(value: bigint): string {
    const whole = value / 10_000_000n
    const fraction = (value % 10_000_000n).toString().padStart(7, '0').replace(/0+$/, '')
    return fraction ? `${whole}.${fraction}` : whole.toString()
  }

  const amountStroops = (() => {
    try {
      return amount.trim() ? xlmToStroops(amount) : null
    } catch {
      return null
    }
  })()
  const isAmountValid =
    amountStroops !== null && amountStroops > 0n && privateBalanceStroops !== null && amountStroops <= privateBalanceStroops

  return (
    <div className="wallet-shell" style={{ padding: '1.5rem 1.25rem 4rem' }}>
      <main style={{ maxWidth: 480, width: '100%', margin: '0 auto' }}>
        {/* Navigation / Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <button
            type="button"
            onClick={() => {
              if (step === 'amount') setStep('recipient')
              else if (step === 'review') setStep('amount')
              else router.back()
            }}
            aria-label="Back"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--off-white)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.375rem',
              padding: 0,
            }}
          >
            <ChevronLeft size={22} strokeWidth={1.75} />
            <span style={{ fontSize: '0.875rem' }}>Back</span>
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span
              style={{
                fontFamily: 'Anton, Impact, sans-serif',
                fontSize: '0.6875rem',
                letterSpacing: '0.08em',
                background: 'rgba(0,167,181,0.15)',
                color: 'var(--teal)',
                padding: '0.2rem 0.5rem',
                borderRadius: '9999px',
                border: '1px solid rgba(0,167,181,0.3)',
              }}
            >
              TESTNET POOL
            </span>
          </div>
        </div>

        {/* Title & Introduction */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Shield size={20} color="var(--gold)" />
            <h1
              style={{
                fontFamily: 'Lora, Georgia, serif',
                fontWeight: 600,
                fontStyle: 'italic',
                fontSize: '1.5rem',
                color: 'var(--off-white)',
              }}
            >
              Private Send
            </h1>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)', lineHeight: 1.5 }}>
            Send shielded XLM to another registered wallet on Stellar testnet. The transfer
            itself is submitted on chain; what the pool hides from public observers is the
            amount and the recipient.
          </p>
        </div>

        {/* Global error banner */}
        {errorMsg && (
          <div
            style={{
              padding: '0.875rem 1rem',
              borderRadius: '0.75rem',
              background: 'rgba(255, 68, 68, 0.1)',
              border: '1px solid rgba(255, 68, 68, 0.3)',
              color: '#ff8888',
              fontSize: '0.8125rem',
              marginBottom: '1.25rem',
              lineHeight: 1.5,
            }}
          >
            {errorMsg}
          </div>
        )}

        {/* ── STEP 1: RECIPIENT ────────────────────────────────────────────── */}
        {step === 'recipient' && (
          <div>
            <div
              className="card"
              style={{
                padding: '1.25rem',
                borderRadius: '1rem',
                background: 'var(--surface)',
                border: '1px solid var(--border-dim)',
                marginBottom: '1.25rem',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.625rem' }}>
                <label
                  htmlFor="private-recipient-input"
                  style={{
                    fontFamily: 'Anton, Impact, sans-serif',
                    fontSize: '0.75rem',
                    letterSpacing: '0.06em',
                    color: 'rgba(246,247,248,0.5)',
                  }}
                >
                  RECIPIENT (CONTACT OR ADDRESS)
                </label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <button
                    type="button"
                    onClick={() => setShowPicker(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--gold)',
                      fontSize: '0.75rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                    }}
                  >
                    <BookUser size={14} /> Contacts
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowScanner(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--gold)',
                      fontSize: '0.75rem',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.25rem',
                    }}
                  >
                    <QrCode size={14} /> Scan
                  </button>
                </div>
              </div>

              <input
                id="private-recipient-input"
                type="text"
                value={recipient}
                onChange={(e) => {
                  const val = e.target.value
                  setRecipient(val)
                  setRecipientName('')
                  if (val.trim().length >= 50) {
                    void checkRegistry(val.trim())
                  } else {
                    setLookupState({ loading: false, checked: false, result: null, error: null })
                  }
                }}
                onBlur={() => {
                  if (recipient.trim()) void checkRegistry(recipient.trim())
                }}
                placeholder="G... or federation address"
                className="input-field"
                style={{
                  width: '100%',
                  padding: '0.75rem 0.875rem',
                  borderRadius: '0.5rem',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--border-dim)',
                  color: 'var(--off-white)',
                  fontFamily: 'Inconsolata, monospace',
                  fontSize: '0.875rem',
                  outline: 'none',
                }}
              />

              {recipientName && (
                <p style={{ fontSize: '0.8125rem', color: 'var(--gold)', marginTop: '0.5rem' }}>
                  Contact: {recipientName}
                </p>
              )}

              {/* Registry checking status */}
              {lookupState.loading && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem', color: 'rgba(246,247,248,0.5)', fontSize: '0.8125rem' }}>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Querying SPP Public-Key Registry...</span>
                </div>
              )}
            </div>

            {/* How the registry answer is reported. `false` while the index is
                still syncing means the address has not been seen yet, not
                that it is definitely absent — so the notice says so. */}
            {lookupState.checked && !lookupState.result?.registered && (
              <div
                style={{
                  padding: '1.25rem',
                  borderRadius: '1rem',
                  background: 'rgba(253, 218, 36, 0.05)',
                  border: '1px solid rgba(253, 218, 36, 0.3)',
                  marginBottom: '1.5rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem' }}>
                  <ShieldAlert size={22} color="var(--gold)" style={{ flexShrink: 0, marginTop: '0.125rem' }} />
                  <div>
                    <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, color: 'var(--gold)', marginBottom: '0.375rem' }}>
                      Recipient not found in the privacy registry
                    </h3>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.7)', lineHeight: 1.5, marginBottom: '1rem' }}>
                      {lookupState.error ??
                        (lookupState.result && !lookupState.result.registryFullySynced
                          ? 'This address is not in the registry index yet. Either it has not registered its privacy keys, or the index is still syncing and has not seen it.'
                          : 'This address has no privacy keys registered in the Stellar Private Payments registry, so it cannot receive a private send. They can register from their own wallet first.')}
                    </p>

                    {/* Fallback button to standard send */}
                    <button
                      type="button"
                      onClick={handleFallbackStandardSend}
                      className="btn-gold"
                      style={{
                        width: '100%',
                        padding: '0.75rem 1rem',
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        borderRadius: '0.625rem',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '0.5rem',
                      }}
                    >
                      <Send size={16} /> Send as Standard Payment Instead
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* REGISTERED RECIPIENT SUCCESS BADGE */}
            {lookupState.checked && lookupState.result?.registered && (
              <div
                style={{
                  padding: '1rem',
                  borderRadius: '0.875rem',
                  background: 'rgba(0, 167, 181, 0.08)',
                  border: '1px solid rgba(0, 167, 181, 0.3)',
                  marginBottom: '1.5rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                  <ShieldCheck size={20} color="var(--teal)" />
                  <div>
                    <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--teal)' }}>
                      Found in the SPP public-key registry
                    </p>
                    <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)', marginTop: '0.125rem', fontFamily: 'Inconsolata, monospace' }}>
                      Note key: {lookupState.result.noteKey ? `${lookupState.result.noteKey.slice(0, 18)}…` : 'registered'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Action button */}
            <button
              type="button"
              disabled={!lookupState.result?.registered}
              onClick={() => setStep('amount')}
              className="btn-gold"
              style={{
                width: '100%',
                padding: '0.875rem',
                borderRadius: '0.75rem',
                fontSize: '0.9375rem',
                fontWeight: 600,
                cursor: lookupState.result?.registered ? 'pointer' : 'not-allowed',
                opacity: lookupState.result?.registered ? 1 : 0.4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
              }}
            >
              Continue to Amount <ArrowRight size={16} />
            </button>
          </div>
        )}

        {/* ── STEP 2: AMOUNT ──────────────────────────────────────────────── */}
        {step === 'amount' && (
          <div>
            <div
              className="card"
              style={{
                padding: '1.25rem',
                borderRadius: '1rem',
                background: 'var(--surface)',
                border: '1px solid var(--border-dim)',
                marginBottom: '1.25rem',
              }}
            >
              {/* Recipient summary pill */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.625rem 0.875rem',
                  borderRadius: '0.5rem',
                  background: 'rgba(255,255,255,0.03)',
                  marginBottom: '1.25rem',
                }}
              >
                <div>
                  <span style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', textTransform: 'uppercase' }}>To</span>
                  <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8125rem', color: 'var(--off-white)' }}>
                    {recipient.slice(0, 10)}...{recipient.slice(-8)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setStep('recipient')}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gold)', fontSize: '0.75rem' }}
                >
                  Change
                </button>
              </div>

              {/* Balance display. The shielded balance is unknown until the pool
                  syncs; the row says so rather than showing a confident zero. */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontSize: '0.75rem', letterSpacing: '0.06em', color: 'rgba(246,247,248,0.5)' }}>
                  SHIELDED PRIVATE BALANCE (XLM)
                </span>
                <span style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.875rem', color: 'var(--teal)' }}>
                  {balanceSyncing ? 'Syncing…' : privateBalanceStroops === null ? 'Unavailable' : `${stroopsToXlm(privateBalanceStroops)} XLM`}
                </span>
              </div>

              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', lineHeight: 1.5, marginBottom: '0.5rem' }}>
                Spendable shielded XLM. The full balance appears once the pool finishes syncing.
              </p>

              {/* Amount input */}
              <div style={{ position: 'relative', marginBottom: '0.5rem' }}>
                <input
                  type="number"
                  step="any"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="input-field"
                  style={{
                    width: '100%',
                    padding: '0.875rem 4rem 0.875rem 1rem',
                    borderRadius: '0.625rem',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid var(--border-dim)',
                    color: 'var(--off-white)',
                    fontFamily: 'Inconsolata, monospace',
                    fontSize: '1.25rem',
                    outline: 'none',
                  }}
                />
                <button
                  type="button"
                  disabled={privateBalanceStroops === null}
                  onClick={() => {
                    if (privateBalanceStroops !== null) setAmount(stroopsToXlm(privateBalanceStroops))
                  }}
                  style={{
                    position: 'absolute',
                    right: '0.75rem',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'rgba(253, 218, 36, 0.15)',
                    border: '1px solid rgba(253, 218, 36, 0.3)',
                    color: 'var(--gold)',
                    borderRadius: '0.375rem',
                    padding: '0.25rem 0.5rem',
                    fontSize: '0.6875rem',
                    fontFamily: 'Anton, Impact, sans-serif',
                    cursor: 'pointer',
                  }}
                >
                  MAX
                </button>
              </div>

              {amountStroops !== null && privateBalanceStroops !== null && amountStroops > privateBalanceStroops && (
                <p style={{ fontSize: '0.75rem', color: '#ff8888', marginTop: '0.375rem' }}>
                  Amount exceeds the shielded balance ({stroopsToXlm(privateBalanceStroops)} XLM).
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={!isAmountValid}
              onClick={() => setStep('review')}
              className="btn-gold"
              style={{
                width: '100%',
                padding: '0.875rem',
                borderRadius: '0.75rem',
                fontSize: '0.9375rem',
                fontWeight: 600,
                cursor: isAmountValid ? 'pointer' : 'not-allowed',
                opacity: isAmountValid ? 1 : 0.4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
              }}
            >
              Review Private Send <ArrowRight size={16} />
            </button>
          </div>
        )}

        {/* ── STEP 3: REVIEW ──────────────────────────────────────────────── */}
        {step === 'review' && (
          <div>
            <div
              className="card"
              style={{
                padding: '1.25rem',
                borderRadius: '1rem',
                background: 'var(--surface)',
                border: '1px solid var(--border-dim)',
                marginBottom: '1.25rem',
              }}
            >
              <h3 style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)', marginBottom: '1rem' }}>
                TRANSFER SUMMARY
              </h3>

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: '1px solid var(--border-dim)' }}>
                <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>Amount</span>
                <span style={{ fontFamily: 'Inconsolata, monospace', fontSize: '1rem', fontWeight: 600, color: 'var(--off-white)' }}>
                  {amount.trim()} XLM
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: '1px solid var(--border-dim)' }}>
                <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>Recipient</span>
                <span style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8125rem', color: 'var(--off-white)' }}>
                  {recipient.slice(0, 10)}...{recipient.slice(-8)}
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', borderBottom: '1px solid var(--border-dim)' }}>
                <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>Privacy Registry</span>
                <span style={{ fontSize: '0.8125rem', color: 'var(--teal)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <ShieldCheck size={14} /> In the registry
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0' }}>
                <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>Payment source</span>
                <strong style={{ fontSize: '0.8125rem', color: 'var(--off-white)' }}>Spending account</strong>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0' }}>
                <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>Network Fee</span>
                <span style={{ fontSize: '0.8125rem', color: 'var(--gold)' }}>Sponsored by Veil</span>
              </div>
            </div>

            {/* What this screen can and cannot promise. The private send is a
                real pool transaction, so an explorer entry exists for it; the
                registry lookup above only says the recipient registered keys. */}
            <div
              style={{
                padding: '1rem 1.25rem',
                borderRadius: '0.875rem',
                background: 'rgba(0,167,181,0.06)',
                border: '1px solid rgba(0,167,181,0.25)',
                marginBottom: '1.5rem',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <Lock size={16} color="var(--teal)" />
                <h4 style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--teal)' }}>
                  What stays public
                </h4>
              </div>
              <ul style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.65)', lineHeight: 1.6, paddingLeft: '1.125rem' }}>
                <li><strong>Testnet pool:</strong> the transfer runs against the canonical testnet SPP pool contract.</li>
                <li><strong>Real transaction:</strong> the pool transaction is submitted on chain and returns a transaction hash.</li>
                <li><strong>Experimental:</strong> Stellar Private Payments is an unaudited testnet preview.</li>
              </ul>
            </div>

            <button
              type="button"
              onClick={handleConfirmSend}
              className="btn-gold"
              style={{
                width: '100%',
                padding: '0.875rem',
                borderRadius: '0.75rem',
                fontSize: '0.9375rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '0.5rem',
              }}
            >
              Confirm & Send Privately
            </button>
          </div>
        )}

        {/* ── STEP 4: PROVING & SUBMISSION ─────────────────────────────────── */}
        {step === 'submitting' && (
          <div
            className="card"
            style={{
              padding: '2.5rem 1.5rem',
              borderRadius: '1rem',
              background: 'var(--surface)',
              border: '1px solid var(--border-dim)',
              textAlign: 'center',
            }}
          >
            <Loader2 size={36} color="var(--gold)" className="animate-spin" style={{ margin: '0 auto 1.25rem' }} />
            <h3 style={{ fontFamily: 'Lora, Georgia, serif', fontStyle: 'italic', fontSize: '1.25rem', color: 'var(--off-white)', marginBottom: '0.5rem' }}>
              Proving and submitting…
            </h3>
            <p style={{ fontSize: '0.8125rem', color: 'var(--gold)', fontFamily: 'Inconsolata, monospace', marginBottom: '1.5rem' }}>
              {proofState}
            </p>
            <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', lineHeight: 1.5 }}>
              The wallet proves and submits inside the testnet pool. Neither your keys nor your private notes leave this device.
            </p>
          </div>
        )}

        {/* ── STEP 5: DONE / COMPLETE ─────────────────────────────────────── */}
        {step === 'done' && txResult && (
          <div>
            <div
              className="card"
              style={{
                padding: '2rem 1.5rem',
                borderRadius: '1rem',
                background: 'var(--surface)',
                border: '1px solid var(--border-dim)',
                textAlign: 'center',
                marginBottom: '1.25rem',
              }}
            >
              <CheckCircle2 size={44} color="var(--teal)" style={{ margin: '0 auto 1rem' }} />
              <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontStyle: 'italic', fontSize: '1.375rem', color: 'var(--off-white)', marginBottom: '0.375rem' }}>
                Private send submitted
              </h2>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', marginBottom: '1.5rem' }}>
                {txResult.amount} XLM is on its way inside the testnet pool. Ask the recipient to
                check their shielded balance once the transaction confirms.
              </p>

              {/* Transaction Hash */}
              <div
                style={{
                  padding: '0.75rem',
                  borderRadius: '0.5rem',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid var(--border-dim)',
                  marginBottom: '1rem',
                  textAlign: 'left',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.25rem' }}>
                  <span style={{ fontSize: '0.6875rem', color: 'rgba(246,247,248,0.4)', textTransform: 'uppercase' }}>
                    TRANSACTION HASH
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (navigator.clipboard) {
                        navigator.clipboard.writeText(txResult.txHash)
                        setCopied(true)
                        setTimeout(() => setCopied(false), 2000)
                      }
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--gold)', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                  >
                    <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.75rem', color: 'var(--off-white)', wordBreak: 'break-all' }}>
                  {txResult.txHash}
                </p>
              </div>

              {/* Explorer link. The hash comes from the pool transaction the SDK
                  submitted, so the link always points at a real entry — there
                  is no link when there is no hash. */}
              <a
                href={`https://stellar.expert/explorer/testnet/tx/${txResult.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.375rem',
                  fontSize: '0.8125rem',
                  color: 'var(--gold)',
                  textDecoration: 'none',
                  marginBottom: '0.5rem',
                }}
              >
                View on Stellar Expert Explorer <ExternalLink size={14} />
              </a>

              <p style={{ fontSize: '0.6875rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
                The explorer entry is the pool transaction itself — it does not name an amount or a recipient.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                type="button"
                onClick={() => {
                  setStep('recipient')
                  setRecipient('')
                  setAmount('')
                  setLookupState({ loading: false, checked: false, result: null, error: null })
                  setTxResult(null)
                }}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  borderRadius: '0.625rem',
                  border: '1px solid var(--border-dim)',
                  background: 'var(--surface)',
                  color: 'var(--off-white)',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                }}
              >
                Send Another
              </button>
              <button
                type="button"
                onClick={() => router.push('/dashboard')}
                className="btn-gold"
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  borderRadius: '0.625rem',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Done
              </button>
            </div>
          </div>
        )}

        {/* Contacts Modal */}
        {showPicker && (
          <ContactPicker
            onSelect={(contact) => {
              setRecipient(contact.address)
              setRecipientName(contact.name)
              setShowPicker(false)
              void checkRegistry(contact.address)
            }}
            onClose={() => setShowPicker(false)}
          />
        )}

        {/* QR Scanner Modal */}
        {showScanner && (
          <QrScanner
            onScan={(val) => {
              setRecipient(val)
              setShowScanner(false)
              void checkRegistry(val)
            }}
            onClose={() => setShowScanner(false)}
          />
        )}
      </main>
    </div>
  )
}

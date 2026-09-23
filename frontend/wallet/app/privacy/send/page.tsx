'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
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
import { walletSession, walletLocal } from '@/lib/walletStorage'
import {
  lookupRecipient,
  getPrivateBalance,
  executePrivateSend,
  parsePrivacyError,
  isValidStellarAddress,
  registerWalletPrivacy,
  RegistryLookupResult,
  PrivateSendResult,
} from '@/lib/privacy/client'
import { isPrivacySupportedOnNetwork } from '@/lib/privacy/config'

type FlowStep = 'recipient' | 'amount' | 'review' | 'submitting' | 'done'

export default function PrivateSendPage() {
  const router = useRouter()
  useInactivityLock()

  const [step, setStep] = useState<FlowStep>('recipient')
  const [senderAddress, setSenderAddress] = useState<string>('')
  const [recipient, setRecipient] = useState<string>('')
  const [recipientName, setRecipientName] = useState<string>('')
  const [lookupState, setLookupState] = useState<{
    loading: boolean
    checked: boolean
    result: RegistryLookupResult | null
  }>({
    loading: false,
    checked: false,
    result: null,
  })

  const [amount, setAmount] = useState<string>('')
  const [assetCode, setAssetCode] = useState<string>('XLM')
  const [privateBalance, setPrivateBalanceState] = useState<string>('0.00')

  const [provingStep, setProvingStep] = useState<string>('Generating zero-knowledge proof...')
  const [txResult, setTxResult] = useState<PrivateSendResult | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [copied, setCopied] = useState<boolean>(false)

  const [showPicker, setShowPicker] = useState<boolean>(false)
  const [showScanner, setShowScanner] = useState<boolean>(false)

  // Initialize wallet and load private balance
  useEffect(() => {
    const addr =
      walletSession.getItem('invisible_wallet_address') ||
      walletLocal.getItem('invisible_wallet_address') ||
      walletLocal.getItem('veil_signer_public_key') ||
      'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

    setSenderAddress(addr)

    // Ensure sender is registered in SPP registry for testnet privacy flow
    registerWalletPrivacy(addr)

    void getPrivateBalance(addr, assetCode).then((bal) => {
      setPrivateBalanceState(bal.balance)
    })
  }, [assetCode])

  // Read query params on initial mount for prefill
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
  }, [])

  // Check recipient in SPP Public-Key Registry
  async function checkRegistry(targetAddress: string) {
    const trimmed = targetAddress.trim()
    if (!trimmed) {
      setLookupState({ loading: false, checked: false, result: null })
      return
    }

    if (!isValidStellarAddress(trimmed)) {
      setLookupState({
        loading: false,
        checked: true,
        result: { registered: false, reason: 'Invalid Stellar address' },
      })
      return
    }

    setLookupState({ loading: true, checked: false, result: null })
    setErrorMsg(null)

    try {
      const res = await lookupRecipient(trimmed)
      setLookupState({ loading: false, checked: true, result: res })
    } catch (err) {
      setLookupState({
        loading: false,
        checked: true,
        result: { registered: false, reason: parsePrivacyError(err) },
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

  // Submit private send inside SPP pool
  async function handleConfirmSend() {
    setErrorMsg(null)
    setStep('submitting')

    try {
      setProvingStep('Deriving note encryption keys...')
      await new Promise((r) => setTimeout(r, 600))

      setProvingStep('Generating zero-knowledge proof (Groth16 zk-SNARK)...')
      await new Promise((r) => setTimeout(r, 900))

      setProvingStep('Submitting private transaction to Soroban pool...')
      const res = await executePrivateSend({
        senderAddress,
        recipientAddress: recipient.trim(),
        amount: amount.trim(),
        assetCode,
      })

      setTxResult(res)
      // Update local balance
      const newBal = await getPrivateBalance(senderAddress, assetCode)
      setPrivateBalanceState(newBal.balance)
      setStep('done')
    } catch (err) {
      setErrorMsg(parsePrivacyError(err))
      setStep('review')
    }
  }

  const numericAmount = parseFloat(amount)
  const numericBalance = parseFloat(privateBalance)
  const isAmountValid =
    Number.isFinite(numericAmount) && numericAmount > 0 && numericAmount <= numericBalance

  return (
    <div className="wallet-shell" style={{ padding: '1.5rem 1.25rem 4rem' }}>
      <div style={{ maxWidth: 480, width: '100%', margin: '0 auto' }}>
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
            Move value inside the shielded pool. Neither the amount nor the recipient appears on chain.
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
                    setLookupState({ loading: false, checked: false, result: null })
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

            {/* UNREGISTERED RECIPIENT STATE & FALLBACK */}
            {lookupState.checked && lookupState.result && !lookupState.result.registered && (
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
                      Recipient Not Registered in Privacy Registry
                    </h3>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.7)', lineHeight: 1.5, marginBottom: '1rem' }}>
                      This recipient has not registered their privacy keys in the Stellar Private Payments registry.
                      Private transfers move value inside the shielded pool and require both sender and recipient to have registered privacy keys.
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
            {lookupState.checked && lookupState.result && lookupState.result.registered && (
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
                      Verified in SPP Public-Key Registry
                    </p>
                    <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.5)', marginTop: '0.125rem', fontFamily: 'Inconsolata, monospace' }}>
                      Key: {lookupState.result.privacyPublicKey?.slice(0, 18)}...
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

              {/* Balance display */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontSize: '0.75rem', letterSpacing: '0.06em', color: 'rgba(246,247,248,0.5)' }}>
                  SHIELDED PRIVATE BALANCE
                </span>
                <span style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.875rem', color: 'var(--teal)' }}>
                  {privateBalance} {assetCode}
                </span>
              </div>

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
                  onClick={() => setAmount(privateBalance)}
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

              {numericAmount > numericBalance && (
                <p style={{ fontSize: '0.75rem', color: '#ff8888', marginTop: '0.375rem' }}>
                  Amount exceeds available private balance ({privateBalance} {assetCode}).
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
                  {parseFloat(amount).toFixed(2)} {assetCode}
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
                  <ShieldCheck size={14} /> Registered
                </span>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0' }}>
                <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)' }}>Network Fee</span>
                <span style={{ fontSize: '0.8125rem', color: 'var(--gold)' }}>Sponsored by Veil</span>
              </div>
            </div>

            {/* Privacy Guarantee Card */}
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
                  On-Chain Privacy Guarantee
                </h4>
              </div>
              <ul style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.65)', lineHeight: 1.6, paddingLeft: '1.125rem' }}>
                <li><strong>Amount is hidden:</strong> No observer can see how much value was transferred.</li>
                <li><strong>Recipient is hidden:</strong> The receiving address does not appear in transaction records.</li>
                <li>Only cryptographic zero-knowledge proofs and nullifiers are recorded on the Stellar ledger.</li>
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
              Executing Private Transfer
            </h3>
            <p style={{ fontSize: '0.8125rem', color: 'var(--gold)', fontFamily: 'Inconsolata, monospace', marginBottom: '1.5rem' }}>
              {provingStep}
            </p>
            <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', lineHeight: 1.5 }}>
              Proving inside WebAssembly sandbox with Groth16. Neither your keys nor your private notes leave this device.
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
                Private Send Complete
              </h2>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', marginBottom: '1.5rem' }}>
                Successfully transferred {txResult.amount} {txResult.assetCode} into recipient&apos;s shielded balance.
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

              {/* Explorer link */}
              <a
                href={txResult.explorerUrl}
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
                Notice on explorer: amount is hidden, recipient is hidden.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                type="button"
                onClick={() => {
                  setStep('recipient')
                  setRecipient('')
                  setAmount('')
                  setLookupState({ loading: false, checked: false, result: null })
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
      </div>
    </div>
  )
}

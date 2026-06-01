'use client'

/**
 * SEP-24 fiat off-ramp.
 *
 * Flow:
 *   1. User picks asset (XLM / USDC) and amount, chooses anchor.
 *   2. SEP-10 JWT exchange via passkey.
 *   3. initiateWithdraw → embed interactive URL in iframe for KYC + bank details.
 *   4. Poll anchor /transaction until status === 'pending_user_transfer_start'
 *      AND withdraw_anchor_account + withdraw_memo are present.
 *   5. Passkey gate → build classic Stellar payment with the anchor-supplied
 *      memo (critical for routing). Submit via Horizon.
 *   6. Continue polling until status === 'completed' (or terminal).
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Keypair, TransactionBuilder, BASE_FEE, Asset, Operation, Memo, Horizon,
} from '@stellar/stellar-sdk'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import {
  discoverAnchorInfo,
  getSep10Jwt,
  initiateWithdraw,
  getTransactionStatus,
  isSep24Complete,
  type Sep24TransactionStatus,
} from '@/lib/sep24'
import { getNetwork } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'

const Server = Horizon.Server
const network = getNetwork()

const DEFAULT_ANCHOR =
  process.env.NEXT_PUBLIC_SEP24_ANCHORS?.split(',')[0]?.trim()
  || 'testanchor.stellar.org'

const XLM_FEE_RESERVE = 1 // keep at least 1 XLM after withdrawal for base reserve + fees

type Step =
  | 'form'
  | 'auth'
  | 'iframe'
  | 'awaiting-pay'   // anchor wants payment, waiting for user confirmation
  | 'paying'         // passkey + Horizon submit in progress
  | 'polling'        // payment sent, polling anchor until completed
  | 'done'
  | 'error'

interface WalletAsset {
  code: string
  issuer: string | null
  balance: string
}

export default function WithdrawPage() {
  const router = useRouter()
  useInactivityLock()

  const [step, setStep]             = useState<Step>('form')
  const [feePayerAddress, setFeePayer] = useState<string | null>(null)

  const [anchor, setAnchor]         = useState(DEFAULT_ANCHOR)
  const [assets, setAssets]         = useState<WalletAsset[]>([])
  const [selectedAsset, setSelected] = useState<WalletAsset | null>(null)
  const [amount, setAmount]         = useState('')

  const [iframeUrl, setIframeUrl]   = useState<string | null>(null)
  const [txnId, setTxnId]           = useState<string | null>(null)
  const [txnStatus, setTxnStatus]   = useState<Sep24TransactionStatus | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [paymentHash, setPaymentHash] = useState<string | null>(null)

  const transferServerRef = useRef<string | null>(null)
  const jwtRef            = useRef<string | null>(null)
  const pollRef           = useRef<ReturnType<typeof setInterval> | null>(null)
  const paymentSentRef    = useRef(false)

  // ── Boot: derive fee-payer + load balances ────────────────────────────────

  useEffect(() => {
    const addr = sessionStorage.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }

    const secret = sessionStorage.getItem('veil_signer_secret')
      || localStorage.getItem('veil_signer_secret')
    let publicKey: string | null = null
    if (secret) {
      try { publicKey = Keypair.fromSecret(secret).publicKey() } catch { /* skip */ }
    }
    if (!publicKey) publicKey = localStorage.getItem('veil_signer_public_key')
    if (!publicKey || !publicKey.startsWith('G')) {
      setError('Spending wallet not set up yet. Tap "Fund wallet" on the dashboard first.')
      setStep('error')
      return
    }
    setFeePayer(publicKey)

    const server = new Server(network.horizonUrl)
    server.loadAccount(publicKey).then(account => {
      const list: WalletAsset[] = account.balances
        .map(b => {
          if (b.asset_type === 'native') {
            return { code: 'XLM', issuer: null, balance: b.balance }
          }
          const issued = b as { asset_code: string; asset_issuer: string; balance: string }
          return { code: issued.asset_code, issuer: issued.asset_issuer, balance: issued.balance }
        })
      setAssets(list)
      // Prefer USDC if present, otherwise first asset
      const usdc = list.find(a => a.code === 'USDC')
      setSelected(usdc ?? list[0] ?? null)
    }).catch(() => {
      setAssets([{ code: 'XLM', issuer: null, balance: '0' }])
      setSelected({ code: 'XLM', issuer: null, balance: '0' })
    })
  }, [router])

  // ── Polling ───────────────────────────────────────────────────────────────

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  useEffect(() => () => stopPolling(), [stopPolling])

  const startPolling = useCallback((id: string) => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const tx = await getTransactionStatus(
          transferServerRef.current!,
          id,
          jwtRef.current ?? undefined,
        )
        setTxnStatus(tx)

        if (isSep24Complete(tx.status)) {
          stopPolling()
          if (tx.status === 'completed') setStep('done')
          else {
            setError(tx.message ?? `Anchor returned status "${tx.status}".`)
            setStep('error')
          }
          return
        }

        // Anchor is ready for the on-chain payment. Move out of iframe step
        // and surface the passkey gate.
        if (
          !paymentSentRef.current
          && tx.status === 'pending_user_transfer_start'
          && tx.withdraw_anchor_account
          && tx.withdraw_memo
        ) {
          setStep(prev => (prev === 'iframe' ? 'awaiting-pay' : prev))
        }
      } catch { /* network hiccup — keep polling */ }
    }, 4_000)
  }, [stopPolling])

  // ── Anchor handshake ──────────────────────────────────────────────────────

  const startWithdraw = async () => {
    if (!feePayerAddress) {
      setError('Spending wallet not set up yet.'); setStep('error'); return
    }
    if (!selectedAsset) {
      setError('Select an asset to withdraw.'); return
    }
    const n = parseFloat(amount)
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a valid amount greater than zero.'); return
    }
    if (selectedAsset.code === 'XLM') {
      const balance = parseFloat(selectedAsset.balance || '0')
      if (n > balance - XLM_FEE_RESERVE) {
        setError(`Withdrawing ${n} XLM would leave less than ${XLM_FEE_RESERVE} XLM for the base reserve.`)
        return
      }
    } else {
      const balance = parseFloat(selectedAsset.balance || '0')
      if (n > balance) {
        setError(`Insufficient ${selectedAsset.code} balance.`); return
      }
    }

    setError(null)
    setStep('auth')
    try {
      const info = await discoverAnchorInfo(anchor.trim())
      transferServerRef.current = info.transferServerUrl

      const jwt = await getSep10Jwt(info.webAuthEndpoint, feePayerAddress, info.networkPassphrase)
      jwtRef.current = jwt

      const result = await initiateWithdraw(
        info.transferServerUrl,
        { assetCode: selectedAsset.code, account: feePayerAddress, amount: String(n) },
        jwt,
      )
      setTxnId(result.id)
      setIframeUrl(result.url)
      setStep('iframe')
      startPolling(result.id)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        msg.includes('NotAllowedError') || msg.includes('cancelled')
          ? 'Passkey verification was cancelled. Please try again.'
          : msg,
      )
      setStep('error')
    }
  }

  // ── On-chain payment with memo ────────────────────────────────────────────

  const sendPayment = async () => {
    if (!txnStatus?.withdraw_anchor_account || !txnStatus.withdraw_memo) {
      setError('Anchor did not return a memo. Refusing to send — the payment would be lost.')
      setStep('error')
      return
    }
    if (!selectedAsset) { setError('No asset selected.'); setStep('error'); return }

    const signerSecret = sessionStorage.getItem('veil_signer_secret')
      || localStorage.getItem('veil_signer_secret')
    if (!signerSecret) {
      setError('Signing key not found. Return to dashboard and tap "Fund wallet" to set up a fee-payer.')
      setStep('error')
      return
    }

    // Prefer the anchor's quoted amount_in over the user's entered amount —
    // it includes anchor fees and matches the memo'd transaction.
    const payAmount = txnStatus.amount_in || amount
    if (!payAmount || parseFloat(payAmount) <= 0) {
      setError('Anchor has not quoted a payment amount yet.')
      return
    }

    // The form validated the user-entered amount, but the anchor may quote a
    // larger amount_in (e.g. to cover its fees). Re-check against the balance
    // snapshot before the passkey gate so we don't fail at Horizon — or, for
    // XLM, dip into the base reserve — after the user has already approved.
    const bal = parseFloat(selectedAsset.balance || '0')
    const headroom = selectedAsset.code === 'XLM' ? bal - XLM_FEE_RESERVE : bal
    if (parseFloat(payAmount) > headroom) {
      setError(
        `Anchor quoted ${payAmount} ${selectedAsset.code}, more than your available `
        + `balance${selectedAsset.code === 'XLM' ? ` (keeping ${XLM_FEE_RESERVE} XLM in reserve)` : ''}.`,
      )
      setStep('error')
      return
    }

    beginTx()
    setStep('paying')
    setError(null)
    try {
      const feePayerKp = Keypair.fromSecret(signerSecret)

      // Passkey gate before signing/submitting.
      const keyId = localStorage.getItem('invisible_wallet_key_id')
      if (!keyId) throw new Error('No passkey found. Please register the wallet first.')
      if (keyId !== 'recovery') {
        const credIdBin = atob(keyId.replace(/-/g, '+').replace(/_/g, '/'))
        const credId    = Uint8Array.from(credIdBin, c => c.charCodeAt(0))
        const challenge = crypto.getRandomValues(new Uint8Array(32))
        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge,
            allowCredentials: [{ id: credId, type: 'public-key' }],
            userVerification: 'required',
          },
        })
        if (!assertion) throw new Error('Passkey verification was cancelled.')
      }

      // Pick the right asset object. For non-native we derive the issuer from
      // the wallet's own trustlines so the amount sent matches the anchor's
      // expected asset issuer.
      let asset: Asset
      if (selectedAsset.code === 'XLM') {
        asset = Asset.native()
      } else {
        if (!selectedAsset.issuer) {
          throw new Error(`No trustline for ${selectedAsset.code} — cannot determine issuer.`)
        }
        asset = new Asset(selectedAsset.code, selectedAsset.issuer)
      }

      // Build memo from anchor's returned type/value.
      let memo: Memo
      const memoType = txnStatus.withdraw_memo_type ?? 'text'
      switch (memoType) {
        case 'id':   memo = Memo.id(txnStatus.withdraw_memo); break
        case 'hash': memo = Memo.hash(Buffer.from(txnStatus.withdraw_memo, 'base64')); break
        case 'text':
        default:     memo = Memo.text(txnStatus.withdraw_memo); break
      }

      const horizonServer = new Server(network.horizonUrl)
      const account = await horizonServer.loadAccount(feePayerKp.publicKey())

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })
        .addOperation(Operation.payment({
          destination: txnStatus.withdraw_anchor_account,
          asset,
          amount: payAmount,
        }))
        .addMemo(memo)
        .setTimeout(60)
        .build()

      tx.sign(feePayerKp)
      const result = await horizonServer.submitTransaction(tx)
      paymentSentRef.current = true
      setPaymentHash(result.hash)
      setStep('polling')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        msg.includes('NotAllowedError') || msg.includes('not allowed') || msg.includes('cancelled')
          ? 'Passkey verification was cancelled. Please try again.'
          : msg,
      )
      setStep('error')
    } finally {
      endTx()
    }
  }

  const cancelAndReset = () => {
    stopPolling()
    setStep('form')
    setIframeUrl(null)
    setTxnId(null)
    setTxnStatus(null)
    setPaymentHash(null)
    paymentSentRef.current = false
    transferServerRef.current = null
    jwtRef.current = null
    setError(null)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="wallet-shell">
      <header className="wallet-nav">
        <button
          onClick={() => { stopPolling(); router.back() }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontSize: '1.25rem', letterSpacing: '0.08em', color: 'var(--gold)', userSelect: 'none' }}>
          VEIL
        </span>
      </header>

      <main className="wallet-main" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>

        {step === 'form' && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
              <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem', color: 'var(--off-white)', marginBottom: '0.375rem' }}>
                Cash out
              </h1>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)' }}>
                Withdraw to a bank account or mobile money via a Stellar anchor.
              </p>
            </div>

            {error && (
              <p style={{ color: 'var(--teal)', fontSize: '0.8125rem', marginBottom: '1rem' }}>{error}</p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  ASSET
                </label>
                <select
                  value={selectedAsset ? `${selectedAsset.code}|${selectedAsset.issuer ?? ''}` : ''}
                  onChange={e => {
                    const [code, issuer] = e.target.value.split('|')
                    setSelected(assets.find(a => a.code === code && (a.issuer ?? '') === issuer) ?? null)
                  }}
                  className="input-field"
                  style={{ fontFamily: 'Inconsolata, monospace', color: 'var(--off-white)', background: 'var(--surface)' }}
                >
                  {assets.map(a => (
                    <option key={`${a.code}-${a.issuer ?? 'native'}`} value={`${a.code}|${a.issuer ?? ''}`}>
                      {a.code} — {parseFloat(a.balance).toFixed(4)} available
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  AMOUNT{selectedAsset ? ` (${selectedAsset.code})` : ''}
                </label>
                <input
                  className="input-field"
                  type="number"
                  placeholder="0.00"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  min="0"
                  step="0.0000001"
                  style={{ fontFamily: 'Inconsolata, monospace', fontSize: '1.25rem' }}
                />
              </div>

              <div>
                <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  ANCHOR
                </label>
                <input
                  className="input-field mono"
                  type="text"
                  placeholder="testanchor.stellar.org"
                  value={anchor}
                  onChange={e => setAnchor(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              <button
                className="btn-gold"
                onClick={startWithdraw}
                disabled={!feePayerAddress || !selectedAsset || !amount}
                style={{ marginTop: '0.5rem' }}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {step === 'auth' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: '4rem', gap: '1rem' }}>
            <div className="spinner spinner-light" style={{ width: '2.5rem', height: '2.5rem' }} />
            <p style={{ fontSize: '0.9375rem', color: 'rgba(246,247,248,0.55)' }}>
              Authenticating with {anchor}…
            </p>
          </div>
        )}

        {step === 'iframe' && iframeUrl && (
          <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 8rem)' }}>
            {txnStatus && (
              <div style={{ padding: '0.625rem 1rem', marginBottom: '0.75rem', background: 'rgba(246,247,248,0.06)', borderRadius: '8px', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', display: 'flex', justifyContent: 'space-between' }}>
                <span>Status: <strong style={{ color: 'var(--off-white)' }}>{txnStatus.status.replace(/_/g, ' ')}</strong></span>
                {txnStatus.amount_in && <span>{txnStatus.amount_in} {txnStatus.amount_in_asset ?? selectedAsset?.code}</span>}
              </div>
            )}
            <iframe
              src={iframeUrl}
              allow="payment; camera; microphone"
              style={{ flex: 1, border: 'none', borderRadius: '12px', background: '#ffffff', width: '100%' }}
              title={`${anchor} withdrawal`}
            />
            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
              <button
                onClick={cancelAndReset}
                style={{ flex: 1, padding: '0.75rem', borderRadius: '0.75rem', border: '1px solid var(--border-dim)', background: 'transparent', color: 'rgba(246,247,248,0.6)', fontSize: '0.875rem', cursor: 'pointer' }}
              >
                Cancel
              </button>
              {txnId && transferServerRef.current && (
                <a
                  href={`${transferServerRef.current}/transaction?id=${txnId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ flex: 1, padding: '0.75rem', borderRadius: '0.75rem', border: '1px solid var(--border-dim)', background: 'transparent', color: 'rgba(246,247,248,0.6)', fontSize: '0.875rem', cursor: 'pointer', textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  Check status
                </a>
              )}
            </div>
          </div>
        )}

        {step === 'awaiting-pay' && txnStatus && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.5rem', color: 'var(--off-white)', marginBottom: '0.5rem' }}>
                Send {txnStatus.amount_in ?? amount} {selectedAsset?.code}
              </h2>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.55)', lineHeight: 1.5 }}>
                {anchor} is ready for your payment. Approving with your passkey
                will broadcast a Stellar payment with the anchor&apos;s memo.
              </p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <Row label="To"      value={`${txnStatus.withdraw_anchor_account?.slice(0, 8)}…${txnStatus.withdraw_anchor_account?.slice(-8)}`} mono />
              <Row label="Memo"    value={`${txnStatus.withdraw_memo} (${txnStatus.withdraw_memo_type ?? 'text'})`} mono />
              <Row label="Amount"  value={`${txnStatus.amount_in ?? amount} ${selectedAsset?.code ?? ''}`} />
              <Row label="Network" value={network.displayName} />
              <Row label="Auth"    value="Passkey (WebAuthn)" />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
              <button className="btn-gold" onClick={sendPayment}>
                Approve &amp; send
              </button>
              <button
                onClick={cancelAndReset}
                style={{ padding: '0.75rem', borderRadius: '0.75rem', border: 'none', background: 'transparent', color: 'rgba(246,247,248,0.4)', fontSize: '0.875rem', cursor: 'pointer' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {step === 'paying' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
              <div className="spinner spinner-light" />
            </div>
            <p style={{ fontWeight: 500 }}>Waiting for passkey…</p>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
              Approve the prompt to authorise the withdrawal payment.
            </p>
          </div>
        )}

        {step === 'polling' && (
          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              <div className="spinner spinner-light" />
            </div>
            <div>
              <p style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.25rem' }}>
                Payment sent — waiting for anchor
              </p>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
                {txnStatus?.status?.replace(/_/g, ' ') ?? 'processing'} · this usually takes a couple of minutes.
              </p>
              {paymentHash && (
                <p style={{ fontSize: '0.6875rem', color: 'rgba(246,247,248,0.3)', fontFamily: 'Inconsolata, monospace', marginTop: '0.5rem', wordBreak: 'break-all' }}>
                  Stellar tx: {paymentHash.slice(0, 24)}…
                </p>
              )}
            </div>
          </div>
        )}

        {step === 'done' && (
          <div style={{ textAlign: 'center', paddingTop: '3rem' }}>
            <div style={{ width: '4rem', height: '4rem', borderRadius: '50%', background: 'rgba(253,218,36,0.12)', border: '1px solid rgba(253,218,36,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>
                <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.5rem', color: 'var(--off-white)', marginBottom: '0.75rem' }}>
              Withdrawal complete
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', marginBottom: '2rem', lineHeight: 1.5 }}>
              The anchor has confirmed your cash-out. Funds should arrive in your bank account shortly.
            </p>
            {txnStatus?.amount_out && (
              <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '1.25rem', color: 'var(--gold)', marginBottom: '2rem' }}>
                {txnStatus.amount_out} {txnStatus.amount_out_asset ?? ''}
              </p>
            )}
            <button className="btn-gold" onClick={() => router.push('/dashboard')}>
              Back to dashboard
            </button>
          </div>
        )}

        {step === 'error' && (
          <div style={{ textAlign: 'center', paddingTop: '3rem' }}>
            <div style={{ width: '4rem', height: '4rem', borderRadius: '50%', background: 'rgba(100,200,180,0.1)', border: '1px solid rgba(100,200,180,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--teal)' }}>
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.75"/>
                <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
              </svg>
            </div>
            <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.5rem', color: 'var(--off-white)', marginBottom: '0.75rem' }}>
              Something went wrong
            </h2>
            {error && (
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.5)', marginBottom: '2rem', lineHeight: 1.5 }}>
                {error}
              </p>
            )}
            <button className="btn-gold" onClick={cancelAndReset}>
              Try again
            </button>
          </div>
        )}

      </main>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
      <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: '0.875rem',
        fontFamily: mono ? 'Inconsolata, monospace' : 'Inter, sans-serif',
        textAlign: 'right',
        wordBreak: 'break-all',
      }}>
        {value}
      </span>
    </div>
  )
}

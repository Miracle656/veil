'use client'

import { PageHeader } from '@/components/ui/primitives'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { VeilMark } from '@/components/ui/VeilMark'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'
import { requirePasskey } from '@/lib/passkeyAuth'
import { isPasskeyCancellation } from '@/lib/passkeyOutcome'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import {
  fetchBackstopPosition,
  depositToBackstop,
  queueBackstopWithdrawal,
  cancelBackstopWithdrawal,
  withdrawFromBackstop,
  lpToStroops,
  type BackstopPosition,
} from '@/lib/backstop'

const network = getNetwork()

type Step = 'view' | 'deposit' | 'queue' | 'withdraw' | 'working' | 'done' | 'error'

export default function BackstopPage() {
  const router = useRouter()
  useInactivityLock()

  const [step, setStep] = useState<Step>('view')
  const [accountAddress, setAccountAddress] = useState<string | null>(null)
  const [position, setPosition] = useState<BackstopPosition | null>(null)
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const [queuedAmount, setQueuedAmount] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }
    const signerSecret = walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    const signerPublic = walletLocal.getItem('veil_signer_public_key')
    const resolved = signerSecret ? Keypair.fromSecret(signerSecret).publicKey() : signerPublic
    if (!resolved) { setErrorMsg('Signing key not found.'); setStep('error'); return }
    setAccountAddress(resolved)
    load(resolved)
  }, [router])

  async function load(addr: string) {
    setLoading(true)
    try {
      const pos = await fetchBackstopPosition({ userId: addr })
      setPosition(pos)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function run(fn: () => Promise<string>) {
    beginTx()
    setStep('working')
    setErrorMsg(null)
    try {
      await requirePasskey()
      const signerSecret = walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
      if (!signerSecret) throw new Error('Signing key not found.')
      const hash = await fn()
      setTxHash(hash)
      setStep('done')
      if (accountAddress) load(accountAddress)
    } catch (err: unknown) {
      if (isPasskeyCancellation(err)) { setStep('view'); return }
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setStep('error')
    } finally {
      endTx()
    }
  }

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button onClick={() => router.replace('/dashboard')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Dashboard
        </button>
        <VeilMark size={22} />
        <div style={{ width: 40 }} />
      </nav>

      <main className="wallet-main" style={{ maxWidth: 720, margin: '0 auto', padding: '1rem', width: '100%' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <PageHeader eyebrow="Backstop" title="Blend Backstop" />
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '2rem' }}><div className="spinner spinner-light" /></div>
        ) : (
          <>
            {/* Pre-first-deposit statement */}
            {!position || (Number(position.shares) === 0 && position.totalQueued === 0) ? (
              <div className="card" style={{ marginBottom: '1.5rem', padding: '1rem' }}>
                <p style={{ fontSize: '0.875rem', lineHeight: 1.6, color: 'rgba(246,247,248,0.7)' }}>
                  Your backstop position is first-loss capital for a Blend lending pool: you deposit
                  BLND:USDC liquidity-pool shares, and in exchange earn emissions plus a share of pool
                  interest. If the pool takes on bad debt, your deposit can be drawn on to cover it.
                  Nothing is deposited until you approve it with your passkey.
                </p>
              </div>
            ) : null}

            {position && (
              <div className="card" style={{ marginBottom: '1.5rem', padding: '1rem' }}>
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.75rem' }}>POSITION</p>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span>Shares (current value)</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace' }}>{position.shareValue.toFixed(6)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span>LP tokens</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace' }}>{position.tokens.toFixed(6)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span>BLND component</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace' }}>{position.blnd.toFixed(6)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span>USDC component</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace' }}>{position.usdc.toFixed(6)}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-dim)' }}>
                  <span>Emissions (separate)</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace', color: 'var(--teal)' }}>{position.emissions.toFixed(6)}</span>
                </div>
                {position.totalQueued > 0 && (
                  <div style={{ marginTop: '0.75rem', paddingTop: '0.75rem', borderTop: '1px solid var(--border-dim)' }}>
                    <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.5rem' }}>QUEUED WITHDRAWALS</p>
                    {position.queued.map((q, i) => (
                      <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                        <span>{q.amount.toFixed(6)} shares</span>
                        <span>expires {q.exp}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Actions */}
            {step === 'view' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <button className="btn-gold" onClick={() => setStep('deposit')}>Deposit</button>
                <button className="btn-secondary" onClick={() => setStep('queue')}>Queue withdrawal</button>
                {position && position.totalQueued > 0 && (
                  <>
                    <button className="btn-ghost" onClick={() => setStep('withdraw')}>Withdraw queued</button>
                  </>
                )}
              </div>
            )}

            {step === 'deposit' && (
              <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <input className="input-field" type="number" placeholder="LP amount" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <button className="btn-gold" onClick={() => run(() => depositToBackstop({ amountLp: amount, signerSecret: walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret') || undefined }))} disabled={!amount}>Deposit</button>
                <button className="btn-ghost" onClick={() => setStep('view')}>Cancel</button>
              </div>
            )}

            {step === 'queue' && (
              <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <input className="input-field" type="number" placeholder="Shares to queue" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <button className="btn-gold" onClick={() => run(() => queueBackstopWithdrawal({ amountShares: amount, signerSecret: walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret') || undefined }))} disabled={!amount}>Queue withdrawal</button>
                <button className="btn-ghost" onClick={() => setStep('view')}>Cancel</button>
              </div>
            )}

            {step === 'withdraw' && (
              <div className="card" style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <input className="input-field" type="number" placeholder="Queued shares to withdraw" value={queuedAmount} onChange={(e) => setQueuedAmount(e.target.value)} />
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                  <button className="btn-gold" style={{ flex: 1 }} onClick={() => run(() => withdrawFromBackstop({ amountShares: queuedAmount, signerSecret: walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret') || undefined }))} disabled={!queuedAmount}>Withdraw</button>
                  <button className="btn-ghost" style={{ flex: 1 }} onClick={() => run(() => cancelBackstopWithdrawal({ amountShares: queuedAmount, signerSecret: walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret') || undefined }))}>Cancel queued</button>
                </div>
                <button className="btn-ghost" onClick={() => setStep('view')}>Back</button>
              </div>
            )}

            {step === 'working' && (
              <div className="card" style={{ textAlign: 'center' }}>
                <div className="spinner spinner-light" style={{ margin: '0 auto 1rem' }} />
                <p>Waiting for passkey…</p>
              </div>
            )}

            {step === 'done' && (
              <div className="card" style={{ textAlign: 'center' }}>
                <p>Transaction successful</p>
                {txHash && <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.75rem', wordBreak: 'break-all' }}>{txHash}</p>}
                <button className="btn-gold" onClick={() => { setStep('view'); setTxHash(null) }}>Back</button>
              </div>
            )}

            {step === 'error' && (
              <div className="card" style={{ textAlign: 'center' }}>
                <p>Transaction failed</p>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)' }}>{errorMsg}</p>
                <button className="btn-ghost" onClick={() => setStep('view')}>Try again</button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

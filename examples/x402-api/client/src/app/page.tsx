'use client'

import { useEffect, useState } from 'react'
import { API_URL } from '@/lib/network'
import { confirmWithPasskey, createWallet, loadWallet, type VeilWallet } from '@/lib/veil'
import { payForResource, type PaidResource } from '@/lib/x402'

type Quote = { pair: string; price: number; asOf: string; note: string }

export default function Home() {
  const [wallet, setWallet] = useState<VeilWallet | null>(null)
  const [busy, setBusy] = useState(false)
  const [quote, setQuote] = useState<PaidResource<Quote> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setWallet(loadWallet())
  }, [])

  async function handleCreate() {
    setError(null)
    setBusy(true)
    try {
      setWallet(await createWallet())
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  async function handlePay() {
    if (!wallet) return
    setError(null)
    setQuote(null)
    setBusy(true)
    try {
      // The first call returns 402. The helper derives the passkey challenge
      // from that payment, asks for the biometric tap over it, verifies the
      // assertion, then pays 0.01 XLM and retries → 200.
      const result = await payForResource<Quote>(`${API_URL}/paid/quote`, wallet, (challenge) =>
        confirmWithPasskey(wallet, challenge),
      )
      setQuote(result)
    } catch (err) {
      setError(message(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page">
      <div className="card">
        <h1>x402 micropayment</h1>
        <p className="muted">
          Unlock a premium price quote for <strong>0.01 XLM</strong>, signed by your
          Veil passkey wallet.
        </p>

        {!wallet && (
          <button onClick={handleCreate} disabled={busy}>
            {busy ? 'Setting up…' : 'Create Veil wallet'}
          </button>
        )}

        {wallet && (
          <>
            <div className="alert success">
              <div className="row">
                <span>Veil wallet ready</span>
              </div>
              <div className="mono" style={{ marginTop: '0.4rem' }}>
                {wallet.payerAddress}
              </div>
            </div>

            <button onClick={handlePay} disabled={busy}>
              {busy ? 'Paying…' : 'Get quote — pay 0.01 XLM with Veil'}
            </button>
          </>
        )}

        {quote && (
          <div className="alert success">
            <strong>200 OK — payment settled</strong>
            <pre style={{ marginTop: '0.5rem' }}>{JSON.stringify(quote.data, null, 2)}</pre>
            <p className="muted" style={{ marginTop: '0.5rem' }}>
              Passkey assertion over this payment (challenge{' '}
              <span className="mono">{quote.approval.challenge}</span>) verified before signing.
            </p>
          </div>
        )}

        {error && <div className="alert error">{error}</div>}
      </div>
    </main>
  )
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.includes('NotAllowedError') || text.includes('not allowed')
    ? 'Biometric verification was cancelled. Please try again.'
    : text
}

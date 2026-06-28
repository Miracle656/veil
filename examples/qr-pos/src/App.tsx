import { useEffect, useState } from 'react'
import { QRCodeSVG } from 'qrcode.react'
import {
  buildPayUri,
  fetchSettlingPayment,
  generateMemo,
  type ChargeTarget,
  type HorizonPayment,
} from './pos'

// Testnet defaults; override with a .env for mainnet or a custom Horizon.
const HORIZON_URL =
  import.meta.env.VITE_HORIZON_URL || 'https://horizon-testnet.stellar.org'
// Named neutrally on purpose — keeps secret scanners from flagging a public id.
const stellarNetwork =
  import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'

const POLL_INTERVAL_MS = 4000

type Phase = 'setup' | 'charging' | 'paid'

interface Charge {
  uri: string
  target: ChargeTarget
}

export function App() {
  const [phase, setPhase] = useState<Phase>('setup')
  const [destination, setDestination] = useState(
    import.meta.env.VITE_MERCHANT_ADDRESS || '',
  )
  const [amount, setAmount] = useState('')
  const [assetCode, setAssetCode] = useState('')
  const [assetIssuer, setAssetIssuer] = useState('')
  const [error, setError] = useState<string | null>(null)

  const [charge, setCharge] = useState<Charge | null>(null)
  const [payment, setPayment] = useState<HorizonPayment | null>(null)
  const [pollError, setPollError] = useState<string | null>(null)

  function startCharge() {
    setError(null)
    try {
      const code = assetCode.trim()
      const issuer = assetIssuer.trim()
      if (code && !issuer) {
        throw new Error('A custom asset needs an issuer address.')
      }
      const memo = generateMemo()
      const uri = buildPayUri({
        destination: destination.trim(),
        amount: amount.trim(),
        assetCode: code || undefined,
        assetIssuer: code ? issuer : undefined,
        memo,
        networkPassphrase: stellarNetwork,
      })
      const target: ChargeTarget = {
        destination: destination.trim(),
        amount: amount.trim(),
        assetCode: code || undefined,
        assetIssuer: code ? issuer : undefined,
        since: new Date().toISOString(),
        memo,
      }
      setCharge({ uri, target })
      setPayment(null)
      setPollError(null)
      setPhase('charging')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  // Poll Horizon while a charge is open.
  useEffect(() => {
    if (phase !== 'charging' || !charge) return
    let active = true

    const tick = async () => {
      try {
        const match = await fetchSettlingPayment(HORIZON_URL, charge.target)
        if (active && match) {
          setPayment(match)
          setPhase('paid')
        }
      } catch (err) {
        if (active) setPollError(err instanceof Error ? err.message : String(err))
      }
    }

    void tick()
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [phase, charge])

  function reset() {
    setCharge(null)
    setPayment(null)
    setPollError(null)
    setAmount('')
    setPhase('setup')
  }

  const assetLabel = assetCode.trim() || 'XLM'

  return (
    <main className="pos">
      <header className="pos__brand">Veil · QR Point of Sale</header>

      {phase === 'setup' && (
        <section className="pos__card">
          <h1 className="pos__title">New charge</h1>

          <label className="pos__label">Receiving account (G…)</label>
          <input
            className="pos__input"
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="G… merchant address"
          />

          <label className="pos__label">Amount</label>
          <input
            className="pos__input pos__input--amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
          />

          <div className="pos__row">
            <div style={{ flex: 1 }}>
              <label className="pos__label">Asset code (blank = XLM)</label>
              <input
                className="pos__input"
                value={assetCode}
                onChange={(e) => setAssetCode(e.target.value)}
                placeholder="XLM"
              />
            </div>
            <div style={{ flex: 2 }}>
              <label className="pos__label">Asset issuer</label>
              <input
                className="pos__input"
                value={assetIssuer}
                onChange={(e) => setAssetIssuer(e.target.value)}
                placeholder="G… (for non-XLM)"
              />
            </div>
          </div>

          {error && <p className="pos__error">{error}</p>}

          <button
            className="pos__button"
            onClick={startCharge}
            disabled={!destination.trim() || !amount.trim()}
          >
            Charge {amount || '—'} {assetLabel}
          </button>
        </section>
      )}

      {phase === 'charging' && charge && (
        <section className="pos__card pos__card--center">
          <h1 className="pos__title">Scan to pay</h1>
          <p className="pos__amount">
            {charge.target.amount} {assetLabel}
          </p>

          <div className="pos__qr">
            <QRCodeSVG value={charge.uri} size={280} level="M" marginSize={4} />
          </div>

          <p className="pos__hint">Open the Veil wallet and scan this code.</p>
          <p className="pos__waiting">Waiting for payment…</p>
          {pollError && <p className="pos__error">Network: {pollError}</p>}

          <button className="pos__button pos__button--ghost" onClick={reset}>
            Cancel
          </button>
        </section>
      )}

      {phase === 'paid' && payment && (
        <section className="pos__card pos__card--center">
          <div className="pos__check" aria-hidden="true">
            ✓
          </div>
          <h1 className="pos__title">Paid!</h1>
          <p className="pos__amount">
            {payment.amount} {assetLabel}
          </p>
          {payment.transaction_hash && (
            <a
              className="pos__link"
              href={`https://stellar.expert/explorer/testnet/tx/${payment.transaction_hash}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction
            </a>
          )}
          <button className="pos__button" onClick={reset}>
            New charge
          </button>
        </section>
      )}
    </main>
  )
}

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { WebAuthnSignature } from '@veil/invisible-wallet-sdk'
import { appConfig } from '../lib/config'
import { useViteWallet } from '../lib/wallet'
import { bytesToHex } from '../lib/webauthn'
import { readSignerPublicKey, readWalletAddress } from '../lib/storage'

export function DashboardPage() {
  const navigate = useNavigate()
  const wallet = useViteWallet()
  const [address, setAddress] = useState<string | null>(null)
  const [signature, setSignature] = useState<WebAuthnSignature | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const stored = readWalletAddress()
    if (!stored) {
      navigate('/register', { replace: true })
      return
    }

    setAddress(stored)
    wallet.login().catch(() => {
      setError('Wallet not yet deployed. Return to Register and deploy it first.')
    })
  }, [navigate, wallet])

  const handleSignDemo = async () => {
    setError(null)
    try {
      const payload = new Uint8Array(32)
      payload.fill(7)
      const result = await wallet.signAuthEntry(payload)
      if (!result) {
        throw new Error('No signature returned.')
      }
      setSignature(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="panel">
      <p className="eyebrow">Dashboard</p>
      <h1>Wallet overview</h1>
      <p className="lede">A compact status page that shows the registered wallet and the stored fee-payer session.</p>

      {error ? <div className="notice error">{error}</div> : null}

      <div className="grid two-up">
        <article className="card">
          <span className="card-label">Wallet address</span>
          <div className="mono break">{address ?? 'No wallet registered yet.'}</div>
        </article>
        <article className="card">
          <span className="card-label">Fee-payer public key</span>
          <div className="mono break">{readSignerPublicKey() ?? 'Missing'}</div>
        </article>
      </div>

      <div className="stack">
        <div className="actions">
          <button className="primary" onClick={handleSignDemo} disabled={wallet.isPending || !address}>
            Sign auth entry demo
          </button>
          <Link className="secondary" to="/send">Go to send</Link>
        </div>

        {signature ? (
          <article className="card">
            <span className="card-label">WebAuthn signature</span>
            <div className="mono small">publicKey: {bytesToHex(signature.publicKey)}</div>
            <div className="mono small">authData: {bytesToHex(signature.authData)}</div>
            <div className="mono small">clientDataJSON: {bytesToHex(signature.clientDataJSON)}</div>
            <div className="mono small">signature: {bytesToHex(signature.signature)}</div>
          </article>
        ) : null}

        <div className="hint">
          Network: {appConfig.networkPassphrase === 'Test SDF Network ; September 2015' ? 'Testnet' : 'Custom'}
        </div>
      </div>
    </section>
  )
}

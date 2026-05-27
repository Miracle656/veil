import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useViteWallet } from '../lib/wallet'
import { appConfig } from '../lib/config'
import { deriveFeePayerKeypair } from '../lib/webauthn'
import { persistSession, readCredentialId } from '../lib/storage'

export function RegisterPage() {
  const navigate = useNavigate()
  const wallet = useViteWallet()
  const [username, setUsername] = useState('Veil User')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'registering' | 'deploying' | 'done'>('idle')

  const canStart = appConfig.factoryAddress.length > 0 && !wallet.isPending

  const handleRegister = async () => {
    setError(null)

    if (!appConfig.factoryAddress) {
      setError('Set VITE_FACTORY_ADDRESS before running the starter.')
      return
    }

    try {
      setStatus('registering')
      const registration = await wallet.register(username.trim() || 'Veil User')

      const credentialId = readCredentialId()
      if (!credentialId) {
        throw new Error('Registration completed, but the credential ID was not stored.')
      }

      setStatus('deploying')
      const feePayer = await deriveFeePayerKeypair(credentialId)

      if (appConfig.friendbotUrl) {
        const response = await fetch(`${appConfig.friendbotUrl}?addr=${feePayer.publicKey()}`)
        if (!response.ok) {
          throw new Error('Friendbot funding failed.')
        }
      }

      const deployed = await wallet.deploy(feePayer.secret(), registration.publicKeyBytes)
      persistSession(deployed.walletAddress, feePayer.secret(), feePayer.publicKey())
      setStatus('done')
      navigate('/dashboard', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStatus('idle')
    }
  }

  return (
    <section className="panel hero-panel">
      <p className="eyebrow">Register</p>
      <h1>Create a passkey wallet</h1>
      <p className="lede">
        Register a WebAuthn credential, derive the fee-payer key, and deploy the wallet contract on testnet.
      </p>

      <div className="stack">
        <label className="field">
          <span>Display name</span>
          <input value={username} onChange={event => setUsername(event.target.value)} placeholder="Veil User" />
        </label>

        <button className="primary" onClick={handleRegister} disabled={!canStart}>
          {wallet.isPending || status === 'registering' ? 'Creating passkey...' : status === 'deploying' ? 'Deploying wallet...' : 'Create wallet'}
        </button>

        {error ? <div className="notice error">{error}</div> : null}
        <div className="hint">This flow mirrors the Next.js starter onboarding: register first, then deploy, then continue to the dashboard.</div>
      </div>
    </section>
  )
}

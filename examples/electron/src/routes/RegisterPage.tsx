import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useElectronWallet } from '../lib/wallet'
import { appConfig } from '../lib/config'
import { deriveFeePayerKeypair } from '../lib/webauthn'
import { persistSession, readCredentialId } from '../lib/storage'

const webAuthnSupported = typeof window !== 'undefined' && window.isSecureContext && !!navigator.credentials

export function RegisterPage() {
  const navigate = useNavigate()
  const wallet = useElectronWallet()
  const [username, setUsername] = useState('Veil User')
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<'idle' | 'registering' | 'deploying' | 'done'>('idle')

  const canStart = appConfig.factoryAddress.length > 0 && webAuthnSupported && !wallet.isPending

  const handleRegister = async () => {
    setError(null)

    if (!appConfig.factoryAddress) {
      setError('Set VITE_FACTORY_ADDRESS before running the example.')
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

      {!webAuthnSupported ? (
        <div className="notice error">
          This window is not a secure context, so <code>navigator.credentials</code> is unavailable. See the
          README's "WebAuthn caveats" section — the renderer must be loaded over <code>http://localhost</code> or{' '}
          <code>https://</code>, never <code>file://</code>.
        </div>
      ) : null}

      <div className="stack">
        <label className="field">
          <span>Display name</span>
          <input value={username} onChange={event => setUsername(event.target.value)} placeholder="Veil User" />
        </label>

        <button className="primary" onClick={handleRegister} disabled={!canStart}>
          {wallet.isPending || status === 'registering' ? 'Creating passkey...' : status === 'deploying' ? 'Deploying wallet...' : 'Create wallet'}
        </button>

        {error ? <div className="notice error">{error}</div> : null}
        <div className="hint">
          The platform authenticator prompt (Touch ID, Windows Hello, etc.) is drawn by the OS, not by this window —
          if nothing appears, see the README for platform-specific caveats.
        </div>
      </div>
    </section>
  )
}

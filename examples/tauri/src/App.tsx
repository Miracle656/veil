import { useEffect, useMemo, useState } from 'react'
import { useInvisibleWallet, type WebAuthnSignature } from '../../../sdk/src/index.js'
import { checkStatus, Status } from '@tauri-apps/plugin-biometric'
import './index.css'

const FACTORY_ADDRESS = import.meta.env.VITE_FACTORY_ADDRESS || ''
const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org'
const NETWORK_PASSPHRASE = import.meta.env.VITE_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015'
const RP_ID = import.meta.env.VITE_RP_ID || 'localhost'
const ORIGIN = import.meta.env.VITE_ORIGIN || 'https://localhost'

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function App() {
  const wallet = useInvisibleWallet({
    factoryAddress: FACTORY_ADDRESS,
    rpcUrl: RPC_URL,
    networkPassphrase: NETWORK_PASSPHRASE,
    rpId: RP_ID,
    origin: ORIGIN,
  })

  const { address, isPending, error, register, signAuthEntry } = wallet
  const [username, setUsername] = useState('Tauri User')
  const [signatureResult, setSignatureResult] = useState<WebAuthnSignature | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [signing, setSigning] = useState(false)
  const [biometricStatus, setBiometricStatus] = useState<Status | null>(null)

  useEffect(() => {
    let mounted = true
    checkStatus()
      .then((status) => {
        if (mounted) setBiometricStatus(status)
      })
      .catch(() => {
        if (mounted) setBiometricStatus(null)
      })
    return () => {
      mounted = false
    }
  }, [])

  const canUseBiometric = useMemo(
    () => biometricStatus?.isAvailable ?? true,
    [biometricStatus],
  )

  const handleRegister = async () => {
    setLocalError(null)
    setSignatureResult(null)

    try {
      await register(username)
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleSign = async () => {
    setLocalError(null)
    setSignatureResult(null)
    setSigning(true)

    try {
      const payload = new Uint8Array(32)
      payload.fill(0x4b)
      const result = await signAuthEntry(payload)
      if (!result) {
        throw new Error('Signing was cancelled or failed')
      }
      setSignatureResult(result)
    } catch (err: unknown) {
      setLocalError(err instanceof Error ? err.message : String(err))
    } finally {
      setSigning(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Veil</p>
          <h1>Desktop Wallet Example</h1>
        </div>
      </header>

      <main className="content">
        <section className="card">
          <h2>Passkey wallet demo</h2>
          <p className="description">
            This example registers a passkey credential through Tauri biometric authentication, then signs a 32-byte authorization payload.
          </p>

          <div className="status-grid">
            <div>
              <strong>RP ID</strong>
              <div>{RP_ID}</div>
            </div>
            <div>
              <strong>Origin</strong>
              <div>{ORIGIN}</div>
            </div>
            <div>
              <strong>Biometric status</strong>
              <div>{canUseBiometric ? 'Available' : 'Unavailable'}</div>
            </div>
          </div>

          {error || localError ? (
            <div className="alert error">
              <pre>{error || localError}</pre>
            </div>
          ) : null}

          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={isPending}
            />
          </label>

          <div className="actions">
            <button onClick={handleRegister} disabled={isPending || !canUseBiometric}>
              {isPending ? 'Registering…' : 'Register passkey'}
            </button>
            <button onClick={handleSign} disabled={signing || isPending || !address || !canUseBiometric}>
              {signing ? 'Signing…' : 'Sign auth entry'}
            </button>
          </div>

          {address ? (
            <div className="card secondary">
              <p className="label">Wallet address</p>
              <code>{address}</code>
            </div>
          ) : null}

          {signatureResult ? (
            <div className="card secondary">
              <p className="label">Signed assertion</p>
              <div className="trace">
                <div>
                  <strong>publicKey</strong>
                  <pre>{toHex(signatureResult.publicKey)}</pre>
                </div>
                <div>
                  <strong>authData</strong>
                  <pre>{toHex(signatureResult.authData)}</pre>
                </div>
                <div>
                  <strong>clientDataJSON</strong>
                  <pre>{toHex(signatureResult.clientDataJSON)}</pre>
                </div>
                <div>
                  <strong>signature</strong>
                  <pre>{toHex(signatureResult.signature)}</pre>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </main>
    </div>
  )
}

export default App

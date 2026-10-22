import { useEffect, useState } from 'react'
import { useNavigate } from '@remix-run/react'
import type { MetaFunction } from '@remix-run/node'
import { Keypair, Horizon } from '@stellar/stellar-sdk'
import { resolveNetwork, clientEnv } from '~/lib/network'

export const meta: MetaFunction = () => [{ title: 'Veil Wallet — Remix' }]

type Step = 'idle' | 'registering' | 'funding' | 'deploying' | 'notifications' | 'done' | 'error'

const stepLabel: Record<Step, string> = {
  idle: '',
  registering: 'Creating passkey…',
  funding: 'Funding fee-payer via Friendbot…',
  deploying: 'Deploying wallet on Stellar…',
  notifications: 'Setting up notifications…',
  done: 'Done!',
  error: '',
}

// Notification preferences are defaulted conservatively: the push payload
// only says that something arrived, never the amount or the sender.
export interface NotificationPrefs {
  enabled: boolean
  showAmount: boolean
  showSender: boolean
}

export const DEFAULT_PREFS: NotificationPrefs = {
  enabled: false,
  showAmount: false,
  showSender: false,
}

export default function Index() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [prefs, setPrefs] = useState<NotificationPrels>(DEFAULT_PREFS)

  useEffect(() => {
    if (localStorage.getItem('invisible_wallet_address')) {
      navigate('/dashboard')
    }
  }, [navigate])

  async function handleCreate() {
    setErrorMsg(null)
    try {
      const net = resolveNetwork(clientEnv())
      // SDK is CommonJS + browser-only — load it lazily on the client.
      const { createInvisibleWallet } = await import('invisible-wallet-sdk/vanilla')
      const wallet = createInvisibleWallet(net.walletConfig)

      // 1. Register the passkey.
      setStep('registering')
      await wallet.register(username || undefined)

      // 2. Generate + fund a fee-payer keypair (pays fees, doesn't own the wallet).
      setStep('funding')
      const feePayer = Keypair.random()
      localStorage.setItem('veil_fee_payer_secret', feePayer.secret())
      if (net.friendbotUrl) {
        const res = await fetch(`${net.friendbotUrl}?addr=${feePayer.publicKey()}`)
        if (!res.ok) throw new Error('Friendbot funding failed — try again in a moment.')
      } else {
        const horizon = new Horizon.Server(net.horizonUrl)
        await horizon.loadAccount(feePayer.publicKey()).catch(() => {
          throw new Error(`Mainnet requires a funded fee-payer. Fund ${feePayer.publicKey()} then retry.`)
        })
      }

      // 3. Deploy the wallet contract via the factory.
      setStep('deploying')
      await wallet.deploy(feePayer.secret())

      // 4. Register a push token for this wallet, only if the user opted in.
      //    Revoke is a separate call that deletes the token on the backend.
      setStep('notifications')
      if (prefs.enabled) {
        await registerPushToken(net, wallet.address, prefs)
      }

      setStep('done')
      navigate('/dashboard')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setStep('error')
    }
  }

  function handleLogin() {
    setErrorMsg(null)
    if (localStorage.getItem('invisible_wallet_address')) {
      navigate('/dashboard')
    } else {
      setErrorMsg('No wallet found on this device. Create one first.')
    }
  }

  const busy = step !== 'idle' && step !== 'done' && step !== 'error'

  return (
    <main className="page">
      <div className="card stack">
        <div style={{ textAlign: 'center' }}>
          <h1>Veil Wallet</h1>
          <p className="muted">Passkey-powered · Remix · Stellar Testnet</p>
        </div>

        <input
          type="text"
          placeholder="Username (optional)"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy}
        />

        <fieldset className="stack" style={{ border: 'none', padding: 0, margin: '0 0', width: '100%' }}>
          <legend className="muted">Payment notifications</legend>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={prefs.enabled}
              onChange={(e) => setPrefs((p) => ({ ...p, enabled: e.target.checked }))}
              disabled={busy}
            />
            Notify me when money arrives
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={prefs.showAmount}
              onChange={(e) => setPrefs((p) => ({ ...p, showAmount: e.target.checked }))}
              disabled={busy || !prefs.enabled}
            />
            Include the amount in the notification
          </label>
          <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={prefs.showSender}
              onChange={(e) => setPrefs((p) => ({ ...p, showSender: e.target.checked }))}
              disabled={busy || !prefs.enabled}
            />
            Include the sender in the notification
          </label>
          <p className="muted">
            By default notifications only say that a payment arrived. You can turn them off at any time.
          </p>
        </fieldset>

        <button onClick={handleCreate} disabled={busy}>
          {busy ? stepLabel[step] : 'Create wallet with passkey'}
        </button>
        <button className="secondary" onClick={handleLogin} disabled={busy}>
          I already have a wallet
        </button>

        {errorMsg && <p className="alert error">{errorMsg}</p>}

        <p className="muted" style={{ textAlign: 'center' }}>
          Your key never leaves your device. Powered by WebAuthn passkeys.
        </p>
      </div>
    </main>
  )
}

async function registerPushToken(
  net: ReturnType<typeof resolveNetwork>,
  address: string,
  prefs: NotificationPrefs,
): Promise<void> {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('This browser cannot receive push notifications.')
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted.')
  }

  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: net.pushServerKey,
  })

  const res = await fetch(`${net.notifierUrl}/tokens/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      address,
      subscription: subscription.toJSON(),
      prefs: { showAmount: prefs.showAmount, showSender: prefs.showSender },
    }),
  })
  if (!res.ok) {
    await subscription.unsubscribe().catch(() => undefined)
    throw new Error('Push registration failed — try again in a moment.')
  }
}

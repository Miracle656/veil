import { useEffect, useState } from 'react'
import { useNavigate } from '@remix-run/react'
import type { MetaFunction } from '@remix-run/node'
import { Keypair, Horizon } from '@stellar/stellar-sdk'
import { resolveNetwork, clientEnv } from '~/lib/network'

export const meta: MetaFunction = () => [{ title: 'Veil Wallet — Remix' }]

type Step = 'idle' | 'registering' | 'funding' | 'deploying' | 'done' | 'error'

const stepLabel: Record<Step, string> = {
  idle: '',
  registering: 'Creating passkey…',
  funding: 'Funding fee-payer via Friendbot…',
  deploying: 'Deploying wallet on Stellar…',
  done: 'Done!',
  error: '',
}

export default function Index() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [step, setStep] = useState<Step>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

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

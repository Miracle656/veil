'use client'

/**
 * Veil Connect (pilot) — the window another app opens.
 *
 * The app's request arrives by postMessage from the window that opened this
 * one, and is accepted only from an origin on that app's list
 * (lib/connect.ts). The user then sees, in plain words, who is asking and for
 * what, and nothing happens until they agree.
 *
 * Three requests exist:
 *   connect — share this wallet's address with the app
 *   pay     — hand a payment to the normal Send screen, already filled in
 *   fund    — open "Buy with naira"
 *   cashout — open the person's own "Cash out" to their bank
 *
 * A user with no wallet in this browser is sent to create one (or to unlock),
 * and components/ConnectResume.tsx brings them back here afterwards.
 */

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'

import {
  getConnectApp,
  isAllowedOrigin,
  parseConnectRequest,
  readyMessage,
  requestFromMessage,
  sendPathFor,
  type ConnectApp,
  type PendingConnect,
} from '@/lib/connect'
import { ALLOW_DEMO_APP, answer, clearPending, readPending, writePending } from '@/lib/connectWindow'
import { getAssetIssuer } from '@/lib/assets'
import { getNetworkName } from '@/lib/network'
import { walletLocal, walletSession } from '@/lib/walletStorage'

type WalletState = 'none' | 'locked' | 'open'

function walletState(): WalletState {
  if (walletSession.getItem('invisible_wallet_address')) return 'open'
  if (walletLocal.getItem('invisible_wallet_address')) return 'locked'
  return 'none'
}

/** How long to wait for the app's request before saying nothing came. */
const REQUEST_TIMEOUT_MS = 8_000

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem 1rem' }}>
      <div className="card" style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
        <p style={{ fontSize: '0.75rem', letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.55 }}>
          Veil Connect
        </p>
        {children}
      </div>
    </main>
  )
}

function Title({ children }: { children: React.ReactNode }) {
  return (
    <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontSize: '1.3rem', lineHeight: 1.3 }}>
      {children}
    </h1>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8rem', wordBreak: 'break-all', opacity: 0.8 }}>
      {children}
    </p>
  )
}

function Connect() {
  const router = useRouter()
  const params = useSearchParams()
  const appId = params.get('app')

  const [app, setApp] = useState<ConnectApp | null | undefined>(undefined)
  const [pending, setPending] = useState<PendingConnect | null>(null)
  const [wallet, setWallet] = useState<WalletState>('none')
  const [problem, setProblem] = useState<string | null>(null)
  const [finished, setFinished] = useState<string | null>(null)

  // Find the request: one already stored in this window (the user is coming
  // back from signing in), or one the app sends now.
  useEffect(() => {
    setWallet(walletState())

    const stored = readPending()
    if (stored && (!appId || stored.appId === appId)) {
      setApp(getConnectApp(stored.appId, ALLOW_DEMO_APP))
      setPending(stored)
      return
    }

    const found = getConnectApp(appId, ALLOW_DEMO_APP)
    setApp(found)
    if (!found) return

    const opener = window.opener as Window | null
    if (!opener) {
      setProblem(`Open this from ${found.name}. This page only works when ${found.name} opens it.`)
      return
    }

    const onMessage = (event: MessageEvent) => {
      // The browser vouches for `origin`. Nothing else in the message does.
      if (event.source !== opener || !isAllowedOrigin(found, event.origin)) return
      const raw = requestFromMessage(event.data)
      if (raw === null) return
      const parsed = parseConnectRequest(raw)
      if (!parsed.ok) { setProblem(parsed.reason); return }
      const next: PendingConnect = { appId: found.id, origin: event.origin, request: parsed.request }
      writePending(next)
      setPending(next)
    }
    window.addEventListener('message', onMessage)

    // Tell the app we are listening. Sent to each listed origin by name, so a
    // page on any other origin never hears it.
    for (const origin of found.origins) {
      try { opener.postMessage(readyMessage(), origin) } catch { /* not that origin */ }
    }

    const timer = window.setTimeout(() => {
      setProblem((current) => current ?? `${found.name} did not send a request. Close this window and try again.`)
    }, REQUEST_TIMEOUT_MS)

    return () => {
      window.removeEventListener('message', onMessage)
      window.clearTimeout(timer)
    }
  }, [appId])

  const close = useCallback((message: string) => {
    setFinished(message)
    window.setTimeout(() => { try { window.close() } catch { /* stays open */ } }, 600)
  }, [])

  const cancel = useCallback(() => {
    if (pending) answer(pending, { ok: false, error: 'cancelled' })
    clearPending()
    close('Cancelled. You can close this window.')
  }, [pending, close])

  const shareAddress = useCallback(() => {
    if (!pending) return
    const address = walletSession.getItem('invisible_wallet_address')
    if (!address) { setWallet(walletState()); return }
    const delivered = answer(pending, { ok: true, type: 'connect', address, network: getNetworkName() })
    clearPending()
    close(delivered ? 'Connected. Taking you back.' : 'The app that asked is no longer open. Go back to it and try again.')
  }, [pending, close])

  const startPayment = useCallback(() => {
    if (!pending || pending.request.type !== 'pay') return
    const issuer = getAssetIssuer('USDC', getNetworkName())
    if (pending.request.asset === 'USDC' && !issuer) {
      setProblem('USDC is not set up on this network.')
      return
    }
    // The request stays stored: the Send screen reads it to show who is being
    // paid and to send the answer when the payment is done.
    router.push(sendPathFor(pending.request, issuer ?? ''))
  }, [pending, router])

  const addMoney = useCallback(() => {
    if (!pending) return
    answer(pending, { ok: true, type: 'fund' })
    clearPending()
    router.push('/buy-ngn')
  }, [pending, router])

  const cashOut = useCallback(() => {
    if (!pending) return
    answer(pending, { ok: true, type: 'cashout' })
    clearPending()
    router.push('/cashout')
  }, [pending, router])

  // ── What to show ──────────────────────────────────────────────────────────

  if (finished) return <Shell><Title>{finished}</Title></Shell>

  if (app === null) {
    return (
      <Shell>
        <Title>This app is not set up to use Veil.</Title>
        <p style={{ opacity: 0.7 }}>Close this window. If an app sent you here, tell them the link is wrong.</p>
      </Shell>
    )
  }

  if (problem) {
    return (
      <Shell>
        <Title>This request cannot be used.</Title>
        <p style={{ opacity: 0.8 }}>{problem}</p>
        <button className="btn-ghost" onClick={cancel}>Close</button>
      </Shell>
    )
  }

  if (!app || !pending) {
    return <Shell><Title>Waiting for the request…</Title></Shell>
  }

  if (wallet !== 'open') {
    return (
      <Shell>
        <Title>{app.name} wants to use your Veil wallet.</Title>
        <p style={{ opacity: 0.8 }}>
          {wallet === 'locked'
            ? 'Unlock your wallet to continue. You will come back here straight after.'
            : 'You do not have a Veil wallet in this browser yet. Create one with your fingerprint or face. It takes about a minute, and you will come back here straight after.'}
        </p>
        <button className="btn-gold" onClick={() => router.push(wallet === 'locked' ? '/lock' : '/')}>
          {wallet === 'locked' ? 'Unlock my wallet' : 'Create my wallet'}
        </button>
        <button className="btn-ghost" onClick={cancel}>Cancel</button>
      </Shell>
    )
  }

  const address = walletSession.getItem('invisible_wallet_address') ?? ''
  const request = pending.request

  if (request.type === 'connect') {
    return (
      <Shell>
        <Title>Share your wallet address with {app.name}?</Title>
        <p style={{ opacity: 0.8 }}>
          {app.name} will see this address and what it holds. It cannot move your money. Every payment still needs you.
        </p>
        <Mono>{address}</Mono>
        <button className="btn-gold" onClick={shareAddress}>Share address</button>
        <button className="btn-ghost" onClick={cancel}>Cancel</button>
      </Shell>
    )
  }

  if (request.type === 'fund') {
    return (
      <Shell>
        <Title>Add money to your Veil wallet</Title>
        <p style={{ opacity: 0.8 }}>
          Pay naira by bank transfer and it arrives in your wallet as XLM. You can swap it to USDC in Veil.
        </p>
        <button className="btn-gold" onClick={addMoney}>Buy with naira</button>
        <button className="btn-ghost" onClick={cancel}>Cancel</button>
      </Shell>
    )
  }

  if (request.type === 'cashout') {
    return (
      <Shell>
        <Title>Cash out to your bank</Title>
        <p style={{ opacity: 0.8 }}>
          Send USDC from your Veil wallet to your own bank account as naira. You choose the amount and the bank here in Veil. {app.name} does not see your bank details.
        </p>
        <button className="btn-gold" onClick={cashOut}>Cash out</button>
        <button className="btn-ghost" onClick={cancel}>Cancel</button>
      </Shell>
    )
  }

  return (
    <Shell>
      <Title>{app.name} asks you to pay {request.amount} {request.asset}</Title>
      <div>
        <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>To this address</p>
        <Mono>{request.to}</Mono>
      </div>
      <div>
        <p style={{ fontSize: '0.8rem', opacity: 0.6 }}>Reference</p>
        <Mono>{request.reference}</Mono>
      </div>
      <p style={{ opacity: 0.8 }}>
        Next you will see the payment on Veil&apos;s Send screen. Nothing is sent until you confirm there.
      </p>
      <button className="btn-gold" onClick={startPayment}>Continue</button>
      <button className="btn-ghost" onClick={cancel}>Cancel</button>
    </Shell>
  )
}

export default function ConnectPage() {
  return (
    <Suspense fallback={null}>
      <Connect />
    </Suspense>
  )
}

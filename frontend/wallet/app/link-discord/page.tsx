'use client'

/**
 * Link Discord — where the Veil Discord bot's "Open Veil" button lands.
 *
 * Two kinds of people arrive here.
 *
 *   - Someone whose wallet lives in this browser. They see whose Discord
 *     account the code belongs to, approve with their passkey, and get roles.
 *   - Someone whose wallet lives in the phone app, on a phone where the link
 *     opened the browser instead of the app (an older build, or app links not
 *     yet verified). They get a button that hands the code to the app, and
 *     the code itself to type in Settings → Link Discord.
 *
 * The page never asks for an address or a key to be typed. That is the point
 * of the whole flow, and it is what fake "verification" sites ask for.
 */

import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

import {
  canLinkOnThisNetwork,
  formatLinkCode,
  getLinkableAccounts,
  linkDiscord,
  lookUpLinkCode,
  normalizeLinkCode,
  type LinkableAccounts,
  type LinkCodeInfo,
  type LinkResult,
} from '@/lib/discordLink'

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-6)}`
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

const NEVER_ASKED =
  'Veil will never message you first, and will never ask for a key, a recovery code or a payment.'

function LinkDiscord() {
  const params = useSearchParams()
  const linkedCode = params.get('code') ?? ''

  const [accounts, setAccounts] = useState<LinkableAccounts | undefined>(undefined)
  const [typed, setTyped] = useState('')
  const [info, setInfo] = useState<LinkCodeInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<LinkResult | null>(null)

  // Storage is only readable in the browser, so this waits for mount.
  useEffect(() => {
    setAccounts(getLinkableAccounts())
  }, [])

  const lookUp = useCallback(async (raw: string) => {
    const code = normalizeLinkCode(raw)
    if (!code) {
      setError('That does not look like a code from the Veil bot. It is eight letters and digits.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      setInfo(await lookUpLinkCode(code))
    } catch (caught) {
      setError(messageOf(caught, 'That code could not be checked. Try again.'))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!linkedCode) return
    setTyped(linkedCode)
    void lookUp(linkedCode)
  }, [linkedCode, lookUp])

  const approve = useCallback(async () => {
    if (!info || !accounts) return
    setBusy(true)
    setError(null)
    try {
      const linked = await linkDiscord(info, accounts)
      if (linked) setResult(linked)
      else setError('Cancelled. Nothing was linked.')
    } catch (caught) {
      setError(messageOf(caught, 'Could not link. Nothing was changed.'))
    } finally {
      setBusy(false)
    }
  }, [accounts, info])

  const code = normalizeLinkCode(typed)
  const hasWallet = Boolean(accounts?.wallet || accounts?.spending)

  let body: ReactNode
  if (accounts === undefined) {
    body = <p className="mt-6 text-sm text-off-white/50">Loading…</p>
  } else if (result) {
    body = (
      <>
        <h2 className="mt-6 font-lora text-2xl font-semibold italic">
          Linked to {info?.discordUsername ?? 'your Discord account'}.
        </h2>
        {!result.inServer ? (
          <p className="mt-3 text-sm leading-relaxed text-off-white/70">
            That Discord account is not in the Veil server yet. Join the server and your roles will be added at the
            next daily check, or press Refresh roles there.
          </p>
        ) : result.roles.length > 0 ? (
          <ul className="card mt-5 space-y-2">
            {result.roles.map((role) => (
              <li key={role} className="font-semibold text-off-white">
                {role}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-off-white/70">
            No roles yet. They are given for a Veil wallet, a Veil name, a Veil-ian and for using your wallet.
          </p>
        )}
        {result.incomplete ? (
          <p className="mt-3 text-sm text-off-white/50">
            Some checks could not be finished just now. They will be tried again.
          </p>
        ) : null}
        <p className="mt-3 text-sm text-off-white/50">
          Your roles are checked again every day. To undo this, use /unlink in the Veil server.
        </p>
        <Link href="/dashboard" className="btn-gold mt-6 inline-flex">
          Back to wallet
        </Link>
      </>
    )
  } else if (!hasWallet) {
    body = (
      <>
        <h2 className="mt-6 font-lora text-2xl font-semibold italic">Is your wallet in the Veil app?</h2>
        <p className="mt-3 text-sm leading-relaxed text-off-white/70">
          There is no wallet in this browser. If yours is in the Veil app on this phone, open the app to finish.
        </p>
        {code ? (
          <>
            <a href={`veil://link-discord?code=${code}`} className="btn-gold mt-6 inline-flex">
              Open the Veil app
            </a>
            <p className="mt-5 text-sm leading-relaxed text-off-white/70">
              If nothing happens, open the app yourself, go to <strong>Settings → Link Discord</strong>, and type this
              code:
            </p>
            <p className="mt-3 font-mono text-3xl tracking-[0.2em] text-gold">{formatLinkCode(code)}</p>
            <p className="mt-2 text-sm text-off-white/50">
              Link Discord needs the newest version of the app. Update it first if you do not see it in Settings.
            </p>
          </>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-off-white/70">
            In Discord, press <strong>Verify wallet</strong> to get a link and a code.
          </p>
        )}
        <p className="mt-6 text-sm text-off-white/70">
          Wallet in this browser instead?{' '}
          <Link href="/" className="text-gold underline">
            Sign in
          </Link>
          , then open the link from Discord again.
        </p>
      </>
    )
  } else if (!canLinkOnThisNetwork()) {
    body = (
      <>
        <h2 className="mt-6 font-lora text-2xl font-semibold italic">Roles are for mainnet wallets.</h2>
        <p className="mt-3 text-sm leading-relaxed text-off-white/70">
          This wallet is on the test network. Switch to mainnet in Settings, then open the link from Discord again.
        </p>
      </>
    )
  } else if (info) {
    body = (
      <>
        <p className="mt-6 text-[11px] font-semibold uppercase tracking-[0.14em] text-off-white/40">Discord account</p>
        <div className="card mt-2">
          <p className="text-lg font-semibold text-off-white">{info.discordUsername}</p>
          <p className="mt-1 text-sm text-off-white/50">Check this is your own account. If it is not, close this page.</p>
        </div>

        <p className="mt-5 text-[11px] font-semibold uppercase tracking-[0.14em] text-off-white/40">
          What will be linked
        </p>
        <div className="card mt-2 space-y-3">
          {accounts.wallet ? (
            <div>
              <p className="text-sm text-off-white/50">Your wallet</p>
              <p className="font-mono text-off-white">{short(accounts.wallet)}</p>
            </div>
          ) : null}
          {accounts.spending ? (
            <div>
              <p className="text-sm text-off-white/50">Your spending account</p>
              <p className="font-mono text-off-white">{short(accounts.spending)}</p>
            </div>
          ) : null}
        </div>
        {!accounts.wallet ? (
          <p className="mt-3 text-sm leading-relaxed text-off-white/50">
            This browser cannot sign for your wallet itself. To link it too, use the Veil app:{' '}
            <a href={`veil://link-discord?code=${info.code}`} className="text-gold underline">
              open the app
            </a>
            .
          </p>
        ) : null}

        <p className="mt-4 text-sm leading-relaxed text-off-white/70">
          Approving proves these are yours. Nothing is sent and nothing is spent. Only Veil keeps the link; your
          address is not posted in Discord.
        </p>
        {error ? (
          <p className="mt-3 text-sm text-red-400" role="alert">
            {error}
          </p>
        ) : null}
        <button type="button" className="btn-gold mt-6" disabled={busy} onClick={() => void approve()}>
          {busy ? 'Working…' : accounts.wallet ? 'Approve with passkey' : 'Approve'}
        </button>
      </>
    )
  } else {
    body = (
      <>
        <h2 className="mt-6 font-lora text-2xl font-semibold italic">Get your roles in the Veil Discord server.</h2>
        <p className="mt-3 text-sm leading-relaxed text-off-white/70">
          In Discord, press <strong>Verify wallet</strong>. The bot gives you a code. Type it here.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void lookUp(typed)
          }}
        >
          <input
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value)
              setError(null)
            }}
            placeholder="ABCD-2345"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={12}
            aria-label="Code from the Veil Discord bot"
            className="input-field mt-5 text-center font-mono text-2xl uppercase tracking-[0.2em]"
          />
          {error ? (
            <p className="mt-3 text-sm text-red-400" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="btn-gold mt-5" disabled={busy || !typed.trim()}>
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
      </>
    )
  }

  return (
    <main className="min-h-screen bg-near-black px-4 pb-16 pt-12 text-off-white">
      <div className="mx-auto max-w-[480px]">
        <p className="font-anton text-[14px] uppercase tracking-[0.14em] text-gold">Veil</p>
        <h1 className="mt-2 font-lora text-4xl font-semibold italic">Link Discord</h1>
        {body}
        <p className="mt-10 border-t border-border-dim pt-5 text-xs leading-relaxed text-off-white/40">{NEVER_ASKED}</p>
      </div>
    </main>
  )
}

export default function LinkDiscordPage() {
  // useSearchParams needs a Suspense boundary for the static build.
  return (
    <Suspense fallback={null}>
      <LinkDiscord />
    </Suspense>
  )
}

'use client'

/**
 * Veil Connect — the screen for a contract call another app asked for.
 *
 * The person sees which contract and function, the values sent, every call it
 * would make in their name, and any money leaving their addresses, before the
 * passkey is asked for anything. See lib/connectInvokeRun.ts for the order of
 * events and lib/connectInvoke.ts for what is refused outright.
 */
import { useEffect, useState } from 'react'

import type { ConnectApp, ConnectResult } from '@/lib/connect'
import { InvokeRefused, previewInvoke, runInvoke, type InvokePreview, type InvokeRequest } from '@/lib/connectInvokeRun'
import { getNetworkName } from '@/lib/network'
import { passkeyErrorMessage } from '@/lib/passkeyAuth'

type Stage =
  | { at: 'reading' }
  | { at: 'review'; preview: InvokePreview }
  | { at: 'sending'; preview: InvokePreview }
  | { at: 'stopped'; reason: string }

const label: React.CSSProperties = { fontSize: '0.8rem', opacity: 0.6 }
const mono: React.CSSProperties = {
  fontFamily: 'Inconsolata, monospace',
  fontSize: '0.8rem',
  wordBreak: 'break-all',
  opacity: 0.85,
}

function plain(err: unknown): string {
  if (err instanceof InvokeRefused) return err.message
  // The browser's own passkey errors (dismissed, not allowed, timed out).
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) return passkeyErrorMessage(err)
  const said = err instanceof Error ? err.message : ''
  if (/cancel/i.test(said)) return 'You cancelled, so nothing was sent.'
  // The one case where something may have gone out: it was submitted and the
  // network did not answer in time. Never call that "not sent".
  if (/timed out/i.test(said)) {
    return 'Veil sent this but could not confirm it in time. Check your activity in Veil before you try again, so it is not done twice.'
  }
  return said || 'Something went wrong, so nothing was sent.'
}

export function ConnectInvoke({
  app,
  request,
  wallet,
  onDone,
  onCancel,
}: {
  app: ConnectApp
  request: InvokeRequest
  /** The person's wallet address (C…). */
  wallet: string
  onDone: (result: Extract<ConnectResult, { ok: true; type: 'invoke' }>) => void
  onCancel: () => void
}) {
  const [stage, setStage] = useState<Stage>({ at: 'reading' })

  useEffect(() => {
    let live = true
    previewInvoke(request, wallet)
      .then((preview) => { if (live) setStage({ at: 'review', preview }) })
      .catch((err) => { if (live) setStage({ at: 'stopped', reason: plain(err) }) })
    return () => { live = false }
  }, [request, wallet])

  if (stage.at === 'reading') {
    return (
      <>
        <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontSize: '1.3rem', lineHeight: 1.3 }}>
          Checking what {app.name} is asking for…
        </h1>
        <p style={{ opacity: 0.7 }}>Nothing is sent while Veil checks.</p>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </>
    )
  }

  if (stage.at === 'stopped') {
    return (
      <>
        <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontSize: '1.3rem', lineHeight: 1.3 }}>
          This request did not go through.
        </h1>
        <p role="alert" style={{ opacity: 0.85 }}>{stage.reason}</p>
        <button className="btn-ghost" onClick={onCancel}>Close</button>
      </>
    )
  }

  const { preview } = stage
  const sending = stage.at === 'sending'
  const needsWallet = preview.approvals.some((a) => a.signer === 'wallet')

  const approve = async () => {
    setStage({ at: 'sending', preview })
    try {
      const done = await runInvoke(request, wallet, preview)
      onDone({
        ok: true,
        type: 'invoke',
        hash: done.hash,
        network: getNetworkName(),
        contract: request.contract,
        method: request.method,
        signer: wallet,
        from: done.spending,
        result: done.result,
      })
    } catch (err) {
      setStage({ at: 'stopped', reason: plain(err) })
    }
  }

  return (
    <>
      <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontSize: '1.3rem', lineHeight: 1.3 }}>
        {app.name} asks you to approve an action
      </h1>

      <div>
        <p style={label}>Contract</p>
        <p style={mono}>{request.contract}</p>
      </div>
      <div>
        <p style={label}>Action</p>
        <p style={mono}>{request.method}</p>
      </div>
      {request.args.length > 0 && (
        <div>
          <p style={label}>With these values</p>
          {request.args.map((a, i) => (
            <p key={i} style={mono}>{i + 1}. {a.value} <span style={{ opacity: 0.5 }}>({a.type})</span></p>
          ))}
        </div>
      )}

      <div
        style={{
          border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 12,
          padding: '0.85rem 0.9rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.6rem',
        }}
      >
        <p style={{ fontWeight: 600 }}>
          {preview.movements.length > 0 ? 'Money this will take from you' : 'This does not take any money from you'}
        </p>
        {preview.movements.map((m, i) => (
          <div key={i}>
            <p>
              {m.amount !== null ? `${m.amount} ${m.code}` : `${m.raw.toString()} units of an unverified token`}
              {' from your '}
              {m.from === 'wallet' ? 'wallet' : 'spending account'}
              {m.to === null ? ', destroyed (burned)' : ', sent to'}
            </p>
            {m.to !== null && <p style={mono}>{m.to}</p>}
            {m.amount === null && (
              <>
                <p style={label}>Token contract (Veil does not recognise it, so check it yourself)</p>
                <p style={mono}>{m.token}</p>
              </>
            )}
          </div>
        ))}
        <p style={label}>Network fee: about {preview.feeXlm} XLM, paid from your spending account.</p>
      </div>

      {preview.approvals.length > 0 && (
        <details>
          <summary style={{ cursor: 'pointer', opacity: 0.8 }}>Everything you are approving</summary>
          {preview.approvals.map((a, i) => (
            <div key={i} style={{ marginTop: '0.6rem' }}>
              <p style={label}>As your {a.signer === 'wallet' ? 'wallet' : 'spending account'}</p>
              {a.calls.map((c, j) => (
                <div key={j} style={{ marginLeft: `${c.depth * 0.9}rem`, marginTop: '0.35rem' }}>
                  <p style={mono}>{c.method}({c.args.join(', ')})</p>
                  <p style={{ ...mono, opacity: 0.55 }}>on {c.contract}</p>
                </div>
              ))}
            </div>
          ))}
        </details>
      )}

      <p style={{ opacity: 0.8 }}>
        {needsWallet
          ? 'You will be asked for your fingerprint, face or screen lock. Only approve if you expected this from '
          : 'You will be asked to confirm it is you. Only approve if you expected this from '}
        {app.name}.
      </p>
      <button className="btn-gold" onClick={approve} disabled={sending}>
        {sending ? 'Sending…' : 'Approve'}
      </button>
      <button className="btn-ghost" onClick={onCancel} disabled={sending}>Cancel</button>
    </>
  )
}

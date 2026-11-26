'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { ChevronLeft, ShieldAlert } from 'lucide-react'
import { useInvisibleWallet } from '@veil/sdk'
import { getNetwork, walletConfig } from '@/lib/network'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { formatAmount } from '@/lib/simulate'
import {
  ACTION_LABELS,
  CONTRACT_CAN_REVOKE,
  STOP_REPLACEMENT,
  type Allowance,
  type Replacement,
  availableActions,
  fetchAllowances,
  loadTrackedPairs,
  parseUnits,
  reduceReplacement,
  trackPairs,
} from '@/lib/allowances'
import { knownCandidatePairs, knownSpenders, knownTokens } from '@/lib/allowanceCandidates'

const mono: React.CSSProperties = {
  fontFamily: 'Inconsolata, monospace',
  fontSize: '0.8125rem',
  wordBreak: 'break-all',
  color: 'var(--off-white)',
}
const muted: React.CSSProperties = { fontSize: '0.8125rem', color: 'rgba(246,247,248,0.45)', lineHeight: 1.6 }
const fieldLabel: React.CSSProperties = {
  fontFamily: 'Anton, Impact, sans-serif',
  letterSpacing: '0.06em',
  fontSize: '0.6875rem',
  color: 'rgba(246,247,248,0.45)',
  marginBottom: '0.25rem',
}

const STATUS_STYLE: Record<Allowance['status'], { label: string; color: string }> = {
  active: { label: 'ACTIVE', color: 'var(--gold)' },
  expired: { label: 'EXPIRED', color: 'rgba(246,247,248,0.5)' },
  'used-up': { label: 'USED UP', color: 'rgba(246,247,248,0.5)' },
}

function formatDate(secs: bigint): string {
  return new Date(Number(secs) * 1000).toLocaleString()
}

function explorerUrl(address: string): string {
  const net = getNetwork().name === 'mainnet' ? 'public' : 'testnet'
  const kind = address.startsWith('C') ? 'contract' : 'account'
  return `https://stellar.expert/explorer/${net}/${kind}/${address}`
}

export default function AllowancesPage() {
  const router = useRouter()
  useInactivityLock()
  const wallet = useInvisibleWallet(walletConfig)

  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [allowances, setAllowances] = useState<Allowance[]>([])
  const [loadState, setLoadState] = useState<'loading' | 'ready' | string>('loading')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null)

  const tokens = useMemo(() => knownTokens(), [])
  const spenderLabels = useMemo(
    () => new Map(knownSpenders().map((s) => [s.contractId, s.label])),
    [],
  )
  const tokenInfo = useMemo(() => new Map(tokens.map((t) => [t.contractId, t])), [tokens])

  const load = useCallback(async (address: string) => {
    setLoadState('loading')
    try {
      const pairs = [...loadTrackedPairs(walletLocal, address), ...knownCandidatePairs()]
      setAllowances(await fetchAllowances(getNetwork().rpcUrl, address, pairs))
      setLoadState('ready')
    } catch (e) {
      setLoadState(e instanceof Error ? e.message : 'Could not read spending permissions.')
    }
  }, [])

  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }
    setWalletAddress(addr)
    load(addr)
  }, [router, load])

  function signer(): Keypair {
    const secret = walletSession.getItem('veil_signer_secret')
    if (!secret) throw new Error('No signer key in session')
    return Keypair.fromSecret(secret)
  }

  async function replaceAllowance(a: Allowance, replacement: Replacement, done: string) {
    if (!walletAddress) return
    const id = `${a.spender}:${a.token}`
    setBusyId(id)
    setStatus(null)
    try {
      await wallet.approve(signer(), a.spender, a.token, replacement.amount, replacement.expiry ?? undefined)
      setStatus({ text: done, ok: true })
      await load(walletAddress)
    } catch (e) {
      setStatus({ text: e instanceof Error ? e.message : String(e), ok: false })
    } finally {
      setBusyId(null)
    }
  }

  function checkSpender(spender: string, token: string) {
    if (!walletAddress) return
    trackPairs(walletLocal, walletAddress, [{ spender, token }])
    load(walletAddress)
  }

  return (
    <div className="wallet-shell" style={{ padding: '1.5rem 1.25rem 4rem' }}>
      <div style={{ maxWidth: 480, width: '100%', margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <button
            type="button"
            onClick={() => router.push('/settings')}
            aria-label="Back to settings"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', padding: 0 }}
          >
            <ChevronLeft size={22} strokeWidth={1.75} />
          </button>
          <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.375rem', color: 'var(--off-white)' }}>
            Spending permissions
          </h1>
        </div>

        <p style={{ ...muted, marginBottom: '0.75rem' }}>
          Apps and contracts listed here can move these tokens out of your wallet without asking
          you again, up to the amount shown.
        </p>
        <p style={{ ...muted, marginBottom: '1.5rem' }}>
          Your wallet&apos;s contract keeps no list of the permissions it has given, so this page
          checks the ones this device knows about: permissions you approved here, and the apps
          Veil itself works with. If you approved something in another app, check it below.
        </p>

        {status && (
          <p role="status" style={{ fontSize: '0.8125rem', marginBottom: '1rem', color: status.ok ? 'var(--gold)' : 'rgba(252,165,165,0.9)' }}>
            {status.text}
          </p>
        )}

        {loadState === 'loading' && <p style={muted}>Checking your wallet…</p>}
        {loadState !== 'loading' && loadState !== 'ready' && (
          <p style={{ ...muted, color: 'rgba(252,165,165,0.9)' }}>{loadState}</p>
        )}
        {loadState === 'ready' && allowances.length === 0 && (
          <div className="card"><p style={muted}>No spending permissions found.</p></div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {allowances.map((a) => (
            <AllowanceCard
              key={`${a.spender}:${a.token}`}
              allowance={a}
              spenderLabel={spenderLabels.get(a.spender) ?? null}
              token={tokenInfo.get(a.token) ?? null}
              busy={busyId === `${a.spender}:${a.token}`}
              disabled={busyId !== null}
              onReduce={(r) => replaceAllowance(a, r, 'Limit lowered.')}
              onStop={() => replaceAllowance(a, STOP_REPLACEMENT, 'This permission can no longer move any funds.')}
            />
          ))}
        </div>

        {!CONTRACT_CAN_REVOKE && (
          <p style={{ ...muted, fontSize: '0.75rem', marginTop: '1.25rem' }}>
            Deleting a permission outright needs a wallet contract update that existing wallets
            cannot receive. Until then the strongest option is <em>Stop it now</em>, which leaves the
            record on your wallet but stops it moving any funds.
          </p>
        )}

        <CheckSpender tokens={tokens} onCheck={checkSpender} />
      </div>
    </div>
  )
}

function AllowanceCard(props: {
  allowance: Allowance
  spenderLabel: string | null
  token: { code: string; decimals: number } | null
  busy: boolean
  disabled: boolean
  onReduce: (replacement: Replacement) => void
  onStop: () => void
}) {
  const { allowance: a, spenderLabel, token, busy, disabled } = props
  const [mode, setMode] = useState<'idle' | 'reduce' | 'stop'>('idle')
  const [input, setInput] = useState('')
  const decimals = token?.decimals ?? 0
  const amountText = token ? `${formatAmount(a.amount, decimals)} ${token.code}` : `${a.amount.toString()} base units`
  const badge = STATUS_STYLE[a.status]
  const actions = availableActions(a)

  const parsed = parseUnits(input, decimals)
  const replacement = parsed === null ? null : reduceReplacement(a, parsed)
  const reduceError =
    input.trim() === ''
      ? null
      : replacement === null
        ? `Enter an amount with at most ${decimals} decimal places.`
        : 'error' in replacement
          ? replacement.error
          : null

  return (
    <div className="card" style={{ border: `1px solid ${a.status === 'active' ? 'var(--border-dim)' : 'rgba(246,247,248,0.08)'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>{spenderLabel ?? 'Spender'}</p>
        <span style={{ fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', fontSize: '0.6875rem', color: badge.color }}>
          {badge.label}
        </span>
      </div>

      <p style={fieldLabel}>SPENDER</p>
      <a href={explorerUrl(a.spender)} target="_blank" rel="noreferrer" style={{ ...mono, display: 'block', marginBottom: '0.75rem', color: 'var(--gold)' }}>
        {a.spender}
      </a>

      <p style={fieldLabel}>TOKEN</p>
      <p style={{ ...mono, marginBottom: '0.75rem' }}>
        {token ? <span style={{ fontWeight: 600 }}>{token.code} </span> : null}
        {a.token}
      </p>

      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
        <div>
          <p style={fieldLabel}>{a.status === 'active' ? 'CAN STILL MOVE' : 'REMAINING'}</p>
          <p style={{ fontSize: '0.9375rem' }}>{amountText}</p>
        </div>
        <div>
          <p style={fieldLabel}>EXPIRES</p>
          <p style={{ fontSize: '0.9375rem' }}>
            {a.expiry === null ? 'Never' : a.status === 'expired' ? `Expired ${formatDate(a.expiry)}` : formatDate(a.expiry)}
          </p>
        </div>
      </div>

      {a.status === 'used-up' && (
        <p style={muted}>Fully spent. It cannot move anything unless this wallet approves it again.</p>
      )}
      {a.status === 'expired' && (
        <p style={muted}>Past its expiry, so it cannot move anything. It is still recorded on your wallet.</p>
      )}
      {a.archived && (
        <p style={muted}>
          Archived on the ledger to save space. It is still valid: it can be restored and used.
        </p>
      )}

      {actions.length > 0 && mode === 'idle' && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              className={action === 'stop' ? 'btn-gold' : 'btn-ghost'}
              disabled={disabled}
              onClick={() => setMode(action)}
            >
              {ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      )}

      {actions.includes('reduce') && mode === 'reduce' && (
        <div style={{ marginTop: '0.75rem' }}>
          <label style={fieldLabel} htmlFor={`reduce-${a.spender}-${a.token}`}>NEW LIMIT</label>
          <input
            id={`reduce-${a.spender}-${a.token}`}
            inputMode="decimal"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={token ? `Less than ${formatAmount(a.amount, decimals)}` : 'Base units'}
            style={{ width: '100%', marginBottom: '0.5rem' }}
          />
          <p style={{ ...muted, fontSize: '0.75rem' }}>
            {a.expiry === null ? 'It will still never expire.' : `It keeps its expiry, ${formatDate(a.expiry)}.`}
          </p>
          {reduceError && <p style={{ ...muted, color: 'rgba(252,165,165,0.9)' }}>{reduceError}</p>}
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setMode('idle'); setInput('') }}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-gold"
              disabled={busy || replacement === null || 'error' in replacement}
              onClick={() => replacement && !('error' in replacement) && props.onReduce(replacement)}
            >
              {busy ? 'Confirm with your passkey…' : ACTION_LABELS.reduce}
            </button>
          </div>
        </div>
      )}

      {actions.includes('stop') && mode === 'stop' && (
        <div style={{ marginTop: '0.75rem' }}>
          <p style={{ ...muted, display: 'flex', gap: '0.5rem' }}>
            <ShieldAlert size={16} color="var(--gold)" style={{ flexShrink: 0, marginTop: '0.2rem' }} />
            <span>
              This replaces the permission with the smallest possible amount and an expiry in the
              past, so this spender can no longer move any {token?.code ?? 'of this token'} from
              your wallet. The record stays on your wallet&apos;s contract; this version of the
              contract cannot delete it.
            </span>
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => setMode('idle')}>
              Cancel
            </button>
            <button type="button" className="btn-gold" disabled={busy} onClick={props.onStop}>
              {busy ? 'Confirm with your passkey…' : ACTION_LABELS.stop}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CheckSpender(props: {
  tokens: { contractId: string; code: string }[]
  onCheck: (spender: string, token: string) => void
}) {
  const [spender, setSpender] = useState('')
  const [token, setToken] = useState(props.tokens[0]?.contractId ?? '')
  const [otherToken, setOtherToken] = useState('')
  const tokenId = token === 'other' ? otherToken.trim() : token
  const spenderOk = StrKey.isValidContract(spender.trim()) || StrKey.isValidEd25519PublicKey(spender.trim())
  const tokenOk = StrKey.isValidContract(tokenId)

  return (
    <div className="card" style={{ marginTop: '1.5rem' }}>
      <p style={{ fontWeight: 500, fontSize: '0.9375rem', marginBottom: '0.25rem' }}>Check another spender</p>
      <p style={{ ...muted, marginBottom: '0.75rem' }}>
        Paste the full address of an app or contract you may have approved.
      </p>
      <label style={fieldLabel} htmlFor="check-spender">SPENDER ADDRESS</label>
      <input
        id="check-spender"
        value={spender}
        onChange={(e) => setSpender(e.target.value)}
        placeholder="C… or G…"
        style={{ width: '100%', marginBottom: '0.5rem', fontFamily: 'Inconsolata, monospace' }}
      />
      <label style={fieldLabel} htmlFor="check-token">TOKEN</label>
      <select id="check-token" value={token} onChange={(e) => setToken(e.target.value)} style={{ width: '100%', marginBottom: '0.5rem' }}>
        {props.tokens.map((t) => (
          <option key={t.contractId} value={t.contractId}>{t.code}</option>
        ))}
        <option value="other">Other token contract…</option>
      </select>
      {token === 'other' && (
        <input
          aria-label="Token contract address"
          value={otherToken}
          onChange={(e) => setOtherToken(e.target.value)}
          placeholder="Token contract address (C…)"
          style={{ width: '100%', marginBottom: '0.5rem', fontFamily: 'Inconsolata, monospace' }}
        />
      )}
      <button
        type="button"
        className="btn-ghost"
        disabled={!spenderOk || !tokenOk}
        onClick={() => { props.onCheck(spender.trim(), tokenId); setSpender('') }}
      >
        Check
      </button>
    </div>
  )
}

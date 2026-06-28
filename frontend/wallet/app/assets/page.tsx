'use client'

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { Horizon, Keypair } from '@stellar/stellar-sdk'

import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { requirePasskey } from '@/lib/passkeyAuth'
import {
  buildChangeTrustTx,
  canRemoveTrustline,
  hasTrustline,
  parseTrustlines,
  resolveAnchorAssets,
  type AnchorAsset,
  type HorizonBalanceLike,
  type Trustline,
} from '@/lib/trustlines'

const Server = Horizon.Server
const network = getNetwork()

function getSignerSecret(): string | null {
  return (
    sessionStorage.getItem('veil_signer_secret') ||
    localStorage.getItem('veil_signer_secret')
  )
}

type Status = { kind: 'idle' | 'busy' | 'error' | 'success'; message?: string }

export default function AssetsPage() {
  const router = useRouter()
  useInactivityLock()

  const server = useMemo(() => new Server(network.horizonUrl), [])

  const [signerAddress, setSignerAddress] = useState<string | null>(null)
  const [balances, setBalances] = useState<HorizonBalanceLike[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  // Add-asset form
  const [domain, setDomain] = useState('')
  const [anchorAssets, setAnchorAssets] = useState<AnchorAsset[]>([])
  const [searching, setSearching] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [manualIssuer, setManualIssuer] = useState('')

  const trustlines: Trustline[] = useMemo(() => parseTrustlines(balances), [balances])

  const loadAccount = useCallback(async () => {
    setLoading(true)
    try {
      const secret = getSignerSecret()
      if (!secret) {
        setStatus({ kind: 'error', message: 'Wallet is locked. Unlock it to manage assets.' })
        setLoading(false)
        return
      }
      const pubKey = Keypair.fromSecret(secret).publicKey()
      setSignerAddress(pubKey)
      const account = await server.loadAccount(pubKey)
      setBalances(account.balances as unknown as HorizonBalanceLike[])
    } catch (err) {
      setStatus({ kind: 'error', message: errorMessage(err) })
    } finally {
      setLoading(false)
    }
  }, [server])

  useEffect(() => {
    void loadAccount()
  }, [loadAccount])

  const submitChangeTrust = useCallback(
    async (code: string, issuer: string, remove: boolean) => {
      setStatus({ kind: 'busy', message: remove ? 'Removing trustline…' : 'Adding trustline…' })
      try {
        await requirePasskey()
        const secret = getSignerSecret()
        if (!secret) throw new Error('Signing key not found. Unlock the wallet again.')

        const signer = Keypair.fromSecret(secret)
        const account = await server.loadAccount(signer.publicKey())
        const tx = buildChangeTrustTx({
          account,
          networkPassphrase: network.networkPassphrase,
          code,
          issuer,
          remove,
        })
        tx.sign(signer)
        await server.submitTransaction(tx)

        setStatus({
          kind: 'success',
          message: remove ? `Removed trustline for ${code}.` : `Now trusting ${code}.`,
        })
        await loadAccount()
      } catch (err) {
        setStatus({ kind: 'error', message: errorMessage(err) })
      }
    },
    [server, loadAccount],
  )

  const handleSearch = useCallback(async () => {
    setSearching(true)
    setAnchorAssets([])
    setStatus({ kind: 'idle' })
    try {
      const assets = await resolveAnchorAssets(domain)
      setAnchorAssets(assets)
      if (assets.length === 0) {
        setStatus({ kind: 'error', message: `No assets found in ${domain || 'that domain'}'s stellar.toml.` })
      }
    } catch (err) {
      setStatus({ kind: 'error', message: `Could not read stellar.toml: ${errorMessage(err)}` })
    } finally {
      setSearching(false)
    }
  }, [domain])

  const handleManualAdd = useCallback(() => {
    const code = manualCode.trim()
    const issuer = manualIssuer.trim()
    if (!code || !issuer) {
      setStatus({ kind: 'error', message: 'Enter both an asset code and issuer address.' })
      return
    }
    void submitChangeTrust(code, issuer, false)
  }, [manualCode, manualIssuer, submitChangeTrust])

  const busy = status.kind === 'busy'

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button onClick={() => router.push('/dashboard')} style={backButtonStyle}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Dashboard
        </button>
        <p style={navTitleStyle}>ASSETS</p>
        <button onClick={() => void loadAccount()} title="Refresh" style={{ ...backButtonStyle, color: 'rgba(246,247,248,0.55)' }}>
          Refresh
        </button>
      </nav>

      <main className="wallet-main">
        <div style={{ marginBottom: '1.5rem' }}>
          <p style={eyebrowStyle}>TRUSTLINES</p>
          <h1 style={headingStyle}>Manage the assets you hold</h1>
          <p style={{ color: 'rgba(246,247,248,0.52)', fontSize: '0.875rem', lineHeight: 1.6, maxWidth: 460 }}>
            Classic Stellar assets need a trustline before they can be received. Add one from an
            anchor&apos;s stellar.toml or by issuer, and remove any you no longer need.
          </p>
        </div>

        {status.message && (
          <div
            className="card"
            role={status.kind === 'error' ? 'alert' : undefined}
            style={{
              marginBottom: '1rem',
              borderColor: status.kind === 'error' ? 'rgba(229,72,77,0.4)' : 'rgba(0,167,181,0.24)',
              background: status.kind === 'error' ? 'rgba(229,72,77,0.07)' : 'rgba(0,167,181,0.06)',
            }}
          >
            <p style={{ fontSize: '0.875rem', color: 'var(--off-white)' }}>{status.message}</p>
          </div>
        )}

        {/* Existing trustlines */}
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeadingStyle}>Your trustlines</h2>
          {loading ? (
            <p style={mutedTextStyle}>Loading…</p>
          ) : trustlines.length === 0 ? (
            <p style={mutedTextStyle}>No trustlines yet. Add one below.</p>
          ) : (
            trustlines.map((line) => (
              <div key={`${line.code}-${line.issuer}`} className="card" style={trustlineRowStyle}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontWeight: 600, color: 'var(--off-white)' }}>{line.code}</p>
                  <p style={{ ...mutedTextStyle, fontFamily: 'monospace', fontSize: '0.7rem', wordBreak: 'break-all' }}>
                    {line.issuer}
                  </p>
                  <p style={mutedTextStyle}>Balance: {line.balance}</p>
                </div>
                <button
                  onClick={() => void submitChangeTrust(line.code, line.issuer, true)}
                  disabled={busy || !canRemoveTrustline(line)}
                  title={canRemoveTrustline(line) ? 'Remove trustline' : 'Balance must be zero to remove'}
                  style={removeButtonStyle(busy || !canRemoveTrustline(line))}
                >
                  Remove
                </button>
              </div>
            ))
          )}
        </section>

        {/* Add by anchor domain */}
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeadingStyle}>Add from an anchor</h2>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="anchor domain, e.g. centre.io"
              style={inputStyle}
              aria-label="Anchor domain"
            />
            <button onClick={() => void handleSearch()} disabled={searching || !domain.trim()} style={primaryButtonStyle(searching || !domain.trim())}>
              {searching ? 'Searching…' : 'Search'}
            </button>
          </div>
          {anchorAssets.map((asset) => {
            const already = hasTrustline(balances, asset.code, asset.issuer)
            return (
              <div key={`${asset.code}-${asset.issuer}`} className="card" style={trustlineRowStyle}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontWeight: 600, color: 'var(--off-white)' }}>{asset.code}</p>
                  <p style={{ ...mutedTextStyle, fontFamily: 'monospace', fontSize: '0.7rem', wordBreak: 'break-all' }}>
                    {asset.issuer}
                  </p>
                </div>
                <button
                  onClick={() => void submitChangeTrust(asset.code, asset.issuer, false)}
                  disabled={busy || already}
                  style={primaryButtonStyle(busy || already)}
                >
                  {already ? 'Added' : 'Add'}
                </button>
              </div>
            )
          })}
        </section>

        {/* Add manually */}
        <section>
          <h2 style={sectionHeadingStyle}>Add by issuer</h2>
          <input
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            placeholder="Asset code, e.g. USDC"
            style={{ ...inputStyle, marginBottom: '0.5rem' }}
            aria-label="Asset code"
          />
          <input
            value={manualIssuer}
            onChange={(e) => setManualIssuer(e.target.value)}
            placeholder="Issuer address (G…)"
            style={{ ...inputStyle, marginBottom: '0.75rem' }}
            aria-label="Issuer address"
          />
          <button onClick={handleManualAdd} disabled={busy} style={primaryButtonStyle(busy)}>
            Add trustline
          </button>
        </section>
      </main>
    </div>
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const backButtonStyle: CSSProperties = {
  background: 'none',
  border: 'none',
  cursor: 'pointer',
  color: 'var(--off-white)',
  display: 'flex',
  alignItems: 'center',
  gap: '0.375rem',
  fontSize: '0.875rem',
}

const navTitleStyle: CSSProperties = {
  fontSize: '0.75rem',
  fontFamily: 'Anton, Impact, sans-serif',
  letterSpacing: '0.08em',
  color: 'var(--warm-grey)',
}

const eyebrowStyle: CSSProperties = {
  fontSize: '0.75rem',
  fontFamily: 'Anton, Impact, sans-serif',
  color: 'var(--warm-grey)',
  letterSpacing: '0.08em',
  marginBottom: '0.5rem',
}

const headingStyle: CSSProperties = {
  fontFamily: 'Lora, Georgia, serif',
  fontWeight: 600,
  fontStyle: 'italic',
  fontSize: '1.9rem',
  lineHeight: 1.1,
  marginBottom: '0.5rem',
}

const sectionHeadingStyle: CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 600,
  color: 'var(--off-white)',
  marginBottom: '0.75rem',
}

const mutedTextStyle: CSSProperties = {
  color: 'var(--warm-grey)',
  fontSize: '0.8125rem',
}

const trustlineRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '1rem',
  marginBottom: '0.5rem',
}

const inputStyle: CSSProperties = {
  flex: 1,
  width: '100%',
  background: 'var(--near-black)',
  border: '1px solid var(--border-dim)',
  borderRadius: '0.5rem',
  padding: '0.625rem 0.75rem',
  color: 'var(--off-white)',
  fontSize: '0.875rem',
}

function primaryButtonStyle(disabled: boolean): CSSProperties {
  return {
    background: disabled ? 'rgba(246,247,248,0.1)' : 'var(--gold)',
    color: disabled ? 'var(--warm-grey)' : 'var(--near-black)',
    border: 'none',
    borderRadius: '0.5rem',
    padding: '0.625rem 1rem',
    fontWeight: 600,
    fontSize: '0.875rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap',
  }
}

function removeButtonStyle(disabled: boolean): CSSProperties {
  return {
    background: 'none',
    border: '1px solid var(--border-dim)',
    borderRadius: '0.5rem',
    padding: '0.5rem 0.875rem',
    color: disabled ? 'var(--warm-grey)' : '#e5484d',
    fontSize: '0.8125rem',
    cursor: disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap',
  }
}

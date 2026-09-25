'use client'

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { Horizon, Keypair } from '@stellar/stellar-sdk'

import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { requirePasskey } from '@/lib/passkeyAuth'
import {
  buildChangeTrustTx,
  calculateSpendableAfterTrustline,
  canRemoveTrustline,
  getRemovalRefusalReason,
  hasTrustline,
  parseTrustlines,
  resolveAnchorAssets,
  TRUSTLINE_RESERVE_XLM,
  type AnchorAsset,
  type HorizonBalanceLike,
  type Trustline,
} from '@/lib/trustlines'
import { spendableNativeXlm, type HorizonAccountLike } from '@/lib/reserves'
import { walletLocal, walletSession } from '@/lib/walletStorage'

import { USDY_MAINNET_ISSUER, getRegisteredAsset, isRegisteredIssuer } from '@/lib/assets'
import { fetchPrice } from '@/lib/fetchPrice'
import {
  ISSUER_TOML_TTL_MS,
  letterAvatar,
  loadRegisteredIssuerMetadata,
  type IssuerTomlMetadata,
} from '@/lib/issuerToml'

const Server = Horizon.Server
const network = getNetwork()

function getSignerSecret(): string | null {
  return (
    walletSession.getItem('veil_signer_secret') ||
    walletLocal.getItem('veil_signer_secret')
  )
}

type Status = { kind: 'idle' | 'busy' | 'error' | 'success'; message?: string }

export default function AssetsPage() {
  const router = useRouter()
  useInactivityLock()

  const server = useMemo(() => new Server(network.horizonUrl), [])

  const [signerAddress, setSignerAddress] = useState<string | null>(null)
  const [balances, setBalances] = useState<HorizonBalanceLike[]>([])
  const [spendableXlm, setSpendableXlm] = useState<string>('0')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [prices, setPrices] = useState<Record<string, number | null>>({})
  const [issuerMeta, setIssuerMeta] = useState<Record<string, IssuerTomlMetadata>>({})

  // Add-asset form
  const [domain, setDomain] = useState('')
  const [anchorAssets, setAnchorAssets] = useState<AnchorAsset[]>([])
  const [searching, setSearching] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [manualIssuer, setManualIssuer] = useState('')
  const [pendingAsset, setPendingAsset] = useState<{ code: string; issuer: string } | null>(null)

  const trustlines: Trustline[] = useMemo(() => parseTrustlines(balances), [balances])

  const metadataTargets = useMemo(() => {
    const targets = new Map<string, { code: string; issuer: string }>()
    for (const line of trustlines) {
      if (!isRegisteredIssuer(line.code, line.issuer)) continue
      targets.set(`${line.code}:${line.issuer}`, { code: line.code, issuer: line.issuer })
    }
    if (network.name === 'mainnet') {
      targets.set(`USDY:${USDY_MAINNET_ISSUER}`, { code: 'USDY', issuer: USDY_MAINNET_ISSUER })
    }
    return [...targets.values()]
  }, [trustlines])

  useEffect(() => {
    let cancelled = false
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    for (const target of metadataTargets) {
      const key = `${target.code}:${target.issuer}`
      const refresh = async () => {
        const meta = await loadRegisteredIssuerMetadata(target.code, target.issuer)
        if (cancelled || !meta) return
        setIssuerMeta((current) => ({ ...current, [key]: meta }))
        // Retry stale/offline results in a minute; fresh data refreshes at expiry.
        const delay = Math.max(60_000, (meta.fetchedAt ?? 0) + ISSUER_TOML_TTL_MS - Date.now())
        timers.set(key, setTimeout(() => void refresh(), delay))
      }
      void refresh()
    }
    return () => {
      cancelled = true
      timers.forEach(clearTimeout)
    }
  }, [metadataTargets])

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
      const rawBalances = account.balances as unknown as HorizonBalanceLike[]
      setBalances(rawBalances)
      setSpendableXlm(spendableNativeXlm(account as unknown as HorizonAccountLike))

      const parsedLines = parseTrustlines(rawBalances)
      const priceMap: Record<string, number | null> = {}
      await Promise.all(
        parsedLines.map(async (line) => {
          priceMap[`${line.code}:${line.issuer}`] = await fetchPrice(line.code, line.issuer)
        }),
      )
      setPrices(priceMap)
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
      setStatus({ kind: 'busy', message: remove ? 'Removing trustline and reclaiming 0.5 XLM reserve…' : 'Adding trustline and locking 0.5 XLM reserve…' })
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
        const res = await server.submitTransaction(tx)

        setStatus({
          kind: 'success',
          message: remove
            ? `Removed trustline for ${code}. 0.5 XLM reserve returned to your spendable balance! (Tx: ${res.hash.slice(0, 8)}…)`
            : `Now trusting ${code}. 0.5 XLM locked as reserve. (Tx: ${res.hash.slice(0, 8)}…)`,
        })
        setPendingAsset(null)
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
    const code = manualCode.trim().toUpperCase()
    const issuer = manualIssuer.trim()
    if (!code || !issuer) {
      setStatus({ kind: 'error', message: 'Enter both an asset code and issuer address.' })
      return
    }
    setPendingAsset({ code, issuer })
  }, [manualCode, manualIssuer])

  const busy = status.kind === 'busy'
  const hasUsdy = hasTrustline(balances, 'USDY', USDY_MAINNET_ISSUER)
  const usdyImpact = calculateSpendableAfterTrustline(spendableXlm, 1)
  const pendingImpact = pendingAsset ? calculateSpendableAfterTrustline(spendableXlm, 1) : null

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
          <p style={eyebrowStyle}>TRUSTLINES &amp; RESERVES</p>
          <h1 style={headingStyle}>Manage the assets you hold</h1>
          <p style={{ color: 'rgba(246,247,248,0.52)', fontSize: '0.875rem', lineHeight: 1.6, maxWidth: 460 }}>
            Classic Stellar assets need a trustline before they can be received. Each trustline locks <strong>0.5 XLM</strong> of refundable base reserve. Removing an empty trustline returns its 0.5 XLM to your spendable balance.
          </p>
          <div style={{ marginTop: '0.75rem', display: 'inline-flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(246,247,248,0.06)', padding: '0.375rem 0.75rem', borderRadius: '0.5rem', fontSize: '0.8125rem', color: 'var(--off-white)' }}>
            <span style={{ color: 'var(--warm-grey)' }}>Spendable XLM:</span>
            <strong>{spendableXlm} XLM</strong>
          </div>
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

        {/* Confirmation Modal / Breakdown before enabling any asset */}
        {pendingAsset && pendingImpact && (
          <div className="card" style={{ marginBottom: '1.5rem', border: '1px solid var(--gold)', background: 'rgba(212,175,55,0.08)', padding: '1.25rem' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--gold)', marginBottom: '0.5rem' }}>
              Confirm Enabling {pendingAsset.code}
            </h3>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.7)', marginBottom: '0.75rem' }}>
              Adding this trustline locks <strong>0.5 XLM</strong> in Stellar base reserve. You can remove it anytime when its balance is zero to reclaim this 0.5 XLM.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', background: 'rgba(0,0,0,0.25)', padding: '0.75rem', borderRadius: '0.5rem', marginBottom: '0.75rem', fontSize: '0.8125rem' }}>
              <div>
                <p style={{ color: 'var(--warm-grey)' }}>Reserve cost:</p>
                <p style={{ fontWeight: 600, color: '#e5484d' }}>-0.5 XLM (locked)</p>
              </div>
              <div>
                <p style={{ color: 'var(--warm-grey)' }}>Spendable now:</p>
                <p style={{ fontWeight: 600, color: 'var(--off-white)' }}>{pendingImpact.currentSpendable} XLM</p>
              </div>
              <div style={{ gridColumn: '1 / -1', borderTop: '1px solid rgba(246,247,248,0.1)', paddingTop: '0.5rem' }}>
                <p style={{ color: 'var(--warm-grey)' }}>Spendable balance after enabling:</p>
                <p style={{ fontWeight: 600, color: pendingImpact.canAfford ? 'var(--teal)' : '#e5484d' }}>
                  {pendingImpact.projectedSpendable} XLM {!pendingImpact.canAfford ? '(Insufficient balance)' : ''}
                </p>
              </div>
            </div>

            {!pendingImpact.canAfford && (
              <p style={{ color: '#e5484d', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>
                You do not have enough spendable XLM to fund the 0.5 XLM reserve. Top up your wallet with XLM first.
              </p>
            )}

            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => void submitChangeTrust(pendingAsset.code, pendingAsset.issuer, false)}
                disabled={busy || !pendingImpact.canAfford}
                style={primaryButtonStyle(busy || !pendingImpact.canAfford)}
              >
                {busy ? 'Enabling…' : 'Confirm & Enable (locks 0.5 XLM)'}
              </button>
              <button
                onClick={() => setPendingAsset(null)}
                disabled={busy}
                style={removeButtonStyle(busy)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Featured USDY enable card. Mainnet only — USDY's issuer does not
            exist on testnet, where changeTrust would fail with op_no_issuer. */}
        {!hasUsdy && !loading && network.name === 'mainnet' && (
          <section className="card" style={{ marginBottom: '2rem', padding: '1.25rem', borderColor: 'rgba(212,175,55,0.3)', background: 'rgba(212,175,55,0.05)' }}>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
              <RegisteredAssetMark code="USDY" meta={issuerMeta[`USDY:${USDY_MAINNET_ISSUER}`]} />
              <div style={{ minWidth: 0 }}>
                <h2 style={{ ...sectionHeadingStyle, color: 'var(--gold)' }}>Featured Asset: USDY (Ondo US Dollar Yield)</h2>
                <p style={{ color: 'rgba(246,247,248,0.7)', fontSize: '0.85rem', marginBottom: '0.5rem' }}>
                  Ondo&apos;s US Treasuries-backed, yield-bearing token.
                </p>
                <div style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
                  <p>• Reserve cost: <strong>0.5 XLM</strong> (locked, returned when removed)</p>
                  <p>• Spendable now: <strong>{spendableXlm} XLM</strong> &rarr; After enabling: <strong>{usdyImpact.projectedSpendable} XLM</strong></p>
                </div>
                {issuerMeta[`USDY:${USDY_MAINNET_ISSUER}`]?.description ? (
                  <p style={{ ...clampedNoteStyle, marginBottom: '0.75rem' }}>
                    {issuerMeta[`USDY:${USDY_MAINNET_ISSUER}`].description}
                  </p>
                ) : null}
              </div>
            </div>
            <button
              onClick={() => setPendingAsset({ code: 'USDY', issuer: USDY_MAINNET_ISSUER })}
              disabled={busy || !usdyImpact.canAfford}
              style={primaryButtonStyle(busy || !usdyImpact.canAfford)}
            >
              {busy ? 'Enabling USDY…' : !usdyImpact.canAfford ? 'Insufficient XLM (needs 0.5 XLM reserve)' : 'Enable USDY (0.5 XLM reserve)'}
            </button>
          </section>
        )}

        {/* Existing trustlines */}
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeadingStyle}>Your trustlines</h2>
          {loading ? (
            <p style={mutedTextStyle}>Loading…</p>
          ) : trustlines.length === 0 ? (
            <p style={mutedTextStyle}>No trustlines yet. Add one below.</p>
          ) : (
            trustlines.map((line) => {
              const price = prices[`${line.code}:${line.issuer}`]
              const usdVal = price != null ? Number(line.balance) * price : null
              const meta = issuerMeta[`${line.code}:${line.issuer}`]
              const registered = isRegisteredIssuer(line.code, line.issuer) && getRegisteredAsset(line.code)?.code === line.code
                ? getRegisteredAsset(line.code)
                : null
              const canRemove = canRemoveTrustline(line)
              const refusalReason = getRemovalRefusalReason(line)

              return (
                <div key={`${line.code}-${line.issuer}`} className="card" style={trustlineRowStyle}>
                  <div style={{ display: 'flex', gap: '0.75rem', minWidth: 0, alignItems: 'center' }}>
                    {registered ? <RegisteredAssetMark code={line.code} meta={meta} /> : null}
                    <div style={{ minWidth: 0 }}>
                      <p style={{ fontWeight: 600, color: 'var(--off-white)' }}>
                        {line.code}
                        {meta && meta.name !== line.code ? (
                          <span style={{ fontWeight: 400, color: 'var(--warm-grey)' }}> · {meta.name}</span>
                        ) : null}
                      </p>
                      {registered ? (
                        <p style={mutedTextStyle}>Issuer: {registered.issuerName}</p>
                      ) : null}
                      {meta?.description ? (
                        <p style={clampedNoteStyle}>{meta.description}</p>
                      ) : null}
                      <p style={{ ...mutedTextStyle, fontFamily: 'monospace', fontSize: '0.7rem', wordBreak: 'break-all' }}>
                        {line.issuer}
                      </p>
                      <p style={mutedTextStyle}>
                        Balance: {line.balance} {usdVal != null ? `(~$${usdVal.toFixed(2)} USD)` : ''}
                      </p>
                      <p style={{ ...mutedTextStyle, color: 'var(--gold)', marginTop: '0.25rem' }}>
                        Locked reserve: 0.5 XLM (returns to spendable balance upon removal)
                      </p>
                      {refusalReason && (
                        <p style={{ fontSize: '0.75rem', color: '#e5484d', marginTop: '0.25rem' }}>
                          {refusalReason}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => void submitChangeTrust(line.code, line.issuer, true)}
                    disabled={busy || !canRemove}
                    title={canRemove ? 'Remove trustline and reclaim 0.5 XLM reserve' : refusalReason || 'Balance must be zero to remove'}
                    style={removeButtonStyle(busy || !canRemove)}
                  >
                    {canRemove ? 'Remove (reclaim 0.5 XLM)' : 'Remove'}
                  </button>
                </div>
              )
            })
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
                  onClick={() => setPendingAsset({ code: asset.code, issuer: asset.issuer })}
                  disabled={busy || already}
                  style={primaryButtonStyle(busy || already)}
                >
                  {already ? 'Added' : 'Add (0.5 XLM reserve)'}
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

function RegisteredAssetMark({ code, meta }: { code: string; meta?: IssuerTomlMetadata }) {
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)
  if (meta?.imageUrl && meta.imageUrl !== brokenUrl) {
    return (
      <img
        src={meta.imageUrl}
        alt=""
        width={36}
        height={36}
        onError={() => setBrokenUrl(meta.imageUrl)}
        style={{ width: 36, height: 36, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
      />
    )
  }
  return (
    <span aria-hidden="true" style={letterMarkStyle}>
      {letterAvatar(code)}
    </span>
  )
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

const clampedNoteStyle: CSSProperties = {
  ...mutedTextStyle,
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
}

const letterMarkStyle: CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(246,247,248,0.08)',
  color: 'var(--off-white)',
  fontWeight: 700,
  fontSize: '0.95rem',
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

'use client'

import { useState, useEffect, useCallback, type CSSProperties } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'

import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import {
  fetchAnchorToml,
  authenticateSep10,
  VERIFIED_ASSET_REGISTRY,
  type DiscoveredAnchorInfo,
  type DiscoveredCurrency,
} from '@/lib/anchorDirectory'
import { initiateDeposit, initiateWithdraw } from '@/lib/sep24'
import { AnchorDirectoryModal } from '@/components/AnchorDirectoryModal'

const FEATURED_ANCHORS = ['testanchor.stellar.org', 'ondo.finance', 'centre.io']

export default function InvestPage() {
  const router = useRouter()
  useInactivityLock()
  const network = getNetwork()

  const [domainInput, setDomainInput] = useState('testanchor.stellar.org')
  const [loading, setLoading] = useState(false)
  const [anchorInfo, setAnchorInfo] = useState<DiscoveredAnchorInfo | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  // SEP-24 Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [interactiveUrl, setInteractiveUrl] = useState<string | null>(null)
  const [flowTitle, setFlowTitle] = useState('Anchor Flow')

  const [accountAddress, setAccountAddress] = useState<string | null>(null)

  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    if (!addr) {
      router.replace('/lock')
      return
    }

    const signerSecret =
      walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    const signerPublic = walletLocal.getItem('veil_signer_public_key')

    if (!signerSecret && !signerPublic) {
      setErrorMsg('Signing key not found. Please unlock your wallet.')
      return
    }

    const resolvedAddress = signerSecret
      ? Keypair.fromSecret(signerSecret).publicKey()
      : signerPublic!

    setAccountAddress(resolvedAddress)
    void handleDiscover(domainInput)
  }, [router])

  const handleDiscover = useCallback(async (domainToSearch: string) => {
    setLoading(true)
    setErrorMsg(null)
    setStatusMsg(null)
    try {
      const info = await fetchAnchorToml(domainToSearch)
      setAnchorInfo(info)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setAnchorInfo(null)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleSep24Flow = useCallback(
    async (asset: DiscoveredCurrency, mode: 'deposit' | 'withdraw') => {
      if (!anchorInfo) return
      setErrorMsg(null)
      setStatusMsg(`Authenticating with ${anchorInfo.homeDomain} via SEP-10…`)

      const signerSecret =
        walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')

      if (!signerSecret) {
        setErrorMsg('Secret key required for SEP-10 signing. Unlock wallet again.')
        setStatusMsg(null)
        return
      }

      if (!accountAddress) {
        setErrorMsg('Account address not found.')
        setStatusMsg(null)
        return
      }

      try {
        const userKp = Keypair.fromSecret(signerSecret)
        const webAuthEndpoint = anchorInfo.webAuthEndpoint

        let jwt: string | undefined = undefined
        if (webAuthEndpoint) {
          jwt = await authenticateSep10({
            webAuthEndpoint,
            account: accountAddress,
            networkPassphrase: anchorInfo.networkPassphrase || network.networkPassphrase,
            signerKeypair: userKp,
          })
        }

        const transferServer = anchorInfo.transferServerSep24
        if (!transferServer) {
          throw new Error(`Anchor ${anchorInfo.homeDomain} does not declare TRANSFER_SERVER_SEP0024`)
        }

        setStatusMsg(`Initiating ${mode} flow for ${asset.code}…`)

        const result =
          mode === 'deposit'
            ? await initiateDeposit(
                transferServer,
                { assetCode: asset.code, account: accountAddress },
                jwt,
              )
            : await initiateWithdraw(
                transferServer,
                { assetCode: asset.code, account: accountAddress },
                jwt,
              )

        setInteractiveUrl(result.url)
        setFlowTitle(`${mode === 'deposit' ? 'Deposit' : 'Withdraw'} ${asset.code} (${anchorInfo.homeDomain})`)
        setModalOpen(true)
        setStatusMsg(null)
      } catch (err) {
        setErrorMsg(`SEP-24 error: ${err instanceof Error ? err.message : String(err)}`)
        setStatusMsg(null)
      }
    },
    [anchorInfo, accountAddress, network.networkPassphrase],
  )

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button onClick={() => router.push('/dashboard')} style={backButtonStyle}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Dashboard
        </button>
        <p style={navTitleStyle}>INVEST & ANCHORS</p>
        <button onClick={() => void handleDiscover(domainInput)} style={{ ...backButtonStyle, color: 'rgba(246,247,248,0.55)' }}>
          Refresh
        </button>
      </nav>

      <main className="wallet-main">
        <div style={{ marginBottom: '1.5rem' }}>
          <p style={eyebrowStyle}>ANCHOR DIRECTORY</p>
          <h1 style={headingStyle}>Discover & Invest Assets</h1>
          <p style={{ color: 'rgba(246,247,248,0.52)', fontSize: '0.875rem', lineHeight: 1.6, maxWidth: 480 }}>
            Read an issuer&apos;s stellar.toml (SEP-1) for verified assets and endpoints. Connect to hosted deposit and withdrawal flows authenticated with SEP-10.
          </p>
        </div>

        {errorMsg && (
          <div className="card" style={errorCardStyle}>
            <p style={{ fontSize: '0.875rem', color: '#ff6b6b' }}>{errorMsg}</p>
          </div>
        )}

        {statusMsg && (
          <div className="card" style={infoCardStyle}>
            <p style={{ fontSize: '0.875rem', color: '#00a7b5' }}>{statusMsg}</p>
          </div>
        )}

        {/* Anchor discovery search */}
        <section style={{ marginBottom: '2rem' }}>
          <h2 style={sectionHeadingStyle}>Search Anchor Domain</h2>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
            <input
              value={domainInput}
              onChange={(e) => setDomainInput(e.target.value)}
              placeholder="e.g. testanchor.stellar.org"
              style={inputStyle}
              aria-label="Anchor Domain"
            />
            <button
              onClick={() => void handleDiscover(domainInput)}
              disabled={loading || !domainInput.trim()}
              style={primaryButtonStyle(loading || !domainInput.trim())}
            >
              {loading ? 'Discovering…' : 'Discover'}
            </button>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.75rem', color: 'var(--warm-grey)', alignSelf: 'center' }}>
              Quick select:
            </span>
            {FEATURED_ANCHORS.map((d) => (
              <button
                key={d}
                onClick={() => {
                  setDomainInput(d)
                  void handleDiscover(d)
                }}
                style={chipStyle(domainInput === d)}
              >
                {d}
              </button>
            ))}
          </div>
        </section>

        {/* Parsed Anchor Results */}
        {anchorInfo && (
          <section className="card" style={{ marginBottom: '2rem', padding: '1.25rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--off-white)' }}>
                  {anchorInfo.homeDomain}
                </h3>
                <p style={{ fontSize: '0.75rem', color: 'var(--warm-grey)', fontFamily: 'monospace' }}>
                  SEP-24: {anchorInfo.transferServerSep24 ? 'Available' : 'None'} | SEP-10: {anchorInfo.webAuthEndpoint ? 'Available' : 'None'}
                </p>
              </div>
            </div>

            <h4 style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--warm-grey)', marginBottom: '0.75rem' }}>
              OFFERED ASSETS ({anchorInfo.currencies.length})
            </h4>

            {anchorInfo.currencies.length === 0 ? (
              <p style={{ fontSize: '0.875rem', color: 'var(--warm-grey)' }}>
                No verified currencies listed in stellar.toml.
              </p>
            ) : (
              anchorInfo.currencies.map((currency) => (
                <div key={`${currency.code}-${currency.issuer || 'native'}`} style={assetRowStyle}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontWeight: 600, color: 'var(--off-white)', fontSize: '1rem' }}>
                        {currency.code}
                      </span>
                      {renderBadge(currency)}
                    </div>
                    {currency.issuer && (
                      <p style={{ fontSize: '0.7rem', fontFamily: 'monospace', color: 'var(--warm-grey)', marginTop: '0.25rem' }}>
                        Issuer: {currency.issuer}
                      </p>
                    )}
                    {currency.name && (
                      <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.7)', marginTop: '0.125rem' }}>
                        {currency.name}
                      </p>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {currency.sep24Enabled && anchorInfo.transferServerSep24 && (
                      <>
                        <button
                          onClick={() => void handleSep24Flow(currency, 'deposit')}
                          style={actionBtnStyle}
                        >
                          Deposit
                        </button>
                        <button
                          onClick={() => void handleSep24Flow(currency, 'withdraw')}
                          style={secondaryActionBtnStyle}
                        >
                          Withdraw
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))
            )}
          </section>
        )}
      </main>

      {/* SEP-24 Hosted Flow Modal */}
      <AnchorDirectoryModal
        isOpen={modalOpen}
        url={interactiveUrl}
        title={flowTitle}
        onClose={() => {
          setModalOpen(false)
          setInteractiveUrl(null)
        }}
        onComplete={() => {
          setStatusMsg('Transaction completed cleanly!')
        }}
      />
    </div>
  )
}

function renderBadge(currency: DiscoveredCurrency) {
  if (currency.isImpersonating) {
    return (
      <span style={{ ...badgeBase, background: 'rgba(229,72,77,0.15)', color: '#ff6b6b', borderColor: 'rgba(229,72,77,0.3)' }}>
        ⚠ Impersonation Warning
      </span>
    )
  }
  if (currency.isVerifiedRegistry) {
    return (
      <span style={{ ...badgeBase, background: 'rgba(0,167,181,0.15)', color: '#00a7b5', borderColor: 'rgba(0,167,181,0.3)' }}>
        ✓ Verified Registry
      </span>
    )
  }
  if (currency.isIssuerVerified) {
    return (
      <span style={{ ...badgeBase, background: 'rgba(70,160,120,0.15)', color: '#52c41a', borderColor: 'rgba(70,160,120,0.3)' }}>
        Verified Issuer
      </span>
    )
  }
  return (
    <span style={{ ...badgeBase, background: 'rgba(255,255,255,0.06)', color: 'var(--warm-grey)', borderColor: 'rgba(255,255,255,0.1)' }}>
      Unverified
    </span>
  )
}

const badgeBase: CSSProperties = {
  fontSize: '0.6875rem',
  padding: '0.125rem 0.5rem',
  borderRadius: '1rem',
  border: '1px solid',
  fontWeight: 500,
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

const inputStyle: CSSProperties = {
  flex: 1,
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

function chipStyle(active: boolean): CSSProperties {
  return {
    background: active ? 'rgba(0,167,181,0.2)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${active ? '#00a7b5' : 'rgba(255,255,255,0.1)'}`,
    color: active ? '#00a7b5' : 'var(--warm-grey)',
    borderRadius: '1rem',
    padding: '0.25rem 0.75rem',
    fontSize: '0.75rem',
    cursor: 'pointer',
  }
}

const assetRowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.75rem 0',
  borderTop: '1px solid rgba(255,255,255,0.06)',
}

const actionBtnStyle: CSSProperties = {
  background: 'var(--gold)',
  color: 'var(--near-black)',
  border: 'none',
  borderRadius: '0.375rem',
  padding: '0.375rem 0.75rem',
  fontWeight: 600,
  fontSize: '0.8125rem',
  cursor: 'pointer',
}

const secondaryActionBtnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  color: 'var(--off-white)',
  border: '1px solid rgba(255,255,255,0.15)',
  borderRadius: '0.375rem',
  padding: '0.375rem 0.75rem',
  fontWeight: 500,
  fontSize: '0.8125rem',
  cursor: 'pointer',
}

const errorCardStyle: CSSProperties = {
  marginBottom: '1rem',
  borderColor: 'rgba(229,72,77,0.4)',
  background: 'rgba(229,72,77,0.07)',
}

const infoCardStyle: CSSProperties = {
  marginBottom: '1rem',
  borderColor: 'rgba(0,167,181,0.3)',
  background: 'rgba(0,167,181,0.06)',
}

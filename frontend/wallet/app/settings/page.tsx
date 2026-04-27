'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { VeilLogo } from '@/components/VeilLogo'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useInvisibleWallet, type SignerInfo } from '@veil/sdk'

const CONFIG = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  factoryAddress: process.env.NEXT_PUBLIC_FACTORY_CONTRACT_ID ?? '',
}

type Section = 'overview' | 'add-signer' | 'guardian'

export default function SettingsPage() {
  const router = useRouter()
  const [address, setAddress] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('overview')
  const [status, setStatus] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [signers, setSigners] = useState<SignerInfo[]>([])
  const [localPublicKey, setLocalPublicKey] = useState<string | null>(null)

  // Guardian form
  const [guardianAddress, setGuardianAddress] = useState('')

  const wallet = useInvisibleWallet(CONFIG)

  useEffect(() => {
    const addr = sessionStorage.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }
    setAddress(addr)
  }, [router])

  const fetchSigners = useCallback(async () => {
    try {
      const list = await wallet.getSigners();
      setSigners(list)
    } catch (e) {
      console.error('Failed to fetch signers', e)
    }
  }, [wallet.getSigners]);

  useEffect(() => {
    if (address && section === 'overview') {
      fetchSigners()
    }
    if (typeof window !== 'undefined') {
      setLocalPublicKey(localStorage.getItem('invisible_wallet_public_key'))
    }
  }, [address, section, fetchSigners])

  function getSignerKeypair(): Keypair {
    const secret = sessionStorage.getItem('veil_signer_secret')
    if (!secret) throw new Error('No signer key in session')
    return Keypair.fromSecret(secret)
  }

  async function handleAddSigner() {
    setLoading(true)
    setStatus(null)
    try {
      const signerKeypair = getSignerKeypair()
      // register() returns the new passkey public key bytes via WebAuthn
      const result = await wallet.register()
      if (!result?.publicKeyBytes) throw new Error('Registration returned no public key')
      const res = await wallet.addSigner(signerKeypair, result.publicKeyBytes)
      setStatus(`New signer added at index ${res.signerIndex}`)
      await fetchSigners()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleRemoveSigner(index: number) {
    if (signers.length <= 1) return
    setLoading(true)
    setStatus(null)
    try {
      const signerKeypair = getSignerKeypair()
      await wallet.removeSigner(signerKeypair, index)
      setStatus(`Signer #${index} removed`)
      await fetchSigners()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleSetGuardian() {
    if (!guardianAddress.startsWith('G') || guardianAddress.length !== 56) {
      setStatus('Enter a valid Stellar G... address')
      return
    }
    setLoading(true)
    setStatus(null)
    try {
      const signerKeypair = getSignerKeypair()
      await wallet.setGuardian(signerKeypair, guardianAddress)
      setStatus('Guardian set successfully')
      setGuardianAddress('')
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const shortAddr = address ? `${address.slice(0, 8)}...${address.slice(-8)}` : '—'

  return (
    <div className="wallet-shell">
      {/* Nav */}
      <nav className="wallet-nav">
        <button
          onClick={() => section === 'overview' ? router.push('/dashboard') : setSection('overview')}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--off-white)', display: 'flex', alignItems: 'center', gap: '0.375rem', fontSize: '0.875rem' }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          {section === 'overview' ? 'Dashboard' : 'Settings'}
        </button>
        <VeilLogo size={22} />
        <ThemeToggle />
      </nav>

      <main className="wallet-main">
        {/* Overview */}
        {section === 'overview' && (
          <>
            <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem', marginBottom: '0.375rem' }}>
              Security
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginBottom: '2rem' }}>
              Manage signers, recovery, and wallet settings
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {/* Wallet address */}
              <div className="card">
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', marginBottom: '0.625rem' }}>
                  WALLET
                </p>
                <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.875rem', wordBreak: 'break-all', color: 'var(--gold)' }}>
                  {shortAddr}
                </p>
              </div>

              {/* Add signer card */}
              <button
                className="card"
                onClick={() => { setSection('add-signer'); setStatus(null) }}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Add signer</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Register a second device with a new passkey
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Guardian card */}
              <button
                className="card"
                onClick={() => { setSection('guardian'); setStatus(null) }}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Guardian recovery</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Set a trusted account to recover access if you lose your device
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Profile & AI */}
              <button
                className="card"
                onClick={() => router.push('/settings/profile')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Profile & AI</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Name, language, and agent personality
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Agent Settings */}
              <button
                className="card"
                onClick={() => router.push('/settings/agent')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Agent Settings</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Spending limits and allowed services
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Address Book card */}
              <button
                className="card"
                onClick={() => router.push('/contacts')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Address Book</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Save and manage frequently used Stellar addresses
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Signers list */}
              <div style={{ marginTop: '2rem' }}>
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', marginBottom: '0.625rem' }}>
                  REGISTERED SIGNERS
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                  {signers.map(s => {
                    const isThisDevice = localPublicKey === s.publicKey
                    const truncated = `0x${s.publicKey.slice(0, 12)}...${s.publicKey.slice(-8)}`
                    return (
                      <div key={s.index} className="card-md" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <p style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--off-white)' }}>
                              #{s.index}
                            </p>
                            {isThisDevice && (
                              <span style={{ fontSize: '0.625rem', background: 'rgba(94, 234, 212, 0.1)', color: 'var(--teal)', padding: '0.125rem 0.375rem', borderRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
                                This device
                              </span>
                            )}
                          </div>
                          <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                            {truncated}
                          </p>
                        </div>

                        <button
                          onClick={() => handleRemoveSigner(s.index)}
                          disabled={loading || signers.length <= 1}
                          style={{ background: 'none', border: 'none', color: signers.length <= 1 ? 'rgba(246,247,248,0.1)' : 'var(--teal)', fontSize: '0.75rem', cursor: signers.length <= 1 ? 'not-allowed' : 'pointer', textDecoration: 'underline' }}
                        >
                          Remove
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          </>
        )}

        {/* Add signer */}
        {section === 'add-signer' && (
          <>
            <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem', marginBottom: '0.75rem' }}>
              Add signer
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginBottom: '2rem', lineHeight: 1.6 }}>
              This will prompt a passkey registration on this device. Once confirmed, the new passkey will be added to your wallet on-chain.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {status && (
                <div className="card-md">
                  <p style={{ fontSize: '0.875rem', color: status.includes('index') ? 'var(--teal)' : 'rgba(246,247,248,0.6)' }}>
                    {status}
                  </p>
                </div>
              )}
              <button className="btn-gold" onClick={handleAddSigner} disabled={loading}>
                {loading ? <span className="spinner" /> : 'Register new passkey'}
              </button>
            </div>
          </>
        )}

        {/* Guardian */}
        {section === 'guardian' && (
          <>
            <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem', marginBottom: '0.75rem' }}>
              Guardian recovery
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginBottom: '2rem', lineHeight: 1.6 }}>
              A guardian can initiate a 3-day timelock recovery if you lose all your devices. They cannot access your wallet without your confirmation.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div>
                <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  GUARDIAN STELLAR ADDRESS
                </label>
                <input
                  className="input-field mono"
                  type="text"
                  placeholder="G..."
                  value={guardianAddress}
                  onChange={e => setGuardianAddress(e.target.value.trim())}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {status && (
                <div className="card-md">
                  <p style={{ fontSize: '0.875rem', color: status.includes('success') ? 'var(--teal)' : 'rgba(246,247,248,0.6)' }}>
                    {status}
                  </p>
                </div>
              )}

              <button className="btn-gold" onClick={handleSetGuardian} disabled={loading}>
                {loading ? <span className="spinner" /> : 'Set guardian'}
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

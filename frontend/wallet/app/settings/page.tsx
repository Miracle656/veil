'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { VeilLogo } from '@/components/VeilLogo'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useInvisibleWallet, type SignerInfo } from '@veil/sdk'
import { walletConfig } from '@/lib/network'
import { useWalletConnect } from '@/lib/walletConnect'
import {
  generateMnemonicPhrase,
  deriveP256KeyPair,
  encryptMnemonic,
  decryptMnemonic,
  storeEncryptedMnemonic,
  getEncryptedMnemonic,
} from '@/lib/recovery'

type Section = 'overview' | 'add-signer' | 'guardian' | 'recovery-backup'

// ── Globe fallback icon ───────────────────────────────────────────────────────
function GlobeIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" />
      <ellipse cx="12" cy="12" rx="4" ry="9" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" />
      <path d="M3 12h18" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" />
    </svg>
  )
}

// ── Connected Apps section ────────────────────────────────────────────────────
function ConnectedApps() {
  const { sessions, disconnect, disconnectAll, isLoaded } = useWalletConnect()

  if (!isLoaded) return null

  return (
    <div style={{ marginTop: '2rem' }}>
      {/* Section header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.625rem' }}>
        <p style={{
          fontSize: '0.75rem',
          color: 'rgba(246,247,248,0.4)',
          fontFamily: 'Anton, Impact, sans-serif',
          letterSpacing: '0.06em',
        }}>
          CONNECTED APPS
        </p>
        {sessions.length > 1 && (
          <button
            onClick={disconnectAll}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '0.75rem',
              color: 'rgba(246,247,248,0.4)',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Disconnect all
          </button>
        )}
      </div>

      {/* Empty state */}
      {sessions.length === 0 && (
        <div className="card-md" style={{ textAlign: 'center', padding: '1.5rem' }}>
          <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.3)' }}>
            No apps connected
          </p>
        </div>
      )}

      {/* Session cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
        {sessions.map((session) => {
          const meta = session.peer
          const iconSrc = meta?.icons && meta.icons.length > 0 ? meta.icons[0] : null
          const url = meta?.url ?? ''
          const truncatedUrl = url.length > 40 ? url.slice(0, 37) + '…' : url

          return (
            <div
              key={session.topic}
              className="card-md"
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}
            >
              {/* Icon + text */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', minWidth: 0 }}>
                {iconSrc ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    src={iconSrc}
                    alt={meta?.name ?? 'dApp'}
                    width={24}
                    height={24}
                    style={{ borderRadius: '6px', flexShrink: 0, objectFit: 'cover' }}
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
                  />
                ) : (
                  <GlobeIcon />
                )}
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--off-white)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {meta?.name ?? 'Unknown app'}
                  </p>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', fontFamily: 'Inconsolata, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {truncatedUrl}
                  </p>
                </div>
              </div>

              {/* Disconnect button */}
              <button
                onClick={() => disconnect(session.topic)}
                style={{
                  background: 'none',
                  border: 'none',
                  fontSize: '0.75rem',
                  color: 'var(--teal)',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  flexShrink: 0,
                  padding: 0,
                }}
              >
                Disconnect
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

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

  // Paper Backup state
  const [hasBackup, setHasBackup] = useState(false)
  const [backupMnemonic, setBackupMnemonic] = useState('')
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [revealPassphrase, setRevealPassphrase] = useState('')
  const [backupStep, setBackupStep] = useState<'initial' | 'generated' | 'configured'>('initial')

  const wallet = useInvisibleWallet(walletConfig)

  const checkBackup = useCallback(async () => {
    try {
      const enc = await getEncryptedMnemonic()
      if (enc) {
        setHasBackup(true)
        setBackupStep('configured')
      } else {
        setHasBackup(false)
        setBackupStep('initial')
      }
    } catch (e) {
      console.error(e)
    }
  }, [])

  useEffect(() => {
    checkBackup()
  }, [checkBackup])

  async function handleGenerateBackup() {
    const mnemonic = generateMnemonicPhrase()
    setBackupMnemonic(mnemonic)
    setBackupStep('generated')
    setStatus(null)
  }

  async function handleSaveBackup() {
    if (!backupPassphrase) {
      setStatus('Please enter a passphrase to encrypt your recovery phrase.')
      return
    }
    setLoading(true)
    setStatus(null)
    try {
      // 1. Derive key pair
      const { publicKey } = deriveP256KeyPair(backupMnemonic)
      
      // 2. Register derived key as a signer on-chain
      const signerKeypair = getSignerKeypair()
      const res = await wallet.addSigner(signerKeypair, publicKey)
      
      // 3. Encrypt and store in IndexedDB
      const encrypted = await encryptMnemonic(backupMnemonic, backupPassphrase)
      await storeEncryptedMnemonic(encrypted)
      
      setHasBackup(true)
      setBackupStep('configured')
      setBackupMnemonic('')
      setBackupPassphrase('')
      setStatus(`Paper backup configured successfully! Signer added at index ${res.signerIndex}`)
      await fetchSigners()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleRevealBackup() {
    if (!revealPassphrase) {
      setStatus('Please enter your passphrase to reveal.')
      return
    }
    setLoading(true)
    setStatus(null)
    try {
      const encrypted = await getEncryptedMnemonic()
      if (!encrypted) throw new Error('No backup found')
      const mnemonic = await decryptMnemonic(encrypted, revealPassphrase)
      setBackupMnemonic(mnemonic)
      setRevealPassphrase('')
      setStatus('Decryption successful!')
    } catch (err: unknown) {
      setStatus('Invalid passphrase. Could not decrypt.')
    } finally {
      setLoading(false)
    }
  }

  async function handleDisableBackup() {
    setLoading(true)
    setStatus(null)
    try {
      await storeEncryptedMnemonic('')
      setHasBackup(false)
      setBackupStep('initial')
      setBackupMnemonic('')
      setStatus('Paper backup removed from this device storage.')
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

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

              {/* Paper Backup card */}
              <button
                className="card"
                onClick={() => { setSection('recovery-backup'); setStatus(null); checkBackup() }}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Paper Backup (Recovery Phrase)</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Generate an offline 12-word recovery phrase for emergencies
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

              {/* DAO Multisig Wallet Card */}
              <button
                className="card"
                onClick={() => router.push('/multisig')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem', color: 'var(--gold)' }}>DAO Multisig Wallet</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Configure M-of-N signers, deploy wallet contract, and track pending tx approvals
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

              {/* ── Connected Apps ── */}
              <ConnectedApps />
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

        {/* Paper Backup */}
        {section === 'recovery-backup' && (
          <>
            <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem', marginBottom: '0.75rem' }}>
              Paper Backup (Recovery Phrase)
            </h2>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginBottom: '2rem', lineHeight: 1.6 }}>
              Configure a paper backup using a standard BIP-39 12-word recovery phrase.
              This provides a secondary signer to recover your wallet if you lose your device.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {status && (
                <div className="card-md">
                  <p style={{ fontSize: '0.875rem', color: status.includes('success') || status.includes('successful') ? 'var(--teal)' : 'rgba(246,247,248,0.6)' }}>
                    {status}
                  </p>
                </div>
              )}

              {backupStep === 'initial' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  <div className="card-md" style={{ borderLeft: '3px solid var(--gold)', paddingLeft: '1rem' }}>
                    <p style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--gold)', marginBottom: '0.5rem' }}>
                      Threat Model & Security Info
                    </p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)', lineHeight: 1.5 }}>
                      Anyone who has access to your 12-word phrase and your wallet contract address can sign transactions and drain funds.
                      Store the phrase securely offline (e.g., written on paper in a safe).
                    </p>
                  </div>
                  <button className="btn-gold" onClick={handleGenerateBackup} disabled={loading}>
                    Generate Recovery Phrase
                  </button>
                </div>
              )}

              {backupStep === 'generated' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                  <div>
                    <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                      YOUR 12-WORD RECOVERY PHRASE
                    </label>
                    <div className="card-md" style={{ background: 'rgba(246,247,248,0.03)', border: '1px dashed var(--gold)', padding: '1rem', textAlign: 'center' }}>
                      <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '1.05rem', wordSpacing: '0.5em', letterSpacing: '0.03em', color: 'var(--off-white)', lineHeight: 1.8 }}>
                        {backupMnemonic}
                      </p>
                    </div>
                    <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', marginTop: '0.5rem', fontStyle: 'italic' }}>
                      Write down these 12 words in order and keep them offline.
                    </p>
                  </div>

                  <div>
                    <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                      ENCRYPTION PASSPHRASE
                    </label>
                    <input
                      className="input-field"
                      type="password"
                      placeholder="Enter a secure password to encrypt phrase"
                      value={backupPassphrase}
                      onChange={e => setBackupPassphrase(e.target.value)}
                    />
                    <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', marginTop: '0.5rem' }}>
                      Used to encrypt and store the mnemonic in IndexedDB for easy access on this device.
                    </p>
                  </div>

                  <div style={{ display: 'flex', gap: '0.75rem' }}>
                    <button className="btn-gold" style={{ flex: 1 }} onClick={handleSaveBackup} disabled={loading || !backupPassphrase}>
                      {loading ? <span className="spinner" /> : 'Confirm & Register Signer'}
                    </button>
                    <button
                      className="btn"
                      style={{ border: '1px solid var(--border-dim)', color: 'rgba(246,247,248,0.6)' }}
                      onClick={() => { setBackupStep('initial'); setBackupMnemonic(''); setBackupPassphrase('') }}
                      disabled={loading}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {backupStep === 'configured' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                  <div className="card-md" style={{ borderLeft: '3px solid var(--teal)' }}>
                    <p style={{ fontWeight: 600, fontSize: '0.875rem', color: 'var(--teal)', marginBottom: '0.25rem' }}>
                      Backup Configured
                    </p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)' }}>
                      An encrypted backup is stored in IndexedDB, and the derived key is registered as a signer.
                    </p>
                  </div>

                  {backupMnemonic ? (
                    <div>
                      <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                        YOUR RECOVERY PHRASE
                      </label>
                      <div className="card-md" style={{ background: 'rgba(246,247,248,0.03)', border: '1px dashed var(--teal)', padding: '1rem', textAlign: 'center' }}>
                        <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '1.05rem', wordSpacing: '0.5em', letterSpacing: '0.03em', color: 'var(--off-white)', lineHeight: 1.8 }}>
                          {backupMnemonic}
                        </p>
                      </div>
                      <button
                        className="btn"
                        style={{ marginTop: '0.75rem', border: '1px solid var(--border-dim)' }}
                        onClick={() => setBackupMnemonic('')}
                      >
                        Hide Phrase
                      </button>
                    </div>
                  ) : (
                    <div>
                      <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                        REVEAL RECOVERY PHRASE
                      </label>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <input
                          className="input-field"
                          type="password"
                          placeholder="Enter your encryption passphrase"
                          value={revealPassphrase}
                          onChange={e => setRevealPassphrase(e.target.value)}
                        />
                        <button className="btn-gold" onClick={handleRevealBackup} disabled={loading || !revealPassphrase}>
                          Reveal
                        </button>
                      </div>
                    </div>
                  )}

                  <hr style={{ border: 'none', borderTop: '1px solid var(--border-dim)', margin: '1rem 0' }} />

                  <button
                    className="btn"
                    style={{ border: '1px solid rgba(220, 38, 38, 0.3)', color: 'rgba(220, 38, 38, 0.8)' }}
                    onClick={handleDisableBackup}
                    disabled={loading}
                  >
                    Delete Local Backup
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
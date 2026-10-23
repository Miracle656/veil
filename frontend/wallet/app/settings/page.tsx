'use client'

import { PageHeader } from '@/components/ui/primitives'
import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { VeilMark } from '@/components/ui/VeilMark'
import { TRUSTLINE_RESERVE_COST_XLM } from '@/lib/reserves'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useInvisibleWallet, type SignerInfo } from '@veil/sdk'
import { ensureWalletDeployed, getDeploymentState } from '@/lib/walletDeployment'
import { walletConfig } from '@/lib/network'
import { isMultisigAvailable } from '@/lib/multisigConfig'
import { useWalletConnect } from '@/lib/walletConnect'
import {
  generateMnemonicPhrase,
  deriveP256KeyPair,
  encryptMnemonic,
  decryptMnemonic,
  storeEncryptedMnemonic,
  getEncryptedMnemonic,
} from '@/lib/recovery'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { isFeePayerPrfDowngrade, getFeePayerDiagnostics } from '@/lib/feePayer'
import {
  GUARDIAN_CAN,
  GUARDIAN_CANNOT,
  GUARDIAN_DELAY_SECONDS,
  RECOVERY_SERVER_DELAY_SECONDS,
  cancelPendingRecovery,
  completeRecoveryPermissionless,
  initiateRecoveryAsGuardian,
  isGuardianRecoveryUnlocked,
  readGuardian,
  readPendingRecovery,
  type PendingGuardianRecovery,
} from '@/lib/guardian'

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
  const [prfDowngraded, setPrfDowngraded] = useState(false)

  const [signers, setSigners] = useState<SignerInfo[]>([])
  const [localPublicKey, setLocalPublicKey] = useState<string | null>(null)

  // Guardian section: the on-chain state plus the two forms (nominate /
  // act-as-guardian). `undefined` = still loading, null = none set.
  const [guardianAddress, setGuardianAddress] = useState('')
  const [currentGuardian, setCurrentGuardian] = useState<string | null | undefined>(undefined)
  const [pendingRecovery, setPendingRecovery] = useState<PendingGuardianRecovery | null>(null)
  const [recoverWallet, setRecoverWallet] = useState('')
  const [recoverNewKeyHex, setRecoverNewKeyHex] = useState('')

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
      // Adding a signer is a call the contract answers, so it has to exist.
      await ensureWalletDeployed(wallet.deploy, address)
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

  const [multisigAvailable, setMultisigAvailable] = useState(false)

  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }
    setAddress(addr)
    // Active network is read from localStorage, so this waits for mount (#672).
    setMultisigAvailable(isMultisigAvailable())
    // Check fee-payer downgrade state so the card can show a warning dot
    // without importing the full diagnostics into every render.
    setPrfDowngraded(isFeePayerPrfDowngrade(getFeePayerDiagnostics()))
  }, [router])

  const fetchSigners = useCallback(async () => {
    try {
      // An undeployed wallet has no signer list on chain to read yet. That is
      // a normal state now (deploy-on-first-use), not a failure to report.
      if ((await getDeploymentState(address)) === 'undeployed') {
        setSigners([])
        return
      }
      const list = await wallet.getSigners();
      setSigners(list)
    } catch (e) {
      console.error('Failed to fetch signers', e)
    }
  }, [wallet.getSigners, address]);

  useEffect(() => {
    if (address && section === 'overview') {
      fetchSigners()
    }
    if (typeof window !== 'undefined') {
      setLocalPublicKey(walletLocal.getItem('invisible_wallet_public_key'))
    }
  }, [address, section, fetchSigners])

  function getSignerKeypair(): Keypair {
    const secret = walletSession.getItem('veil_signer_secret')
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
      await ensureWalletDeployed(wallet.deploy, address)
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
      await ensureWalletDeployed(wallet.deploy, address)
      await wallet.removeSigner(signerKeypair, index)
      setStatus(`Signer #${index} removed`)
      await fetchSigners()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const loadGuardianState = useCallback(async () => {
    if (!address) return
    const [guardian, pending] = await Promise.all([
      readGuardian(address, walletConfig.rpcUrl),
      readPendingRecovery(address, walletConfig.rpcUrl, walletConfig.networkPassphrase),
    ])
    setCurrentGuardian(guardian)
    setPendingRecovery(pending)
  }, [address])

  useEffect(() => {
    if (section === 'guardian') {
      setCurrentGuardian(undefined)
      void loadGuardianState()
    }
  }, [section, loadGuardianState])

  async function handleSetGuardian() {
    if (!guardianAddress.startsWith('G') || guardianAddress.length !== 56) {
      setStatus('Enter a valid Stellar G... address')
      return
    }
    setLoading(true)
    setStatus(null)
    try {
      const signerKeypair = getSignerKeypair()
      // Setting a guardian is stored by the contract, so it has to be on chain.
      await ensureWalletDeployed(wallet.deploy, address)
      await wallet.setGuardian(signerKeypair, guardianAddress)
      setStatus(currentGuardian ? 'Guardian changed successfully' : 'Guardian set successfully')
      setGuardianAddress('')
      await loadGuardianState()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleCancelRecovery() {
    if (!address) return
    setLoading(true)
    setStatus(null)
    try {
      await cancelPendingRecovery({
        walletAddress: address,
        feePayer: getSignerKeypair(),
        signAuthEntry: wallet.signAuthEntry,
        rpcUrl: walletConfig.rpcUrl,
        networkPassphrase: walletConfig.networkPassphrase,
      })
      setStatus('Recovery cancelled successfully — your current keys stay in control.')
      await loadGuardianState()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleCompleteRecovery() {
    if (!address) return
    setLoading(true)
    setStatus(null)
    try {
      await completeRecoveryPermissionless({
        walletAddress: address,
        payer: getSignerKeypair(),
        rpcUrl: walletConfig.rpcUrl,
        networkPassphrase: walletConfig.networkPassphrase,
      })
      setStatus('Recovery completed successfully — the wallet now answers to the new key only.')
      await loadGuardianState()
    } catch (err: unknown) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleInitiateAsGuardian() {
    const target = recoverWallet.trim()
    const keyHex = recoverNewKeyHex.trim().toLowerCase()
    if (!target.startsWith('C') || target.length !== 56) {
      setStatus('Enter the wallet to recover as a C... contract address')
      return
    }
    if (!/^04[0-9a-f]{128}$/.test(keyHex)) {
      setStatus('The new key must be 130 hex characters starting with 04 (an uncompressed P-256 public key)')
      return
    }
    setLoading(true)
    setStatus(null)
    try {
      const guardianKeypair = getSignerKeypair()
      await initiateRecoveryAsGuardian({
        walletAddress: target,
        guardian: guardianKeypair,
        newPublicKey: new Uint8Array((keyHex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16))),
        rpcUrl: walletConfig.rpcUrl,
        networkPassphrase: walletConfig.networkPassphrase,
      })
      setStatus(
        'Recovery initiated successfully. It can be completed after the 3-day waiting period — '
        + 'during which the wallet owner can still cancel it.',
      )
      setRecoverWallet('')
      setRecoverNewKeyHex('')
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
        <VeilMark size={22} />
        <ThemeToggle />
      </nav>

      <main className="wallet-main">
        {/* Overview */}
        {section === 'overview' && (
          <>
            <div style={{ marginBottom: '1.75rem' }}>
          <PageHeader eyebrow="Preferences" title="Settings" />
        </div>
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

              {/* Passkeys card */}
              <button
                className="card"
                onClick={() => router.push('/settings/passkeys')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Passkeys</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      View and manage passkeys registered on this wallet
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Spending permissions card */}
              <button
                className="card"
                onClick={() => router.push('/settings/allowances')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Spending permissions</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Apps and contracts allowed to move your tokens without asking
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Trustlines & Reserves card */}
              <button
                className="card"
                onClick={() => router.push('/assets')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Trustlines &amp; Reserves</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Manage enabled assets, view locked reserves ({TRUSTLINE_RESERVE_COST_XLM} XLM each), and reclaim reserves from empty trustlines
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Fee Payer card */}
              <button
                id="settings-fee-payer"
                className="card"
                onClick={() => router.push('/settings/fee-payer')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: prfDowngraded ? '1px solid rgba(220,38,38,0.35)' : '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Fee Payer</p>
                      {prfDowngraded && (
                        <span
                          title="PRF was requested but is unavailable on this device — fee payer may differ on other clients"
                          style={{
                            display: 'inline-block',
                            width: '7px', height: '7px',
                            borderRadius: '50%',
                            background: 'rgba(220,38,38,0.85)',
                            flexShrink: 0,
                          }}
                        />
                      )}
                    </div>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      {prfDowngraded
                        ? 'PRF unavailable — using legacy derivation'
                        : 'View active fee-payer address and derivation mode'}
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke={prfDowngraded ? 'rgba(220,38,38,0.5)' : 'rgba(246,247,248,0.3)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
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

              {/* Security & Lock */}
              <button
                className="card"
                onClick={() => router.push('/settings/security')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Security &amp; Lock</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Auto-lock the wallet after inactivity
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* Privacy */}
              <button
                className="card"
                onClick={() => router.push('/settings/privacy')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Privacy</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Error reporting and data preferences
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

              {/* DAO Multisig Wallet Card — only where the contract exists (#672);
                  /multisig redirects away on networks without it. */}
              {multisigAvailable ? (
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
              ) : null}

              {/* Bulk Payout */}
              <button
                className="card"
                onClick={() => router.push('/bulk-payout')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>Bulk Payout</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Pay many recipients from one CSV
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              <button
                className="card"
                onClick={() => router.push('/vault')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem', color: 'var(--gold)' }}>Time-Locked Vault</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Protect long-term XLM with queued, cancellable withdrawals
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              {/* About */}
              <button
                className="card"
                onClick={() => router.push('/settings/about')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid var(--border-dim)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem' }}>About</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Build, network, and contract addresses
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(246,247,248,0.3)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </div>
              </button>

              <button
                className="card"
                onClick={() => router.push('/settings/danger')}
                style={{ textAlign: 'left', cursor: 'pointer', width: '100%', border: '1px solid rgba(220, 38, 38, 0.3)', background: 'var(--surface)' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <p style={{ fontWeight: 500, fontSize: '0.9375rem', color: 'rgba(220, 38, 38, 0.9)' }}>Danger Zone</p>
                    <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.25rem' }}>
                      Irreversible actions: account merge and permanent wallet deletion
                    </p>
                  </div>
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                    <path d="M6 3l5 5-5 5" stroke="rgba(220, 38, 38, 0.6)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
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
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginBottom: '1.5rem', lineHeight: 1.6 }}>
              A guardian is a Stellar account you trust to get you back in after you lose every
              device. Recovery replaces your wallet&apos;s keys after a {Math.round(GUARDIAN_DELAY_SECONDS / 86_400)}-day
              waiting period — a window in which you can cancel it from any signed-in device.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {/* Pending recovery — shown before anything else, because nothing
                  on this screen matters more than a countdown that ends in a
                  key replacement. */}
              {pendingRecovery && (
                <div
                  data-testid="pending-recovery"
                  className="card-md"
                  style={{ border: '1px solid rgba(220,38,38,0.5)' }}
                >
                  <p style={{ fontWeight: 600, fontSize: '0.9375rem', color: 'rgb(248,113,113)' }}>
                    Recovery in progress
                  </p>
                  <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', marginTop: '0.375rem', lineHeight: 1.6 }}>
                    {pendingRecovery.source === 'guardian'
                      ? 'Started by your guardian.'
                      : 'Started through your recovery servers (the separate 7-day mechanism).'}{' '}
                    {isGuardianRecoveryUnlocked(pendingRecovery)
                      ? 'The waiting period has elapsed: it can be completed at any moment.'
                      : `It can be completed after ${new Date(pendingRecovery.unlockTime * 1000).toLocaleString()}.`}{' '}
                    If you did not expect this, cancel it now — completion hands the wallet to the
                    key below.
                  </p>
                  <p className="mono" style={{ fontSize: '0.6875rem', color: 'rgba(246,247,248,0.45)', marginTop: '0.5rem', wordBreak: 'break-all', userSelect: 'all' }}>
                    {pendingRecovery.newPublicKeyHex}
                  </p>
                  <div style={{ display: 'flex', gap: '0.625rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
                    <button className="btn-gold" onClick={handleCancelRecovery} disabled={loading}>
                      {loading ? <span className="spinner" /> : 'Cancel this recovery'}
                    </button>
                    {isGuardianRecoveryUnlocked(pendingRecovery) && (
                      <button className="btn-gold" onClick={handleCompleteRecovery} disabled={loading}>
                        {loading ? <span className="spinner" /> : 'Complete recovery'}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Current guardian */}
              <div className="card-md" data-testid="current-guardian">
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', marginBottom: '0.375rem' }}>
                  CURRENT GUARDIAN
                </p>
                {currentGuardian === undefined ? (
                  <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)' }}>Checking on-chain…</p>
                ) : currentGuardian ? (
                  <p className="mono" style={{ fontSize: '0.75rem', color: 'var(--off-white)', wordBreak: 'break-all', userSelect: 'all' }}>
                    {currentGuardian}
                  </p>
                ) : (
                  <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)' }}>
                    No guardian set. Without one (or a recovery server, or a backup), losing every
                    device means losing the wallet.
                  </p>
                )}
              </div>

              {/* What the trust means — consequences, not mechanism. */}
              <div className="card-md" data-testid="guardian-powers">
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', marginBottom: '0.375rem' }}>
                  WHAT A GUARDIAN CAN DO
                </p>
                {GUARDIAN_CAN.map((line) => (
                  <p key={line} style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', lineHeight: 1.6, marginTop: '0.25rem' }}>
                    • {line}
                  </p>
                ))}
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', margin: '0.75rem 0 0.375rem' }}>
                  WHAT A GUARDIAN CANNOT DO
                </p>
                {GUARDIAN_CANNOT.map((line) => (
                  <p key={line} style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', lineHeight: 1.6, marginTop: '0.25rem' }}>
                    • {line}
                  </p>
                ))}
                <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.45)', lineHeight: 1.6, marginTop: '0.75rem' }}>
                  Pick someone who would refuse a stranger&apos;s request — anyone who can convince your
                  guardian can start a takeover, and your only defence is cancelling within the{' '}
                  {Math.round(GUARDIAN_DELAY_SECONDS / 86_400)} days. This is separate from recovery
                  servers, which drive the same key replacement through their own{' '}
                  {Math.round(RECOVERY_SERVER_DELAY_SECONDS / 86_400)}-day waiting period; the two share
                  one recovery slot, and a pending recovery from either shows above.
                </p>
              </div>

              {/* Nominate / change */}
              <div>
                <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  {currentGuardian ? 'CHANGE GUARDIAN TO' : 'GUARDIAN STELLAR ADDRESS'}
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
                {loading ? <span className="spinner" /> : currentGuardian ? 'Change guardian' : 'Set guardian'}
              </button>

              {/* Acting as someone else's guardian */}
              <div className="card-md" data-testid="act-as-guardian" style={{ marginTop: '1rem' }}>
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', marginBottom: '0.375rem' }}>
                  SOMEONE NOMINATED YOU?
                </p>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)', lineHeight: 1.6, marginBottom: '0.75rem' }}>
                  Start a recovery for a wallet that nominated this account
                  {' '}(<span className="mono" style={{ fontSize: '0.6875rem', userSelect: 'all' }}>{(() => { try { return getSignerKeypair().publicKey() } catch { return 'no session key' } })()}</span>)
                  {' '}as its guardian. The owner sends you their wallet address and the new public
                  key from their fresh device; the replacement only takes effect after the{' '}
                  {Math.round(GUARDIAN_DELAY_SECONDS / 86_400)}-day waiting period, and they can
                  cancel it until then.
                </p>
                <input
                  className="input-field mono"
                  type="text"
                  placeholder="Wallet to recover (C...)"
                  value={recoverWallet}
                  onChange={e => setRecoverWallet(e.target.value.trim())}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ marginBottom: '0.625rem' }}
                />
                <input
                  className="input-field mono"
                  type="text"
                  placeholder="New public key (130 hex chars, starts 04…)"
                  value={recoverNewKeyHex}
                  onChange={e => setRecoverNewKeyHex(e.target.value.trim())}
                  autoComplete="off"
                  spellCheck={false}
                  style={{ marginBottom: '0.75rem' }}
                />
                <button className="btn-gold" onClick={handleInitiateAsGuardian} disabled={loading}>
                  {loading ? <span className="spinner" /> : 'Initiate recovery'}
                </button>
              </div>
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

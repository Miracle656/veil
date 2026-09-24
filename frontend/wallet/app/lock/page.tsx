'use client'

import { NetworkSwitcher } from '@/components/NetworkSwitcher'
import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { LockKeyhole, Fingerprint, AlertCircle } from 'lucide-react'
import { computeWalletAddress, useInvisibleWallet, matchWebAuthnSigner, decryptBackup, deserializeBackup, type WalletBackupMetadata } from '@veil/sdk'
import { establishFreshFeePayer, ensureFeePayer } from '@/lib/feePayer'
import { FEE_PAYER_PRF_SALT, type PrfEvaluator } from '@veil/prf'
import { getNetwork, getNetworkName, walletConfig } from '@/lib/network'
import { adoptPasskeyFromOtherNetwork, walletLocal, walletSession } from '@/lib/walletStorage'
import { passkeyErrorMessage } from '@/lib/passkeyAuth'
import { persistRestoredState } from '@/lib/backup'
import { Account, BASE_FEE, Contract, Keypair, rpc as SorobanRpc, TransactionBuilder } from '@stellar/stellar-sdk'

/**
 * The active network's wallet address for a stored passkey public key, or null.
 *
 * Accepts the 65-byte uncompressed key as hex or base64, since both encodings
 * have been written to this slot over time; anything else is treated as absent
 * rather than guessed at.
 */
function deriveAddressForActiveNetwork(stored: string | null): string | null {
  if (!stored) return null
  let bytes: Uint8Array | null = null
  const trimmed = stored.trim()
  if (/^[0-9a-fA-F]{130}$/.test(trimmed)) {
    bytes = new Uint8Array(trimmed.match(/.{2}/g)!.map((h) => parseInt(h, 16)))
  } else {
    try {
      const bin = atob(trimmed.replace(/-/g, '+').replace(/_/g, '/'))
      if (bin.length === 65) bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
    } catch {
      bytes = null
    }
  }
  if (!bytes || bytes.length !== 65 || bytes[0] !== 0x04) return null
  const net = getNetwork()
  if (!net.factoryContractId) return null
  try {
    return computeWalletAddress(net.factoryContractId, bytes, net.networkPassphrase)
  } catch {
    return null
  }
}

async function readWalletSignerKeys(address: string): Promise<Uint8Array[]> {
  const network = getNetwork()
  const source = new Account(Keypair.random().publicKey(), '0')
  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: network.networkPassphrase,
  })
    .addOperation(new Contract(address).call('get_signers'))
    .setTimeout(30)
    .build()
  const simulation = await new SorobanRpc.Server(network.rpcUrl).simulateTransaction(tx)
  if (SorobanRpc.Api.isSimulationError(simulation)) throw new Error('Could not read this wallet on the selected network.')
  const retval = simulation.result?.retval
  if (!retval) throw new Error('This address is not a deployed Veil wallet.')
  try {
    return retval.map()?.map((entry) => new Uint8Array(entry.val().bytes())) ?? []
  } catch {
    throw new Error('This address is not a deployed Veil wallet.')
  }
}

async function authenticateAgainstSigners(signers: Uint8Array[]): Promise<{ credentialId: string; publicKey: string }> {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [],
      userVerification: 'required',
    },
  }) as PublicKeyCredential | null
  if (!assertion) throw new Error('Passkey prompt was cancelled.')
  const response = assertion.response as AuthenticatorAssertionResponse
  const matched = await matchWebAuthnSigner(signers, {
    authenticatorData: response.authenticatorData,
    clientDataJSON: response.clientDataJSON,
    signature: response.signature,
  })
  if (!matched) throw new Error('This passkey is not a registered signer on that wallet.')
  return { credentialId: assertion.id, publicKey: matched }
}

// ── Lock screen ───────────────────────────────────────────────────────────────
export default function LockPage() {
  const router = useRouter()

  const wallet = useInvisibleWallet(walletConfig)

  const [error, setError]           = useState<string | null>(null)
  const [isUnlocking, setIsUnlocking] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState<'address' | 'backup' | null>(null)
  const [recoveryAddress, setRecoveryAddress] = useState('')
  const [backupPassphrase, setBackupPassphrase] = useState('')
  const [backupFile, setBackupFile] = useState<File | null>(null)

  const finishAddressRecovery = useCallback(async (metadata: WalletBackupMetadata, credentialId: string, publicKey: string) => {
    walletLocal.setItem('invisible_wallet_address', metadata.address)
    walletLocal.setItem('invisible_wallet_key_id', credentialId)
    walletLocal.setItem('invisible_wallet_public_key', publicKey)
    walletSession.setItem('invisible_wallet_address', metadata.address)
    establishFreshFeePayer()
    router.replace('/dashboard')
  }, [router])

  const handleAddressRecovery = useCallback(async () => {
    const address = recoveryAddress.trim()
    if (!/^C[A-Z2-7]{55}$/.test(address)) {
      setError('Enter a valid 56-character C... wallet address.')
      return
    }
    setError(null)
    setIsUnlocking(true)
    try {
      const signers = await readWalletSignerKeys(address)
      if (signers.length === 0) throw new Error('This wallet has no registered signers.')
      const identity = await authenticateAgainstSigners(signers)
      await finishAddressRecovery({ version: 1, address, signers: signers.map((publicKey, index) => ({ index, publicKey: Array.from(publicKey, (byte) => byte.toString(16).padStart(2, '0')).join('') })), createdAt: Date.now() }, identity.credentialId, identity.publicKey)
    } catch (err: unknown) {
      setError(passkeyErrorMessage(err))
    } finally {
      setIsUnlocking(false)
    }
  }, [finishAddressRecovery, recoveryAddress])

  const handleBackupRecovery = useCallback(async () => {
    if (!backupFile || !backupPassphrase) {
      setError('Choose a backup file and enter its passphrase.')
      return
    }
    setError(null)
    setIsUnlocking(true)
    try {
      const metadata = JSON.parse(await backupFile.text())
      const restored = await decryptBackup(deserializeBackup(metadata), backupPassphrase)
      const signers = await readWalletSignerKeys(restored.address)
      const identity = await authenticateAgainstSigners(signers)
      await persistRestoredState(restored)
      await finishAddressRecovery(restored, identity.credentialId, identity.publicKey)
      setBackupPassphrase('')
    } catch (err: unknown) {
      setError(passkeyErrorMessage(err))
    } finally {
      setIsUnlocking(false)
    }
  }, [backupFile, backupPassphrase, finishAddressRecovery])

  const handleUnlock = useCallback(async () => {
    setError(null)
    setIsUnlocking(true)

    try {
      // Step 1 — Require a real WebAuthn biometric assertion.
      // wallet.login() only checks localStorage + chain; it doesn't prompt the
      // device. We call navigator.credentials.get() with userVerification:
      // 'required' so the OS always shows Face ID / fingerprint / Windows Hello.
      // A passkey created on the other network is still this user's passkey.
      // Without this, switching to mainnet on this screen read an empty slot
      // and said "register again" to someone whose passkey worked perfectly.
      adoptPasskeyFromOtherNetwork()

      const keyId = walletLocal.getItem('invisible_wallet_key_id')
      if (!keyId) {
        setError('No passkey is saved in this browser yet. Create a wallet to set one up.')
        return
      }

      // For a PRF wallet we reuse this single unlock assertion to also derive the
      // fee-payer seed (ADR 0003) — piggybacking the PRF evaluation avoids a
      // second biometric prompt.
      let prfEvaluator: PrfEvaluator | undefined

      if (keyId !== 'recovery') {
        // Decode base64url key ID → ArrayBuffer
        const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
        const binary = atob(padded)
        const idBuffer = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) idBuffer[i] = binary.charCodeAt(i)

        const challenge = crypto.getRandomValues(new Uint8Array(32))
        const saltBuf = new Uint8Array(FEE_PAYER_PRF_SALT).buffer
        const assertion = (await navigator.credentials.get({
          publicKey: {
            challenge,
            allowCredentials: [{ id: idBuffer, type: 'public-key' }],
            userVerification: 'required',
            extensions: { prf: { eval: { first: saltBuf } } } as AuthenticationExtensionsClientInputs,
          },
        })) as PublicKeyCredential | null

        const prfFirst = (
          assertion?.getClientExtensionResults() as {
            prf?: { results?: { first?: ArrayBuffer | ArrayBufferView } }
          }
        )?.prf?.results?.first
        if (prfFirst) {
          const bytes =
            prfFirst instanceof ArrayBuffer
              ? new Uint8Array(prfFirst)
              : new Uint8Array((prfFirst as ArrayBufferView).buffer)
          prfEvaluator = async () => bytes
        }
      }

      // Step 2 — Biometric confirmed; verify wallet exists on-chain and restore session.
      const result = await wallet.login()
      let sessionAddress = result?.walletAddress ?? null

      // login() only succeeds for a wallet already on chain. Wallets are now
      // created off-chain and deployed on first use, so "not deployed yet" is
      // a normal state, not a missing wallet. The address is a pure function of
      // the factory, the network and the passkey's public key, and the
      // assertion above already proved this person holds that passkey — so the
      // derived address is theirs whether or not the contract exists yet.
      if (!sessionAddress) {
        const derived = deriveAddressForActiveNetwork(
          walletLocal.getItem('invisible_wallet_public_key'),
        )
        if (derived) {
          const onChain = await wallet.login({ walletAddress: derived })
          sessionAddress = onChain?.walletAddress ?? derived
          walletLocal.setItem('invisible_wallet_address', sessionAddress)
        } else {
          sessionAddress = walletLocal.getItem('invisible_wallet_address')
        }
      }

      if (!sessionAddress) {
        // The passkey is real; this network just has no wallet for it yet.
        // Sending them to create one reuses the passkey — the create flow skips
        // registration when one is stored — instead of registering a second.
        setError(
          getNetworkName() === 'mainnet'
            ? 'Your passkey has no mainnet wallet yet. Taking you to create it…'
            : 'Your passkey has no wallet on this network yet. Taking you to create it…',
        )
        setTimeout(() => router.replace('/'), 1400)
        return
      }

      const existing = walletSession.getItem('invisible_wallet_address')
      if (existing && existing !== sessionAddress) {
        sessionStorage.clear()
        setError('Account mismatch detected. Please register again.')
        return
      }
      walletSession.setItem('invisible_wallet_address', sessionAddress)

      // Re-establish the fee-payer for this session. PRF wallets re-derive the
      // seed from the assertion above (no extra prompt) and keep it in
      // sessionStorage only — nothing plaintext is restored to localStorage, so
      // the lock actually protects the key at rest (ADR 0003, C3). Legacy wallets
      // restore from localStorage without a prompt. Best-effort — a failure here
      // must not block entry to the dashboard.
      await ensureFeePayer(prfEvaluator).catch(() => null)

      router.replace('/dashboard')

    } catch (err: unknown) {
      setError(passkeyErrorMessage(err))
    } finally {
      setIsUnlocking(false)
    }
  }, [wallet, router])

  return (
    <div
      className="wallet-shell"
      style={{ justifyContent: 'center', alignItems: 'center', padding: '2rem 1.25rem' }}
    >
      <div style={{ maxWidth: 400, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2.5rem' }}>
        <div style={{ width: '100%', maxWidth: 260, margin: '0 auto 1.75rem' }}>
          <NetworkSwitcher />
        </div>

        <header style={{ padding: '1rem 1.25rem', display: 'flex', justifyContent: 'center' }}>
           {/* Veil wordmark — Anton ALL CAPS per Stellar brand manual */}
        <span style={{ fontFamily: 'Anton, Impact, sans-serif', fontSize: '2rem', letterSpacing: '0.08em', color: 'var(--gold)', userSelect: 'none' }}>
          VEIL
        </span>
        </header>
       
        <main style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '2rem 1.25rem' }}>
        {/* Lock card */}
        <div
          className="card"
          style={{ maxWidth:400, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2.5rem'}}
        >
          {/* Lock icon */}
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: 'var(--surface-md)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <LockKeyhole size={28} color="rgba(246,247,248,0.6)" strokeWidth={1.5} />
          </div>

          {/* Copy — heading uses Lora SemiBold Italic per brand */}
          <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
            <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.25rem', color: 'var(--off-white)' }}>
              Wallet locked
            </h1>
            <p className='text-muted'>
              Your session was locked after a period of inactivity.
              <br />
              Verify your identity to continue.
            </p>
          </div>

          {/* Error state */}
          {error && (
            <div style={{
              width: '100%', display: 'flex', alignItems: 'flex-start', gap: '0.625rem',
              borderRadius: 12, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.20)',
              padding: '0.75rem 1rem',
            }}>
              <AlertCircle size={16} color="rgba(252,165,165,1)" strokeWidth={1.5} style={{ flexShrink: 0, marginTop: 2 }} />
              <p style={{ fontSize: '0.875rem', color: 'rgba(252,165,165,1)', lineHeight: 1.4 }}>{error}</p>
            </div>
          )}

          {/* Unlock button — .btn-gold from globals.css */}
          <button
            type="button"
            onClick={handleUnlock}
            disabled={isUnlocking || wallet.isPending}
            className="btn-gold"
          >
            <Fingerprint size={20} strokeWidth={1.5} />
            {isUnlocking || wallet.isPending ? 'Verifying…' : 'Unlock with passkey'}
          </button>

          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <button type="button" className="btn-secondary" onClick={() => { setRecoveryMode(recoveryMode === 'address' ? null : 'address'); setError(null) }}>
              Sign in with wallet address
            </button>
            <button type="button" className="btn-secondary" onClick={() => { setRecoveryMode(recoveryMode === 'backup' ? null : 'backup'); setError(null) }}>
              Restore from backup file
            </button>

            {recoveryMode === 'address' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <input
                  value={recoveryAddress}
                  onChange={(event) => setRecoveryAddress(event.target.value.toUpperCase())}
                  placeholder="C... wallet address"
                  autoCapitalize="characters"
                  spellCheck={false}
                  style={{ width: '100%', padding: '0.75rem', borderRadius: 8, border: '1px solid var(--border-dim)', background: 'var(--surface-md)', color: 'var(--off-white)' }}
                />
                <button type="button" className="btn-gold" onClick={handleAddressRecovery} disabled={isUnlocking}>
                  Verify address
                </button>
              </div>
            )}

            {recoveryMode === 'backup' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem' }}>
                <input type="file" accept=".json,.veilbackup.json,application/json" onChange={(event) => setBackupFile(event.target.files?.[0] ?? null)} />
                <input
                  type="password"
                  value={backupPassphrase}
                  onChange={(event) => setBackupPassphrase(event.target.value)}
                  placeholder="Backup passphrase"
                  autoComplete="current-password"
                  style={{ width: '100%', padding: '0.75rem', borderRadius: 8, border: '1px solid var(--border-dim)', background: 'var(--surface-md)', color: 'var(--off-white)' }}
                />
                <button type="button" className="btn-gold" onClick={handleBackupRecovery} disabled={isUnlocking}>
                  Verify and restore
                </button>
              </div>
            )}
          </div>

          {/* Subtle hint */}
          <p style={{ fontSize: '0.75rem', color: 'var(--color-muted)', textAlign: 'center' }}>
            Your biometric is your key — no password needed.
          </p>
        </div>
        </main>
      </div>
    </div>
  )
}


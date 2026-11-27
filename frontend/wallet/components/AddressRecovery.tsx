'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle } from 'lucide-react'
import { decryptBackup, deserializeBackup, type WalletBackupMetadata } from '@veil/backup'
import { matchWebAuthnSigner, recoverWalletByAddress } from '@veil/sdk/recovery/signerVerification'
import { persistRestoredState } from '@/lib/backup'
import { ensureFeePayer } from '@/lib/feePayer'
import { getNetwork } from '@/lib/network'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { NetworkSwitcher } from '@/components/NetworkSwitcher'

type DiscoveredAssertion = {
  credentialId: string
  authenticatorData: ArrayBuffer
  clientDataJSON: ArrayBuffer
  signature: ArrayBuffer
}

function asArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

async function getAssertion(expectedChallenge: Uint8Array): Promise<DiscoveredAssertion | null> {
  const challengeBuffer = asArrayBuffer(expectedChallenge)
  const assertion = await (navigator.credentials as any).get({
    publicKey: {
      challenge: challengeBuffer,
      allowCredentials: [],
      userVerification: 'required',
    },
  }) as PublicKeyCredential | null
  if (!assertion) return null
  const credentialResponse = assertion.response as AuthenticatorAssertionResponse
  return {
    credentialId: assertion.id,
    authenticatorData: credentialResponse.authenticatorData,
    clientDataJSON: credentialResponse.clientDataJSON,
    signature: credentialResponse.signature,
  }
}

export function AddressRecovery() {
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (walletLocal.getItem('invisible_wallet_address')) {
      router.replace('/lock')
    }
  }, [router])

  async function recover(backup?: WalletBackupMetadata) {
    if (walletLocal.getItem('invisible_wallet_address')) {
      router.replace('/lock')
      return
    }

    const selectedAddress = backup?.address ?? address.trim()
    setError(null)
    setBusy(true)
    try {
      const network = getNetwork()
      if (backup?.networkPassphrase && backup.networkPassphrase !== network.networkPassphrase) {
        throw new Error('This backup belongs to a different Stellar network. Switch networks and try again.')
      }
      const assertionRef = { value: null as DiscoveredAssertion | null }
      const expectedChallenge = crypto.getRandomValues(new Uint8Array(32))

      // The wallet's stored WebAuthn origin is deliberately NOT checked here.
      // A wallet made in the mobile app cannot sign for its contract on the web,
      // but the passkey matches an on-chain signer, and the spending account is an
      // ordinary Stellar account whose key this passkey rebuilds.
      const result = await recoverWalletByAddress(selectedAddress, {
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        authenticate: async (signers) => {
          assertionRef.value = await getAssertion(expectedChallenge)
          if (!assertionRef.value) throw new Error('Passkey prompt was cancelled.')
          return matchWebAuthnSigner(signers, assertionRef.value, {
            challenge: expectedChallenge,
            expectedType: 'webauthn.get',
          })
        },
      })
      const assertion = assertionRef.value
      if (!assertion) throw new Error('Passkey prompt was cancelled.')

      if (backup) await persistRestoredState(backup)
      walletLocal.setItem('invisible_wallet_address', result.address)
      walletLocal.setItem('invisible_wallet_key_id', assertion.credentialId)
      walletLocal.setItem('invisible_wallet_public_key', result.publicKey)
      walletSession.setItem('invisible_wallet_address', result.address)

      // Establish fee-payer via the standard path. Never delete an existing stored spending key.
      await ensureFeePayer()

      setPassphrase('')
      router.replace('/dashboard')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function restoreBackup() {
    if (!file || !passphrase) {
      setError('Choose a backup file and enter its passphrase.')
      return
    }
    setError(null)
    setBusy(true)
    try {
      const envelope = deserializeBackup(await file.text())
      const metadata = await decryptBackup(envelope, passphrase)
      await recover(metadata)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <main className="wallet-shell" style={{ minHeight: '100dvh', justifyContent: 'center', alignItems: 'center', padding: '2rem 1.25rem' }}>
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <NetworkSwitcher />
        <section className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h1 style={{ fontFamily: 'Lora, Georgia, serif', color: 'var(--off-white)', fontSize: '1.25rem' }}>Sign in to your wallet</h1>
          <p className="text-muted">Use your wallet address or encrypted backup, then verify with a registered passkey.</p>
          {error && (
            <div role="alert" style={{ display: 'flex', gap: '0.625rem', color: 'rgba(252,165,165,1)' }}>
              <AlertCircle size={17} />
              <span>{error}</span>
            </div>
          )}
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            Wallet address
            <input value={address} onChange={(event) => setAddress(event.target.value.trimStart())} placeholder="C..." autoCapitalize="characters" spellCheck={false} />
          </label>
          <button className="btn-gold" type="button" onClick={() => void recover()} disabled={busy}>
            {busy ? 'Verifying…' : 'Verify address'}
          </button>
          <hr />
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            Encrypted backup file
            <input type="file" accept=".json,.veilbackup.json,application/json" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </label>
          <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder="Backup passphrase" autoComplete="current-password" />
          <button className="btn-secondary" type="button" onClick={() => void restoreBackup()} disabled={busy}>
            {busy ? 'Verifying…' : 'Verify and restore backup'}
          </button>
        </section>
      </div>
    </main>
  )
}

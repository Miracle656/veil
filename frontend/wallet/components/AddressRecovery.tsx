'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle } from 'lucide-react'
import { decryptBackup, deserializeBackup, type WalletBackupMetadata } from '@veil/backup'
import { matchWebAuthnSigner, recoverWalletByAddress } from '@veil/sdk/recovery/signerVerification'
import { FEE_PAYER_PRF_SALT } from '@veil/prf'
import { persistRestoredState } from '@/lib/backup'
import { establishRecoveredFeePayer, FeePayerConflictError } from '@/lib/feePayer'
import { getNetwork } from '@/lib/network'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { NetworkSwitcher } from '@/components/NetworkSwitcher'

type DiscoveredAssertion = {
  credentialId: string
  authenticatorData: ArrayBuffer
  clientDataJSON: ArrayBuffer
  signature: ArrayBuffer
  prf: Uint8Array | null
}

function asArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

async function getAssertion(): Promise<DiscoveredAssertion | null> {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [],
      userVerification: 'required',
      extensions: { prf: { eval: { first: FEE_PAYER_PRF_SALT.buffer.slice(0) } } } as AuthenticationExtensionsClientInputs,
    },
  }) as PublicKeyCredential | null
  if (!assertion) return null
  const credentialResponse = assertion.response as AuthenticatorAssertionResponse
  const prfResult = (assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer | ArrayBufferView } }
  }).prf?.results?.first
  return {
    credentialId: assertion.id,
    authenticatorData: credentialResponse.authenticatorData,
    clientDataJSON: credentialResponse.clientDataJSON,
    signature: credentialResponse.signature,
    prf: prfResult ? new Uint8Array(asArrayBuffer(prfResult)) : null,
  }
}

export function AddressRecovery() {
  const router = useRouter()
  const [address, setAddress] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmFeePayerReplacement, setConfirmFeePayerReplacement] = useState(false)
  const [pendingBackup, setPendingBackup] = useState<WalletBackupMetadata | undefined>(undefined)

  async function recover(backup?: WalletBackupMetadata, replaceFeePayer = false) {
    const selectedAddress = backup?.address ?? address.trim()
    setError(null)
    setConfirmFeePayerReplacement(false)
    setBusy(true)
    try {
      const network = getNetwork()
      if (backup?.networkPassphrase && backup.networkPassphrase !== network.networkPassphrase) {
        throw new Error('This backup belongs to a different Stellar network. Switch networks and try again.')
      }
      const assertionRef = { value: null as DiscoveredAssertion | null }
      const result = await recoverWalletByAddress(selectedAddress, {
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        authenticate: async (signers) => {
          assertionRef.value = await getAssertion()
          if (!assertionRef.value) throw new Error('Passkey prompt was cancelled.')
          return matchWebAuthnSigner(signers, assertionRef.value)
        },
      })
      const assertion = assertionRef.value
      if (!assertion) throw new Error('Passkey prompt was cancelled.')

      await establishRecoveredFeePayer(assertion.prf, assertion.credentialId, replaceFeePayer)
      if (backup) await persistRestoredState(backup)
      walletLocal.setItem('invisible_wallet_address', result.address)
      walletLocal.setItem('invisible_wallet_key_id', assertion.credentialId)
      walletLocal.setItem('invisible_wallet_public_key', result.publicKey)
      walletSession.setItem('invisible_wallet_address', result.address)
      setPassphrase('')
      router.replace('/dashboard')
    } catch (cause) {
      if (cause instanceof FeePayerConflictError) {
        setPendingBackup(backup)
        setError('A fee-payer from another wallet is stored in this browser. Replacing it removes that secret here and may make its funds inaccessible without another backup.')
        setConfirmFeePayerReplacement(true)
        return
      }
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
          {confirmFeePayerReplacement && (
            <button className="btn-secondary" type="button" onClick={() => void recover(pendingBackup, true)} disabled={busy}>
              Confirm replacement and verify again
            </button>
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

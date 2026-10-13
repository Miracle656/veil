'use client'

import { NetworkSwitcher } from '@/components/NetworkSwitcher'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { VeilMark } from '@/components/ui/VeilMark'
import { bufferToHex } from '@veil/utils'
import { matchWebAuthnSigner, recoverWalletByAddress } from '@veil/sdk/recovery/signerVerification'
import { establishRecoveredFeePayer } from '@/lib/feePayer'
import { getNetwork } from '@/lib/network'
import { FEE_PAYER_PRF_SALT } from '@veil/prf'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { deriveP256KeyPair } from '@/lib/recovery'
import { walletLocal, walletSession } from '@/lib/walletStorage'

const network = getNetwork()

type Step = 'idle' | 'authenticating' | 'done' | 'error'

export default function RecoverPage() {
  const router = useRouter()
  const [step, setStep]               = useState<Step>('idle')
  const [error, setError]             = useState<string | null>(null)
  const [walletInput, setWalletInput] = useState('')
  const [tab, setTab]                 = useState<'passkey' | 'paper'>('passkey')
  const [mnemonicInput, setMnemonicInput] = useState('')

  async function handleRecover() {
    const walletAddress = walletInput.trim()
    if (!StrKey.isValidContract(walletAddress)) {
      setError('Enter a valid C... wallet address.')
      return
    }

    setError(null)
    setStep('authenticating')

    try {
      const assertionRef = { value: null as PublicKeyCredential | null }
      const recovered = await recoverWalletByAddress(walletAddress, {
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        authenticate: async (signers) => {
          assertionRef.value = await navigator.credentials.get({
            publicKey: {
              challenge: crypto.getRandomValues(new Uint8Array(32)),
              allowCredentials: [],
              userVerification: 'required',
              extensions: { prf: { eval: { first: FEE_PAYER_PRF_SALT.buffer.slice(0) } } } as AuthenticationExtensionsClientInputs,
            },
          }) as PublicKeyCredential | null
          if (!assertionRef.value) throw new Error('Passkey prompt was cancelled.')
          const response = assertionRef.value.response as AuthenticatorAssertionResponse
          return matchWebAuthnSigner(signers, {
            authenticatorData: response.authenticatorData,
            clientDataJSON: response.clientDataJSON,
            signature: response.signature,
          })
        },
      })
      const assertion = assertionRef.value
      if (!assertion) throw new Error('Passkey prompt was cancelled.')
      const matchedHex = recovered.publicKey
      const prfResult = (assertion.getClientExtensionResults() as {
        prf?: { results?: { first?: ArrayBuffer | ArrayBufferView } }
      }).prf?.results?.first
      const prf = prfResult
        ? new Uint8Array(prfResult instanceof ArrayBuffer
          ? prfResult
          : prfResult.buffer.slice(prfResult.byteOffset, prfResult.byteOffset + prfResult.byteLength))
        : null

      // Preserve any existing fee-payer instead of deleting it on recovery.
      await establishRecoveredFeePayer(prf, assertion.id)

      // ── 4. Restore localStorage + session ────────────────────────────────
      walletLocal.setItem('invisible_wallet_address',    recovered.address)
      walletLocal.setItem('invisible_wallet_key_id',     assertion.id)
      walletLocal.setItem('invisible_wallet_public_key', matchedHex)
      walletSession.setItem('invisible_wallet_address', recovered.address)

      setStep('done')
      setTimeout(() => router.push('/dashboard'), 800)

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(
        msg.includes('NotAllowedError') || msg.includes('not allowed')
          ? 'Biometric verification was cancelled. Please try again.'
          : msg
      )
      setStep('error')
    }
  }

  async function handlePaperRecover() {
    const walletAddress = walletInput.trim()
    if (!StrKey.isValidContract(walletAddress)) {
      setError('Enter a valid C... wallet address.')
      return
    }
    const mnemonic = mnemonicInput.trim()
    if (mnemonic.split(/\s+/).length !== 12) {
      setError('Enter a valid 12-word recovery phrase.')
      return
    }

    setError(null)
    setStep('authenticating')

    try {
      // Derive keypair from paper phrase
      const { publicKey, privateKey } = deriveP256KeyPair(mnemonic)
      const matchedHex = bufferToHex(publicKey)
      const recovered = await recoverWalletByAddress(walletAddress, {
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
        authenticate: async () => matchedHex,
      })

      // Preserve any existing fee-payer instead of overwriting it on recovery.
      const feePayerSeed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mnemonic))
      const recoveredFeePayer = Keypair.fromRawEd25519Seed(Buffer.from(new Uint8Array(feePayerSeed).slice(0, 32)))
      await establishRecoveredFeePayer(null, 'recovery', false, recoveredFeePayer)

      // Store in storage
      walletLocal.setItem('invisible_wallet_address',    recovered.address)
      walletLocal.setItem('invisible_wallet_key_id',     'recovery')
      walletLocal.setItem('invisible_wallet_public_key', matchedHex)
      walletSession.setItem('invisible_wallet_address', recovered.address)
      walletSession.setItem('invisible_wallet_recovery_private_key', bufferToHex(privateKey))

      setStep('done')
      setTimeout(() => router.push('/dashboard'), 800)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setStep('error')
    }
  }

  return (
    <div className="wallet-shell" style={{ justifyContent: 'center', alignItems: 'center', padding: '2rem 1.25rem', minHeight: '100dvh' }}>
      <main style={{ maxWidth: 400, width: '100%' }}>

        {/* Inside the landmark (axe "region" rule): the switcher used to sit
            above main on the lock screen's twin, which failed the audit. */}
        <div style={{ width: '100%', maxWidth: 260, margin: '0 auto 1.75rem' }}>
          <NetworkSwitcher />
        </div>


        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', marginBottom: '2.5rem' }}>
          <VeilMark size={48} />
          <div style={{ textAlign: 'center' }}>
            <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.75rem' }}>
              Recover wallet
            </h1>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.375rem', lineHeight: 1.6 }}>
              Enter your wallet address, then verify with your passkey
            </p>
          </div>
        </div>

        {(step === 'idle' || step === 'error') && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border-dim)', marginBottom: '1rem' }}>
              <button
                onClick={() => setTab('passkey')}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  background: 'none',
                  border: 'none',
                  color: tab === 'passkey' ? 'var(--teal)' : 'rgba(246,247,248,0.4)',
                  borderBottom: tab === 'passkey' ? '2px solid var(--teal)' : 'none',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                }}
              >
                Passkey
              </button>
              <button
                onClick={() => setTab('paper')}
                style={{
                  flex: 1,
                  padding: '0.75rem',
                  background: 'none',
                  border: 'none',
                  color: tab === 'paper' ? 'var(--teal)' : 'rgba(246,247,248,0.4)',
                  borderBottom: tab === 'paper' ? '2px solid var(--teal)' : 'none',
                  fontWeight: 600,
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                }}
              >
                Paper Backup
              </button>
            </div>

            <div>
              <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                WALLET ADDRESS
              </label>
              <input
                className="input-field mono"
                type="text"
                placeholder="C..."
                value={walletInput}
                onChange={e => { setWalletInput(e.target.value.trim()); setError(null) }}
                autoComplete="off"
                spellCheck={false}
              />
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.3)', marginTop: '0.5rem', lineHeight: 1.5 }}>
                Find this on another device where your wallet is open — it starts with C.
              </p>
            </div>

            {tab === 'paper' && (
              <div>
                <label style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', display: 'block', marginBottom: '0.5rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em' }}>
                  12-WORD RECOVERY PHRASE
                </label>
                <textarea
                  className="input-field mono"
                  placeholder="word1 word2 ..."
                  value={mnemonicInput}
                  onChange={e => { setMnemonicInput(e.target.value); setError(null) }}
                  rows={3}
                  style={{ resize: 'none', width: '100%' }}
                />
              </div>
            )}

            {error && (
              <div style={{ borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.18)', padding: '0.75rem 1rem' }}>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(252,165,165,1)', lineHeight: 1.5 }}>{error}</p>
              </div>
            )}

            {tab === 'passkey' ? (
              <button
                className="btn-gold"
                onClick={handleRecover}
                disabled={walletInput.length < 10}
              >
                Verify with passkey
              </button>
            ) : (
              <button
                className="btn-gold"
                onClick={handlePaperRecover}
                disabled={walletInput.length < 10 || mnemonicInput.trim().length === 0}
              >
                Recover with phrase
              </button>
            )}
            <button className="btn-ghost" onClick={() => router.push('/')}>
              Back
            </button>
          </div>
        )}

        {step === 'authenticating' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
              <div className="spinner spinner-light" />
            </div>
            <p style={{ fontWeight: 500 }}>Waiting for passkey...</p>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
              Approve the prompt on your device
            </p>
          </div>
        )}

        {step === 'done' && (
          <div className="card" style={{ textAlign: 'center' }}>
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ margin: '0 auto 0.75rem' }}>
              <circle cx="20" cy="20" r="19" stroke="var(--teal)" strokeWidth="1.5" />
              <path d="M13 20.5l5 5 9-9" stroke="var(--teal)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p style={{ fontWeight: 500 }}>Wallet recovered</p>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.375rem' }}>Redirecting to dashboard...</p>
          </div>
        )}
      </main>
    </div>
  )
}

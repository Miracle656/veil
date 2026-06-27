'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Horizon,
} from '@stellar/stellar-sdk'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork, walletConfig } from '@/lib/network'
import { VeilLogo } from '@/components/VeilLogo'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useInvisibleWallet } from '@veil/sdk'

const Server = Horizon.Server
const network = getNetwork()

type Step = 'address' | 'preview' | 'confirm' | 'success'

export default function DangerPage() {
  const router = useRouter()
  useInactivityLock()

  const wallet = useInvisibleWallet(walletConfig)

  const [step, setStep] = useState<Step>('address')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Account details
  const [feePayerAddress, setFeePayerAddress] = useState<string | null>(null)
  const [feePayerSecret, setFeePayerSecret] = useState<string | null>(null)
  const [currentBalance, setCurrentBalance] = useState<string>('0')

  // Inputs
  const [destinationAddress, setDestinationAddress] = useState('')
  const [confirmAddress, setConfirmAddress] = useState('')
  const [understandCheckbox, setUnderstandCheckbox] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  // Transaction output
  const [txHash, setTxHash] = useState<string | null>(null)

  // ── Load current user info ──────────────────────────────────────────────────
  useEffect(() => {
    const addr = sessionStorage.getItem('invisible_wallet_address')
    if (!addr) {
      router.replace('/lock')
      return
    }

    const secret =
      sessionStorage.getItem('veil_signer_secret') ||
      localStorage.getItem('veil_signer_secret')
    
    if (!secret) {
      setError('No fee-payer signing key found. Please set up your wallet first.')
      return
    }

    try {
      const kp = Keypair.fromSecret(secret)
      setFeePayerAddress(kp.publicKey())
      setFeePayerSecret(secret)
    } catch (e) {
      setError('Invalid local signing credentials. Please log in again.')
    }
  }, [router])

  // ── Fetch balance for Preview step ──────────────────────────────────────────
  const fetchBalance = useCallback(async () => {
    if (!feePayerAddress) return
    setLoading(true)
    setError(null)
    try {
      const server = new Server(network.horizonUrl)
      const account = await server.loadAccount(feePayerAddress)
      const native = account.balances.find((b: any) => b.asset_type === 'native')
      const bal = native ? native.balance : '0'
      setCurrentBalance(bal)
    } catch (err: any) {
      console.error(err)
      setError(
        err.status === 404
          ? 'Fee-payer account not found on-chain. It may have no balance or already been merged.'
          : 'Could not fetch current account balance. Please check your network connection.'
      )
    } finally {
      setLoading(false)
    }
  }, [feePayerAddress])

  useEffect(() => {
    if (step === 'preview') {
      fetchBalance()
    }
  }, [step, fetchBalance])

  // ── Step 1 Validation & Navigation ──────────────────────────────────────────
  const handleAddressNext = () => {
    setError(null)

    if (!destinationAddress) {
      setError('Destination address is required.')
      return
    }

    if (destinationAddress !== confirmAddress) {
      setError('Destination addresses do not match.')
      return
    }

    try {
      const kp = Keypair.fromPublicKey(destinationAddress)
      if (!destinationAddress.startsWith('G')) {
        throw new Error()
      }
    } catch {
      setError('Destination address must be a valid Stellar public key (starting with G).')
      return
    }

    if (destinationAddress === feePayerAddress) {
      setError('Destination address cannot be the same as your current fee-payer address.')
      return
    }

    setStep('preview')
  }

  // ── Execution of the Merge transaction ─────────────────────────────────────
  const handleMergeSubmit = async () => {
    if (!understandCheckbox) {
      setError('You must check the box to confirm you understand this is irreversible.')
      return
    }

    if (confirmText !== 'MERGE') {
      setError('Please type MERGE to proceed.')
      return
    }

    if (!feePayerSecret || !feePayerAddress) {
      setError('Signing key is missing. Aborting.')
      return
    }

    setLoading(true)
    setError(null)

    try {
      const server = new Server(network.horizonUrl)
      const sourceKeypair = Keypair.fromSecret(feePayerSecret)
      const account = await server.loadAccount(feePayerAddress)

      const transaction = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })
        .addOperation(
          Operation.accountMerge({
            destination: destinationAddress,
          })
        )
        .setTimeout(30)
        .build()

      transaction.sign(sourceKeypair)
      const result = await server.submitTransaction(transaction)

      setTxHash(result.hash)
      setStep('success')

      // Clear local wallet data
      localStorage.removeItem('veil_signer_secret')
      localStorage.removeItem('veil_signer_public_key')
      localStorage.removeItem('invisible_wallet_address')
      localStorage.removeItem('invisible_wallet_key_id')
      localStorage.removeItem('invisible_wallet_public_key')
      sessionStorage.removeItem('veil_signer_secret')
      sessionStorage.removeItem('veil_signer_public_key')
      sessionStorage.removeItem('invisible_wallet_address')

    } catch (err: any) {
      console.error(err)
      if (err.response?.data?.extras?.result_codes?.operations?.[0]) {
        const opCode = err.response.data.extras.result_codes.operations[0]
        if (opCode === 'op_has_sub_entries') {
          setError(
            'Merge failed: This account still has trustlines, active liquidity pools, or open offers. You must remove them before merging.'
          )
          return
        }
      }
      setError(
        err instanceof Error ? err.message : 'Stellar transaction submission failed.'
      )
    } finally {
      setLoading(false)
    }
  }

  const handleCancel = () => {
    router.push('/settings')
  }

  return (
    <div className="wallet-shell">
      {/* Navigation Bar */}
      <nav className="wallet-nav">
        <button
          onClick={handleCancel}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--off-white)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            fontSize: '0.875rem',
          }}
          disabled={loading}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M10 3L5 8l5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Settings
        </button>
        <VeilLogo size={22} />
        <ThemeToggle />
      </nav>

      {/* Main Area */}
      <main className="wallet-main" style={{ maxWidth: '480px', margin: '0 auto', padding: '2rem 1rem' }}>
        
        {/* Step Indicator Header (Hide on Success) */}
        {step !== 'success' && (
          <div style={{ marginBottom: '2rem', textAlign: 'center' }}>
            <h2
              style={{
                fontFamily: 'Lora, Georgia, serif',
                fontWeight: 600,
                fontStyle: 'italic',
                fontSize: '1.75rem',
                color: 'rgba(220, 38, 38, 0.95)',
                marginBottom: '0.5rem',
              }}
            >
              Account Merge
            </h2>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246, 247, 248, 0.4)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Step {step === 'address' ? '1' : step === 'preview' ? '2' : '3'} of 3
            </p>

            {/* Simple dot indicators */}
            <div style={{ display: 'flex', justifyContent: 'center', gap: '0.5rem', marginTop: '0.75rem' }}>
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: step === 'address' ? 'rgba(220,38,38,0.8)' : 'rgba(246,247,248,0.15)',
                  transition: 'background-color 0.2s',
                }}
              />
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: step === 'preview' ? 'rgba(220,38,38,0.8)' : 'rgba(246,247,248,0.15)',
                  transition: 'background-color 0.2s',
                }}
              />
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: step === 'confirm' ? 'rgba(220,38,38,0.8)' : 'rgba(246,247,248,0.15)',
                  transition: 'background-color 0.2s',
                }}
              />
            </div>
          </div>
        )}

        {/* Global Error Display */}
        {error && (
          <div
            className="card-md"
            style={{
              borderColor: 'rgba(220, 38, 38, 0.4)',
              background: 'rgba(220, 38, 38, 0.05)',
              marginBottom: '1.5rem',
              padding: '1rem',
            }}
          >
            <p style={{ fontSize: '0.875rem', color: 'rgba(248, 113, 113, 0.9)', lineHeight: 1.5 }}>
              {error}
            </p>
          </div>
        )}

        {/* STEP 1: Address Input */}
        {step === 'address' && (
          <div className="card" style={{ border: '1px solid rgba(220, 38, 38, 0.2)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <p style={{ fontSize: '0.875rem', color: 'rgba(246, 247, 248, 0.6)', lineHeight: 1.6 }}>
              Provide the destination Stellar account public key where you want all remaining funds transferred.
            </p>

            <div>
              <label
                style={{
                  fontSize: '0.75rem',
                  color: 'rgba(246, 247, 248, 0.4)',
                  display: 'block',
                  marginBottom: '0.5rem',
                  fontFamily: 'Anton, Impact, sans-serif',
                  letterSpacing: '0.06em',
                }}
              >
                Destination Address
              </label>
              <input
                className="input-field mono"
                type="text"
                placeholder="G..."
                value={destinationAddress}
                onChange={(e) => setDestinationAddress(e.target.value.trim())}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div>
              <label
                style={{
                  fontSize: '0.75rem',
                  color: 'rgba(246, 247, 248, 0.4)',
                  display: 'block',
                  marginBottom: '0.5rem',
                  fontFamily: 'Anton, Impact, sans-serif',
                  letterSpacing: '0.06em',
                }}
              >
                Re-enter Destination Address
              </label>
              <input
                className="input-field mono"
                type="text"
                placeholder="G..."
                value={confirmAddress}
                onChange={(e) => setConfirmAddress(e.target.value.trim())}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button
                className="btn-gold"
                style={{ flex: 1, backgroundColor: 'rgba(220, 38, 38, 0.85)', color: 'var(--off-white)' }}
                onClick={handleAddressNext}
              >
                Next Step
              </button>
              <button
                className="btn-ghost"
                style={{ flex: 1 }}
                onClick={handleCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: Balance Preview */}
        {step === 'preview' && (
          <div className="card" style={{ border: '1px solid rgba(220, 38, 38, 0.2)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div style={{ borderBottom: '1px solid var(--border-dim)', paddingBottom: '1rem' }}>
              <p
                style={{
                  fontSize: '0.75rem',
                  color: 'rgba(246,247,248,0.4)',
                  fontFamily: 'Anton, Impact, sans-serif',
                  letterSpacing: '0.06em',
                  marginBottom: '0.25rem',
                }}
              >
                ACCOUNT TO MERGE
              </p>
              <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8125rem', color: 'var(--off-white)', wordBreak: 'break-all' }}>
                {feePayerAddress}
              </p>
            </div>

            <div style={{ borderBottom: '1px solid var(--border-dim)', paddingBottom: '1rem' }}>
              <p
                style={{
                  fontSize: '0.75rem',
                  color: 'rgba(246,247,248,0.4)',
                  fontFamily: 'Anton, Impact, sans-serif',
                  letterSpacing: '0.06em',
                  marginBottom: '0.25rem',
                }}
              >
                TRANSFERRING BALANCE
              </p>
              <p style={{ fontSize: '1.5rem', fontWeight: 600, color: 'var(--gold)' }}>
                {loading ? 'Fetching...' : `${currentBalance} XLM`}
              </p>
            </div>

            <div style={{ borderBottom: '1px solid var(--border-dim)', paddingBottom: '1rem' }}>
              <p
                style={{
                  fontSize: '0.75rem',
                  color: 'rgba(246,247,248,0.4)',
                  fontFamily: 'Anton, Impact, sans-serif',
                  letterSpacing: '0.06em',
                  marginBottom: '0.25rem',
                }}
              >
                RECIPIENT ADDRESS
              </p>
              <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.8125rem', color: 'var(--off-white)', wordBreak: 'break-all' }}>
                {destinationAddress}
              </p>
            </div>

            <div className="card-md" style={{ borderLeft: '3px solid rgba(220, 38, 38, 0.8)', paddingLeft: '1rem' }}>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246, 247, 248, 0.5)', lineHeight: 1.5 }}>
                Stellar native account merge transfers the remaining XLM and closes the account. Any trustlines, open offers, or remaining non-native balances will block the transaction on-chain.
              </p>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button
                className="btn-gold"
                style={{ flex: 1, backgroundColor: 'rgba(220, 38, 38, 0.85)', color: 'var(--off-white)' }}
                onClick={() => setStep('confirm')}
                disabled={loading || !!error}
              >
                Next Step
              </button>
              <button
                className="btn-ghost"
                style={{ flex: 1 }}
                onClick={() => setStep('address')}
                disabled={loading}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {/* STEP 3: Confirm & Irreversible Checkbox */}
        {step === 'confirm' && (
          <div className="card" style={{ border: '1px solid rgba(220, 38, 38, 0.3)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div className="card-md" style={{ borderLeft: '3px solid rgb(220, 38, 38)', paddingLeft: '1rem', background: 'rgba(220,38,38,0.03)' }}>
              <p style={{ fontWeight: 600, fontSize: '0.875rem', color: 'rgb(248, 113, 113)', marginBottom: '0.25rem' }}>
                Irreversible Action
              </p>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246, 247, 248, 0.5)', lineHeight: 1.5 }}>
                You are about to delete this account. You will lose access to its transaction history and address. Ensure the destination address is correct.
              </p>
            </div>

            {/* Checkbox */}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={understandCheckbox}
                onChange={(e) => setUnderstandCheckbox(e.target.checked)}
                style={{ marginTop: '0.25rem', cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.875rem', color: 'rgba(246, 247, 248, 0.8)', lineHeight: 1.5 }}>
                I understand that this action is irreversible and the account will be permanently deleted.
              </span>
            </label>

            {/* Text confirmation */}
            <div>
              <label
                style={{
                  fontSize: '0.75rem',
                  color: 'rgba(246, 247, 248, 0.4)',
                  display: 'block',
                  marginBottom: '0.5rem',
                  fontFamily: 'Anton, Impact, sans-serif',
                  letterSpacing: '0.06em',
                }}
              >
                Type &quot;MERGE&quot; to confirm
              </label>
              <input
                className="input-field"
                type="text"
                placeholder="MERGE"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
              <button
                className="btn-gold"
                style={{
                  flex: 1,
                  backgroundColor: 'rgb(220, 38, 38)',
                  color: 'var(--off-white)',
                }}
                onClick={handleMergeSubmit}
                disabled={loading || !understandCheckbox || confirmText !== 'MERGE'}
              >
                {loading ? <span className="spinner spinner-light" /> : 'Merge Account'}
              </button>
              <button
                className="btn-ghost"
                style={{ flex: 1 }}
                onClick={() => setStep('preview')}
                disabled={loading}
              >
                Back
              </button>
            </div>
          </div>
        )}

        {/* SUCCESS STATE */}
        {step === 'success' && (
          <div className="card" style={{ border: '1px solid var(--teal)', display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.5rem' }}>
              <div
                style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  background: 'rgba(0, 167, 181, 0.1)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--teal)',
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M20 6L9 17l-5-5"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>

            <h3 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.5rem', color: 'var(--teal)' }}>
              Merge Successful
            </h3>

            <p style={{ fontSize: '0.875rem', color: 'rgba(246, 247, 248, 0.6)', lineHeight: 1.6 }}>
              The account has been merged and deleted. All remaining funds have been sent to the destination address. Your local session has been cleared.
            </p>

            {txHash && (
              <div className="card-md" style={{ background: 'rgba(255,255,255,0.02)', padding: '0.75rem', wordBreak: 'break-all' }}>
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.25rem' }}>
                  TRANSACTION HASH
                </p>
                <a
                  href={`https://stellar.expert/explorer/${network.name === 'mainnet' ? 'public' : 'testnet'}/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontFamily: 'Inconsolata, monospace',
                    fontSize: '0.75rem',
                    color: 'var(--teal)',
                    textDecoration: 'underline',
                  }}
                >
                  {txHash}
                </a>
              </div>
            )}

            <button
              className="btn-gold"
              style={{ marginTop: '0.5rem' }}
              onClick={() => router.push('/')}
            >
              Return Home
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

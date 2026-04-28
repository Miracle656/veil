'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'
import { VeilLogo } from '@/components/VeilLogo'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'
import { requirePasskey } from '@/lib/passkeyAuth'
import { signAndSubmitSorobanXdr } from '@/lib/sorobanTx'
import {
  loadBlendPools,
  loadBlendPositions,
  buildBlendSupplyXdr,
  buildBlendWithdrawXdr,
  type BlendPool,
  type BlendPosition,
} from '@/lib/blend'

const network = getNetwork()

type EarnStep = 'pools' | 'deposit-form' | 'depositing' | 'deposit-done' | 'withdraw-form' | 'withdrawing' | 'withdraw-done' | 'error'

export default function EarnPage() {
  const router = useRouter()
  useInactivityLock()

  const [step, setStep] = useState<EarnStep>('pools')
  const [accountAddress, setAccountAddress] = useState<string | null>(null)

  const [pools, setPools] = useState<BlendPool[]>([])
  const [positions, setPositions] = useState<BlendPosition[]>([])
  const [loadingPools, setLoadingPools] = useState(true)

  const [selectedPool, setSelectedPool] = useState<BlendPool | null>(null)
  const [depositAmount, setDepositAmount] = useState('')
  const [selectedPosition, setSelectedPosition] = useState<BlendPosition | null>(null)

  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  // ── Load session ──
  useEffect(() => {
    const addr = sessionStorage.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }

    const signerSecret =
      sessionStorage.getItem('veil_signer_secret') || localStorage.getItem('veil_signer_secret')
    const signerPublic = localStorage.getItem('veil_signer_public_key')

    if (!signerSecret && !signerPublic) {
      setErrorMsg('Signing key not found. Return to dashboard and set up a fee-payer first.')
      setStep('error')
      return
    }

    const resolvedAddress = signerSecret
      ? Keypair.fromSecret(signerSecret).publicKey()
      : signerPublic!

    setAccountAddress(resolvedAddress)
    loadData(resolvedAddress)
  }, [router])

  async function loadData(addr: string) {
    setLoadingPools(true)
    const [p, pos] = await Promise.all([
      loadBlendPools(),
      loadBlendPositions(addr),
    ])
    setPools(p)
    setPositions(pos)
    setLoadingPools(false)
  }

  // ── Deposit ──
  async function handleDeposit() {
    if (!selectedPool || !accountAddress || !depositAmount) return
    beginTx()
    setStep('depositing')
    setErrorMsg(null)
    try {
      await requirePasskey()

      const signerSecret =
        sessionStorage.getItem('veil_signer_secret') || localStorage.getItem('veil_signer_secret')
      if (!signerSecret) throw new Error('Signing key not found. Please unlock wallet again.')

      const amountInStroops = BigInt(Math.round(parseFloat(depositAmount) * 1e7))
      // Use XLM native asset contract for XLM pools, or first asset otherwise
      const assetContract = selectedPool.assets[0] ?? ''

      const xdr = await buildBlendSupplyXdr({
        poolId: selectedPool.id,
        assetContract,
        amountInStroops,
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      })

      if (!xdr) throw new Error('Failed to build deposit transaction.')

      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
      })
      setTxHash(hash)
      setStep('deposit-done')
      // Refresh positions
      loadData(accountAddress)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('cancel') || msg.toLowerCase().includes('abort')) {
        setErrorMsg('Passkey cancelled. Please try again.')
      } else if (msg.toLowerCase().includes('utilization') || msg.toLowerCase().includes('cap')) {
        setErrorMsg('Pool is at capacity — deposits temporarily unavailable.')
      } else {
        setErrorMsg(msg)
      }
      setStep('error')
    } finally {
      endTx()
    }
  }

  // ── Withdraw ──
  async function handleWithdraw() {
    if (!selectedPosition || !accountAddress) return
    beginTx()
    setStep('withdrawing')
    setErrorMsg(null)
    try {
      await requirePasskey()

      const signerSecret =
        sessionStorage.getItem('veil_signer_secret') || localStorage.getItem('veil_signer_secret')
      if (!signerSecret) throw new Error('Signing key not found. Please unlock wallet again.')

      const bTokenAmount = BigInt(selectedPosition.bTokenBalance)

      const xdr = await buildBlendWithdrawXdr({
        poolId: selectedPosition.poolId,
        assetContract: selectedPosition.asset,
        bTokenAmount,
        supplierAddress: accountAddress,
        sourceAddress: accountAddress,
      })

      if (!xdr) throw new Error('Failed to build withdraw transaction.')

      const hash = await signAndSubmitSorobanXdr({
        xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
      })
      setTxHash(hash)
      setStep('withdraw-done')
      loadData(accountAddress)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setErrorMsg(msg.toLowerCase().includes('cancel') ? 'Passkey cancelled. Please try again.' : msg)
      setStep('error')
    } finally {
      endTx()
    }
  }

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button
          onClick={() => router.replace('/dashboard')}
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
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Dashboard
        </button>
        <VeilLogo size={22} />
        <div style={{ width: 40 }} />
      </nav>

      <main className="wallet-main">
        <h2
          style={{
            fontFamily: 'Lora, Georgia, serif',
            fontWeight: 600,
            fontStyle: 'italic',
            fontSize: '1.75rem',
            marginBottom: '0.5rem',
          }}
        >
          Earn
        </h2>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginBottom: '1.75rem' }}>
          Deposit XLM or USDC into Blend Protocol to earn yield on-chain.
        </p>

        {/* ── Existing Positions ── */}
        {positions.length > 0 && (
          <div style={{ marginBottom: '1.5rem' }}>
            <p
              style={{
                fontSize: '0.75rem',
                fontFamily: 'Anton, Impact, sans-serif',
                letterSpacing: '0.06em',
                color: 'rgba(246,247,248,0.4)',
                marginBottom: '0.75rem',
              }}
            >
              YOUR POSITIONS
            </p>
            {positions.map((pos) => (
              <div
                key={`${pos.poolId}-${pos.asset}`}
                className="card"
                style={{ marginBottom: '0.75rem', padding: '1rem' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 500 }}>{pos.asset.slice(0, 8)}…</span>
                  <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)' }}>
                    Pool: {pos.poolId.slice(0, 6)}…
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem' }}>
                  <span style={{ color: 'rgba(246,247,248,0.5)' }}>Deposited</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace' }}>
                    {(Number(pos.deposited) / 1e7).toFixed(4)}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    fontSize: '0.8125rem',
                    marginTop: '0.25rem',
                  }}
                >
                  <span style={{ color: 'rgba(246,247,248,0.5)' }}>Accrued interest</span>
                  <span style={{ fontFamily: 'Inconsolata, monospace', color: 'var(--teal)' }}>
                    +{(Number(pos.accruedInterest) / 1e7).toFixed(6)}
                  </span>
                </div>
                <button
                  className="btn-ghost"
                  style={{ marginTop: '0.75rem', width: '100%', fontSize: '0.8125rem', padding: '0.5rem' }}
                  onClick={() => { setSelectedPosition(pos); setStep('withdraw-form') }}
                >
                  Withdraw
                </button>
              </div>
            ))}
          </div>
        )}

        {/* ── Pool list ── */}
        {(step === 'pools' || step === 'deposit-form' || step === 'withdraw-form') && (
          <>
            <p
              style={{
                fontSize: '0.75rem',
                fontFamily: 'Anton, Impact, sans-serif',
                letterSpacing: '0.06em',
                color: 'rgba(246,247,248,0.4)',
                marginBottom: '0.75rem',
              }}
            >
              AVAILABLE POOLS
            </p>

            {loadingPools ? (
              <div style={{ textAlign: 'center', padding: '2rem 0' }}>
                <div className="spinner spinner-light" />
              </div>
            ) : pools.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '2rem' }}>
                <p style={{ color: 'rgba(246,247,248,0.4)', fontSize: '0.875rem' }}>Coming soon</p>
                <p style={{ color: 'rgba(246,247,248,0.25)', fontSize: '0.8125rem', marginTop: '0.5rem' }}>
                  No Blend pools available on this network.
                </p>
              </div>
            ) : (
              pools.map((pool) => (
                <div
                  key={pool.id}
                  className="card"
                  style={{
                    marginBottom: '0.75rem',
                    padding: '1rem',
                    border:
                      selectedPool?.id === pool.id
                        ? '1px solid rgba(212,175,55,0.5)'
                        : '1px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span style={{ fontWeight: 500 }}>{pool.name}</span>
                    <span
                      style={{
                        fontFamily: 'Inconsolata, monospace',
                        color: 'var(--teal)',
                        fontWeight: 600,
                      }}
                    >
                      {(pool.supplyApy * 100).toFixed(2)}% APY
                    </span>
                  </div>
                  <div style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.75rem' }}>
                    Total liquidity: {(Number(pool.totalSupply) / 1e7).toLocaleString()}
                  </div>
                  <button
                    className="btn-gold"
                    style={{ width: '100%', fontSize: '0.875rem', padding: '0.5rem' }}
                    onClick={() => { setSelectedPool(pool); setStep('deposit-form') }}
                  >
                    Deposit &amp; earn
                  </button>
                </div>
              ))
            )}
          </>
        )}

        {/* ── Deposit form ── */}
        {step === 'deposit-form' && selectedPool && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
            <div className="card" style={{ padding: '1.25rem' }}>
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.5rem' }}>
                Pool: {selectedPool.name} · Est. APY {(selectedPool.supplyApy * 100).toFixed(2)}%
              </p>
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <input
                  className="input-field"
                  type="number"
                  placeholder="Amount"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  style={{ flex: 1, fontSize: '1.5rem', background: 'none', border: 'none', padding: 0 }}
                />
                <span style={{ color: 'rgba(246,247,248,0.4)', fontSize: '0.875rem' }}>
                  {selectedPool.assets[0]?.slice(0, 6) ?? 'asset'}
                </span>
              </div>
              {depositAmount && (
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', marginTop: '0.5rem' }}>
                  Est. earned in 1 year:{' '}
                  <span style={{ color: 'var(--teal)' }}>
                    {(parseFloat(depositAmount || '0') * selectedPool.supplyApy).toFixed(4)}
                  </span>
                </p>
              )}
            </div>
            <button
              className="btn-gold"
              onClick={handleDeposit}
              disabled={!depositAmount || parseFloat(depositAmount) <= 0}
            >
              Deposit &amp; earn
            </button>
            <button className="btn-ghost" onClick={() => setStep('pools')}>
              Cancel
            </button>
          </div>
        )}

        {/* ── Withdraw form ── */}
        {step === 'withdraw-form' && selectedPosition && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
            <div className="card" style={{ padding: '1.25rem' }}>
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem', fontWeight: 500 }}>
                Withdraw from pool {selectedPosition.poolId.slice(0, 8)}…
              </p>
              <Row
                label="Deposited"
                value={(Number(selectedPosition.deposited) / 1e7).toFixed(4)}
              />
              <div style={{ marginTop: '0.5rem' }}>
                <Row
                  label="Accrued interest"
                  value={`+${(Number(selectedPosition.accruedInterest) / 1e7).toFixed(6)}`}
                />
              </div>
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', marginTop: '0.75rem' }}>
                All bTokens will be redeemed for the underlying asset.
              </p>
            </div>
            <button className="btn-gold" onClick={handleWithdraw}>
              Withdraw all
            </button>
            <button className="btn-ghost" onClick={() => setStep('pools')}>
              Cancel
            </button>
          </div>
        )}

        {/* ── Loading states ── */}
        {(step === 'depositing' || step === 'withdrawing') && (
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
              <div className="spinner spinner-light" />
            </div>
            <p style={{ fontWeight: 500 }}>Waiting for passkey…</p>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginTop: '0.5rem' }}>
              Approve with Face ID / fingerprint to continue
            </p>
          </div>
        )}

        {/* ── Success ── */}
        {(step === 'deposit-done' || step === 'withdraw-done') && (
          <div
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center' }}
          >
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ margin: '0 auto' }}>
              <circle cx="20" cy="20" r="19" stroke="var(--teal)" strokeWidth="1.5" />
              <path
                d="M13 20.5l5 5 9-9"
                stroke="var(--teal)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div>
              <p
                style={{
                  fontFamily: 'Lora, Georgia, serif',
                  fontWeight: 600,
                  fontStyle: 'italic',
                  fontSize: '1.25rem',
                }}
              >
                {step === 'deposit-done' ? 'Deposit successful' : 'Withdrawal successful'}
              </p>
              {txHash && (
                <p
                  style={{
                    fontSize: '0.75rem',
                    color: 'rgba(246,247,248,0.35)',
                    fontFamily: 'Inconsolata, monospace',
                    marginTop: '0.5rem',
                    wordBreak: 'break-all',
                  }}
                >
                  {txHash.slice(0, 20)}...
                </p>
              )}
            </div>
            <button className="btn-gold" onClick={() => { setStep('pools'); setTxHash(null) }}>
              Back to Earn
            </button>
          </div>
        )}

        {/* ── Error ── */}
        {step === 'error' && (
          <div
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center' }}
          >
            <div style={{ color: 'var(--teal)', fontSize: '2.5rem' }}>!</div>
            <div>
              <p style={{ fontWeight: 500 }}>Transaction failed</p>
              <p
                style={{
                  fontSize: '0.8125rem',
                  color: 'rgba(246,247,248,0.4)',
                  marginTop: '0.5rem',
                }}
              >
                {errorMsg}
              </p>
            </div>
            <button className="btn-ghost" onClick={() => setStep('pools')}>
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
      <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.875rem', textAlign: 'right', wordBreak: 'break-all' }}>{value}</span>
    </div>
  )
}

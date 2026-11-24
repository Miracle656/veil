'use client'

import { PageHeader } from '@/components/ui/primitives'
import React, { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Asset, Keypair } from '@stellar/stellar-sdk'
import { VeilMark } from '@/components/ui/VeilMark'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'
import { requirePasskey } from '@/lib/passkeyAuth'
import { PasskeyCeremonyError, isPasskeyCancellation } from '@/lib/passkeyOutcome'
import { signAndSubmitSorobanXdr } from '@/lib/sorobanTx'
import {
  loadBlendPools,
  loadBlendPositions,
  buildBlendSupplyXdr,
  buildBlendWithdrawXdr,
  type BlendPool,
  type BlendPosition,
  type BlendReserve,
} from '@/lib/blend'
import {
  depositToVault,
  fetchLatestLedgerTimestamp,
  fetchVaultDetails,
  VAULT_STORAGE_KEY,
  type VaultDetails,
} from '@/lib/vault'
import {
  formatDelayInDays,
  formatLocalDateTime,
  projectedUnlockTimestamp,
  type SavingsMode,
} from '@/lib/savings'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { parseInvestPrefill } from './prefill'

const network = getNetwork()

type EarnStep = 'pools' | 'deposit-form' | 'deposit-confirm' | 'depositing' | 'deposit-done' | 'withdraw-form' | 'withdrawing' | 'withdraw-done' | 'error'

function formatUtilization(utilization: number | null): string {
  if (utilization === null) return 'Current Blend reserve utilization is unavailable.'
  const percent = `${(utilization * 100).toFixed(1)}%`
  if (utilization >= 1) return `Current Blend reserve utilization: ${percent} (fully utilised).`
  if (utilization >= 0.95) return `Current Blend reserve utilization: ${percent} (nearly fully utilised).`
  return `Current Blend reserve utilization: ${percent}.`
}

export default function EarnPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  useInactivityLock()

  const [step, setStep] = useState<EarnStep>('pools')
  const [accountAddress, setAccountAddress] = useState<string | null>(null)

  const [pools, setPools] = useState<BlendPool[]>([])
  const [positions, setPositions] = useState<BlendPosition[]>([])
  const [loadingPools, setLoadingPools] = useState(true)
  const [vaultDetails, setVaultDetails] = useState<VaultDetails | null>(null)
  const [vaultLoading, setVaultLoading] = useState(false)
  const [vaultError, setVaultError] = useState<string | null>(null)

  const [selectedPool, setSelectedPool] = useState<BlendPool | null>(null)
  const [selectedAssetContract, setSelectedAssetContract] = useState<string | null>(null)
  const [depositAmount, setDepositAmount] = useState('')
  const [savingsMode, setSavingsMode] = useState<SavingsMode | null>(null)
  const [projectedUnlockAt, setProjectedUnlockAt] = useState<number | null>(null)
  const [selectedPosition, setSelectedPosition] = useState<BlendPosition | null>(null)

  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  // ── Load session ──
  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }

    const signerSecret =
      walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    const signerPublic = walletLocal.getItem('veil_signer_public_key')

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
    setPools(p.filter((pool) => pool.reserves.length > 0))
    setPositions(pos)
    setLoadingPools(false)
  }

  useEffect(() => {
    if (!accountAddress) return
    const storedVault = localStorage.getItem(VAULT_STORAGE_KEY)
    if (!storedVault) {
      setVaultDetails(null)
      setVaultError(null)
      return
    }

    let active = true
    setVaultLoading(true)
    setVaultError(null)
    fetchVaultDetails(storedVault)
      .then((details) => {
        if (active) setVaultDetails(details)
      })
      .catch((cause: unknown) => {
        if (active) setVaultError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (active) setVaultLoading(false)
      })
    return () => { active = false }
  }, [accountAddress])

  useEffect(() => {
    const prefill = parseInvestPrefill(`?${searchParams.toString()}`)
    if (!prefill || pools.length === 0) return
    const assetContract = new Asset(prefill.asset, prefill.issuer).contractId(network.networkPassphrase)
    const pool = pools.find((candidate) => candidate.assets.includes(assetContract))
    if (!pool) return
    setSelectedPool(pool)
    setSelectedAssetContract(assetContract)
    setDepositAmount(prefill.amount)
    setSavingsMode(null)
    setStep('deposit-form')
  }, [pools, searchParams])

  const selectedReserve: BlendReserve | null =
    selectedPool?.reserves.find((reserve) => reserve.assetId === selectedAssetContract) ?? null
  const nativeAssetContract = Asset.native().contractId(network.networkPassphrase)
  const canUseLocked = Boolean(
    selectedReserve?.code === 'XLM'
    && vaultDetails
    && vaultDetails.config.owner === accountAddress
    && vaultDetails.config.token === nativeAssetContract,
  )

  async function handlePrepareConfirmation() {
    if (!selectedPool || !selectedReserve || !depositAmount || !savingsMode) return
    setErrorMsg(null)
    setProjectedUnlockAt(null)

    if (savingsMode === 'locked') {
      if (!canUseLocked || !vaultDetails) {
        setErrorMsg('A matching XLM vault controlled by this wallet is required for Locked savings.')
        return
      }
      try {
        const latestLedgerTimestamp = await fetchLatestLedgerTimestamp()
        setProjectedUnlockAt(
          projectedUnlockTimestamp(latestLedgerTimestamp, vaultDetails.config.delaySeconds),
        )
      } catch (cause: unknown) {
        setErrorMsg(cause instanceof Error ? cause.message : String(cause))
        return
      }
    }
    setStep('deposit-confirm')
  }

  // ── Deposit after the user reviews and confirms the selected path. ──
  async function handleConfirmDeposit() {
    if (
      step !== 'deposit-confirm'
      || !selectedPool
      || !selectedReserve
      || !accountAddress
      || !depositAmount
      || !savingsMode
    ) return
    if (savingsMode === 'locked' && (!canUseLocked || !vaultDetails || projectedUnlockAt === null)) {
      setErrorMsg('The vault details or projected unlock time are no longer available. Review the deposit again.')
      setStep('deposit-form')
      return
    }

    beginTx()
    setStep('depositing')
    setErrorMsg(null)
    try {
      await requirePasskey()

      const signerSecret =
        walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
      if (!signerSecret) throw new Error('Signing key not found. Please unlock wallet again.')

      let hash: string
      if (savingsMode === 'locked') {
        hash = await depositToVault({
          contractId: vaultDetails!.contractId,
          amountXlm: depositAmount,
          signerSecret,
        })
      } else {
        const amountInStroops = BigInt(Math.round(parseFloat(depositAmount) * 1e7))
        const xdr = await buildBlendSupplyXdr({
          poolId: selectedPool.id,
          assetContract: selectedReserve.assetId,
          amountInStroops,
          supplierAddress: accountAddress,
          sourceAddress: accountAddress,
        })

        if (!xdr) throw new Error('Failed to build deposit transaction.')

        hash = await signAndSubmitSorobanXdr({
          xdr,
          signerSecret,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
        })
      }
      setTxHash(hash)
      setStep('deposit-done')
      if (savingsMode === 'flexible') loadData(accountAddress)
      else {
        void fetchVaultDetails(vaultDetails!.contractId)
          .then(setVaultDetails)
          .catch((cause: unknown) => setVaultError(cause instanceof Error ? cause.message : String(cause)))
      }
    } catch (err: unknown) {
      // A dismissed passkey prompt leaves the reviewed choice intact.
      if (isPasskeyCancellation(err)) {
        setErrorMsg(null)
        setStep('deposit-confirm')
        return
      }
      const msg = err instanceof PasskeyCeremonyError ? err.message : err instanceof Error ? err.message : String(err)
      if (msg.toLowerCase().includes('utilization') || msg.toLowerCase().includes('cap')) {
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
        walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
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
      if (isPasskeyCancellation(err)) {
        setErrorMsg(null)
        setStep('withdraw-form')
        return
      }
      const msg = err instanceof PasskeyCeremonyError ? err.message : err instanceof Error ? err.message : String(err)
      setErrorMsg(msg)
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
        <VeilMark size={22} />
        <div style={{ width: 40 }} />
      </nav>

      <main className="wallet-main">
        <div style={{ marginBottom: '1.75rem' }}>
          <PageHeader eyebrow="Yield" title="Earn" />
        </div>
        <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginBottom: '1.25rem' }}>
          Deposit XLM or USDC into Blend Protocol to earn yield on-chain.
        </p>

        {/* ── Invest & Yield Disclosures ── */}
        <div
          className="card"
          style={{
            marginBottom: '1.75rem',
            padding: '1rem',
            border: '1px solid var(--border-dim)',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px' }}>
              <p
                style={{
                  fontSize: '0.6875rem',
                  fontFamily: 'Anton, Impact, sans-serif',
                  letterSpacing: '0.06em',
                  color: 'var(--gold)',
                  marginBottom: '0.25rem',
                }}
              >
                INVEST &amp; YIELD DISCLOSURES
              </p>
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)', lineHeight: 1.4, margin: 0 }}>
                Veil is a self-custody wallet, not a broker. Veil never takes custody, never performs KYC, and never gives advice.
              </p>
            </div>
            <a
              href="https://docs.useveilapp.xyz/invest"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost"
              style={{
                fontSize: '0.75rem',
                padding: '0.4rem 0.75rem',
                border: '1px solid var(--border-dim)',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                color: 'var(--off-white)',
                flexShrink: 0,
              }}
            >
              How it works &amp; risks ↗
            </a>
          </div>
        </div>

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
        {step === 'pools' && (
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
                        ? '1px solid var(--gold)'
                        : '1px solid var(--border-dim)',
                  }}
                >
                  <p style={{ fontWeight: 500, margin: '0 0 0.5rem' }}>{pool.name}</p>
                  <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', marginBottom: '0.75rem' }}>
                    Flexible withdrawals are subject to pool liquidity. A fully utilised pool cannot pay out until liquidity returns.
                  </p>
                  <div style={{ display: 'grid', gap: '0.5rem' }}>
                    {pool.reserves.map((reserve) => (
                      <button
                        key={reserve.assetId}
                        className="btn-secondary"
                        style={{ width: '100%', fontSize: '0.875rem', padding: '0.5rem' }}
                        onClick={() => {
                          setSelectedPool(pool)
                          setSelectedAssetContract(reserve.assetId)
                          setDepositAmount('')
                          setSavingsMode(null)
                          setStep('deposit-form')
                        }}
                      >
                        Deposit {reserve.code}
                        {' · '}
                        {reserve.supplyApy === null
                          ? 'Blend APY unavailable'
                          : `${(reserve.supplyApy * 100).toFixed(2)}% Blend APY`}
                        {' · '}
                        {reserve.utilization === null
                          ? 'utilization unavailable'
                          : `${(reserve.utilization * 100).toFixed(1)}% utilized`}
                      </button>
                    ))}
                  </div>
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
                Pool: {selectedPool.name} · Asset: {selectedReserve?.code ?? 'Unavailable'}
                {' · '}
                {selectedReserve?.supplyApy === null || !selectedReserve
                  ? 'Blend APY unavailable'
                  : `${(selectedReserve.supplyApy * 100).toFixed(2)}% Blend APY`}
              </p>
              {selectedReserve && (
                <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)', margin: '0 0 0.75rem' }}>
                  {formatUtilization(selectedReserve.utilization)}
                </p>
              )}
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                <input
                  className="input-field"
                  type="number"
                  placeholder="Amount"
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  min="0.0000001"
                  step="0.0000001"
                  aria-label={`Amount in ${selectedReserve?.code ?? 'asset'}`}
                  style={{ flex: 1, fontSize: '1.5rem', background: 'none', border: 'none', padding: 0 }}
                />
                <span style={{ color: 'rgba(246,247,248,0.4)', fontSize: '0.875rem' }}>
                  {selectedReserve?.code ?? 'asset'}
                </span>
              </div>
            </div>
            <fieldset className="card" style={{ padding: '1rem', border: '1px solid var(--border-dim)' }}>
              <legend style={{ padding: '0 0.4rem', fontSize: '0.75rem', color: 'rgba(246,247,248,0.6)' }}>
                Choose how to save
              </legend>
              <div role="radiogroup" aria-label="Savings access" style={{ display: 'grid', gap: '0.75rem' }}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={savingsMode === 'flexible'}
                  className="btn-secondary"
                  onClick={() => setSavingsMode('flexible')}
                  style={{ textAlign: 'left', borderColor: savingsMode === 'flexible' ? 'var(--gold)' : undefined }}
                >
                  <strong>Flexible</strong>
                  <span style={{ display: 'block', marginTop: '0.3rem', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)' }}>
                    Withdrawals are subject to pool liquidity. A fully utilised pool cannot pay out until liquidity returns.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={savingsMode === 'locked'}
                  className="btn-secondary"
                  disabled={!canUseLocked}
                  onClick={() => setSavingsMode('locked')}
                  style={{
                    textAlign: 'left',
                    opacity: canUseLocked ? 1 : 0.55,
                    borderColor: savingsMode === 'locked' ? 'var(--gold)' : undefined,
                  }}
                >
                  <strong>Locked</strong>
                  <span style={{ display: 'block', marginTop: '0.3rem', fontSize: '0.8125rem', color: 'rgba(246,247,248,0.6)' }}>
                    XLM vault deposit. The withdrawal delay starts only when you queue a withdrawal.
                  </span>
                </button>
              </div>
              {!canUseLocked && (
                <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.5)', margin: '0.75rem 0 0' }}>
                  {selectedReserve?.code !== 'XLM'
                    ? 'Locked savings is currently available for XLM only because the vault holds XLM.'
                    : vaultLoading
                      ? 'Checking the attached vault…'
                      : vaultError
                        ? `Could not read the attached vault: ${vaultError}`
                        : !vaultDetails
                          ? <>Attach or create an XLM vault in <a href="/vault">Vault</a> to use Locked.</>
                          : vaultDetails.config.owner !== accountAddress
                            ? 'The attached vault is controlled by a different account.'
                            : 'The attached vault does not hold XLM.'}
                </p>
              )}
            </fieldset>
            {savingsMode === 'flexible' && (
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)', lineHeight: 1.5, margin: 0 }}>
                Flexible withdrawals are subject to pool liquidity. If the pool is fully utilised, it cannot pay out until liquidity returns.
              </p>
            )}
            {savingsMode === 'locked' && vaultDetails && (
              <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)', lineHeight: 1.5, margin: 0 }}>
                Vault delay: {formatDelayInDays(vaultDetails.config.delaySeconds)}. The vault does not publish a rate; Locked is a commitment device, not a better deal.
              </p>
            )}
            {errorMsg && (
              <p role="alert" style={{ color: '#e5484d', fontSize: '0.8125rem', margin: 0 }}>
                {errorMsg}
              </p>
            )}
            <button
              className="btn-gold"
              onClick={handlePrepareConfirmation}
              disabled={
                !selectedReserve
                || !savingsMode
                || !Number.isFinite(Number(depositAmount))
                || Number(depositAmount) <= 0
                || (savingsMode === 'locked' && !canUseLocked)
              }
            >
              Review deposit
            </button>
            <button className="btn-ghost" onClick={() => setStep('pools')}>
              Cancel
            </button>
          </div>
        )}

        {step === 'deposit-confirm' && selectedPool && selectedReserve && savingsMode && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
            <section className="card" aria-label="Deposit confirmation" style={{ padding: '1.25rem' }}>
              <h2 style={{ margin: '0 0 1rem', fontSize: '1rem' }}>Review before signing</h2>
              <div style={{ display: 'grid', gap: '0.75rem', fontSize: '0.875rem' }}>
                <p style={{ margin: 0 }}><strong>You are committing:</strong> {depositAmount} {selectedReserve.code}</p>
                <p style={{ margin: 0 }}><strong>Choice:</strong> {savingsMode === 'flexible' ? 'Flexible with Blend' : 'Locked in the XLM vault'}</p>
                {savingsMode === 'flexible' ? (
                  <>
                    <p style={{ margin: 0 }}>No lock date. Withdrawals are subject to pool liquidity. A fully utilised pool cannot pay out until liquidity returns.</p>
                    <p style={{ margin: 0 }}>{formatUtilization(selectedReserve.utilization)}</p>
                    <p style={{ margin: 0 }}>
                      {selectedReserve.supplyApy === null
                        ? 'Blend APY is unavailable from the current reserve data.'
                        : `Current Blend reserve supply APY: ${(selectedReserve.supplyApy * 100).toFixed(2)}% (runtime estimate).`}
                    </p>
                  </>
                ) : (
                  <>
                    <p style={{ margin: 0 }}><strong>Vault delay:</strong> {formatDelayInDays(vaultDetails!.config.delaySeconds)}</p>
                    <p style={{ margin: 0 }}>
                      <strong>Earliest projected reach if you queue a withdrawal now:</strong>{' '}
                      {projectedUnlockAt === null ? 'Unavailable' : formatLocalDateTime(projectedUnlockAt)}
                    </p>
                    <p style={{ margin: 0 }}>
                      The delay starts when you queue a withdrawal, not when you deposit. The actual unlock time is set by the ledger when the queue transaction is recorded and may be later than this projection.
                    </p>
                    <p style={{ margin: 0 }}>
                      To get out, queue a withdrawal, wait for the full delay, then execute it. There is no way to skip the delay. The vault charges no early-exit penalty; Stellar transaction fees still apply.
                    </p>
                    <p style={{ margin: 0 }}>
                      You can cancel a queued withdrawal, but cancelling does not take funds out of the vault or bypass the delay.
                    </p>
                    <p style={{ margin: 0 }}>
                      The vault does not publish a rate. Locked is a commitment device, not a better deal.
                    </p>
                    {/* TODO(maintainer): name and verify a protocol/economic source before ever showing a Locked-vs-Flexible rate differential. */}
                  </>
                )}
              </div>
            </section>
            <button className="btn-gold" onClick={handleConfirmDeposit}>
              Confirm and sign {savingsMode === 'locked' ? 'vault deposit' : 'Blend supply'}
            </button>
            <button className="btn-ghost" onClick={() => setStep('deposit-form')}>
              Back and change choice
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
                {step === 'deposit-done'
                  ? savingsMode === 'locked' ? 'Locked vault deposit successful' : 'Flexible Blend supply successful'
                  : 'Withdrawal successful'}
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
            {step === 'deposit-done' && savingsMode === 'locked' && (
              <a className="btn-secondary" href="/vault">
                Manage locked funds
              </a>
            )}
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

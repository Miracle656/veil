'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  LiquidityPoolAsset,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'
import { requirePasskey } from '@/lib/passkeyAuth'

const Server = Horizon.Server
const network = getNetwork()
const POOL_LIMIT = 24
const DEPOSIT_PRICE_BUFFER = 0.005
const WITHDRAW_BUFFER = 0.995

type HorizonAssetRef = {
  asset: string
  amount: string
}

type HorizonPoolRecord = {
  id: string
  fee_bp: number
  total_shares: string
  total_trustlines: string
  reserves: HorizonAssetRef[]
  last_modified_ledger?: number
  last_modified_time?: string
}

type StellarAssetInfo = {
  code: string
  issuer: string | null
  asset: Asset
  displayName: string
}

type PoolView = {
  id: string
  feeBp: number
  totalShares: string
  totalTrustlines: string
  reserves: [
    { meta: StellarAssetInfo; amount: string },
    { meta: StellarAssetInfo; amount: string },
  ]
  spotPrice: number
  reversePrice: number
  lastModifiedLedger?: number
  lastModifiedTime?: string
}

type WalletBalance = {
  asset_type: string
  balance: string
  asset_code?: string
  asset_issuer?: string
  liquidity_pool_id?: string
}

type Position = {
  poolId: string
  shares: string
}

type Mode = 'deposit' | 'withdraw'

type TxState = 'idle' | 'submitting' | 'success' | 'error'

const xlmAsset = (): StellarAssetInfo => ({
  code: 'XLM',
  issuer: null,
  asset: Asset.native(),
  displayName: 'Stellar Lumens',
})

function parseAssetRef(ref: string): StellarAssetInfo {
  if (ref === 'native' || ref === 'XLM') return xlmAsset()
  const [code, issuer] = ref.split(':')
  const asset = new Asset(code, issuer)
  return {
    code,
    issuer,
    asset,
    displayName: code,
  }
}

function formatAmount(value: number | string, maxFractionDigits = 7): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return '0'
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits,
  })
}

function shortHash(hash: string): string {
  return hash.length > 18 ? `${hash.slice(0, 8)}...${hash.slice(-8)}` : hash
}

function canonicalAssetKey(meta: StellarAssetInfo): string {
  return meta.code === 'XLM' ? 'XLM' : `${meta.code}:${meta.issuer}`
}

function isNativeAsset(meta: StellarAssetInfo): boolean {
  return meta.code === 'XLM'
}

function toFixed7(value: number): string {
  return Number.isFinite(value) ? value.toFixed(7) : '0.0000000'
}

function createPoolView(record: HorizonPoolRecord): PoolView | null {
  if (!record.reserves || record.reserves.length < 2) return null
  const [reserveA, reserveB] = record.reserves
  const metaA = parseAssetRef(reserveA.asset)
  const metaB = parseAssetRef(reserveB.asset)
  const amountA = Number(reserveA.amount)
  const amountB = Number(reserveB.amount)
  if (!Number.isFinite(amountA) || !Number.isFinite(amountB) || amountA <= 0 || amountB <= 0) return null
  return {
    id: record.id,
    feeBp: record.fee_bp ?? 30,
    totalShares: record.total_shares,
    totalTrustlines: record.total_trustlines,
    reserves: [
      { meta: metaA, amount: reserveA.amount },
      { meta: metaB, amount: reserveB.amount },
    ],
    spotPrice: amountB / amountA,
    reversePrice: amountA / amountB,
    lastModifiedLedger: record.last_modified_ledger,
    lastModifiedTime: record.last_modified_time,
  }
}

function getSignerPublicKey(): string | null {
  const signerSecret = sessionStorage.getItem('veil_signer_secret') || localStorage.getItem('veil_signer_secret')
  if (signerSecret) return Keypair.fromSecret(signerSecret).publicKey()
  return localStorage.getItem('veil_signer_public_key')
}

function getSignerSecret(): string | null {
  return sessionStorage.getItem('veil_signer_secret') || localStorage.getItem('veil_signer_secret')
}

function makePoolShareAsset(pool: PoolView): LiquidityPoolAsset {
  const [reserveA, reserveB] = pool.reserves
  return new LiquidityPoolAsset(reserveA.meta.asset, reserveB.meta.asset, pool.feeBp)
}

function priceBounds(spotPrice: number) {
  return {
    min: spotPrice * (1 - DEPOSIT_PRICE_BUFFER),
    max: spotPrice * (1 + DEPOSIT_PRICE_BUFFER),
  }
}

export default function PoolsPage() {
  const router = useRouter()
  useInactivityLock()

  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [signerAddress, setSignerAddress] = useState<string | null>(null)
  const [pools, setPools] = useState<PoolView[]>([])
  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null)
  const [accountBalances, setAccountBalances] = useState<WalletBalance[]>([])
  const [positions, setPositions] = useState<Position[]>([])
  const [loadingPools, setLoadingPools] = useState(true)
  const [loadingAccount, setLoadingAccount] = useState(true)
  const [txState, setTxState] = useState<TxState>('idle')
  const [txMessage, setTxMessage] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('deposit')
  const [depositAmountA, setDepositAmountA] = useState('1')
  const [withdrawShares, setWithdrawShares] = useState('0')

  const server = useMemo(() => new Server(network.horizonUrl), [])

  useEffect(() => {
    const storedWallet = sessionStorage.getItem('invisible_wallet_address')
    if (!storedWallet) {
      router.replace('/lock')
      return
    }
    setWalletAddress(storedWallet)

    const signer = getSignerPublicKey()
    setSignerAddress(signer)
  }, [router])

  const selectedPool = pools.find((pool) => pool.id === selectedPoolId) ?? pools[0] ?? null

  useEffect(() => {
    if (!selectedPool && pools.length > 0) {
      setSelectedPoolId(pools[0].id)
    }
  }, [pools, selectedPool])

  useEffect(() => {
    if (!selectedPool) return
    if (mode === 'withdraw') {
      const current = positions.find((position) => position.poolId === selectedPool.id)?.shares ?? '0'
      setWithdrawShares(current === '0' ? '0.0000000' : current)
    }
  }, [mode, positions, selectedPool])

  const loadPools = useCallback(async () => {
    setLoadingPools(true)
    setError(null)
    try {
      const res = await fetch(`${network.horizonUrl}/liquidity_pools?limit=${POOL_LIMIT}&order=desc`)
      if (!res.ok) {
        throw new Error(`Failed to load pools (${res.status})`)
      }
      const data = await res.json() as { _embedded?: { records?: HorizonPoolRecord[] } }
      const mapped = (data._embedded?.records ?? [])
        .map(createPoolView)
        .filter((pool): pool is PoolView => pool !== null)
      setPools(mapped)
      setSelectedPoolId((current) => {
        if (current && mapped.some((pool) => pool.id === current)) return current
        return mapped[0]?.id ?? null
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
      setPools([])
    } finally {
      setLoadingPools(false)
    }
  }, [])

  const loadAccount = useCallback(async () => {
    setLoadingAccount(true)
    try {
      const signer = getSignerPublicKey()
      if (!signer) {
        setAccountBalances([])
        setPositions([])
        return
      }

      const account = await server.loadAccount(signer)
      const balances = account.balances as WalletBalance[]
      setAccountBalances(balances)

      const poolShares = balances
        .filter((balance) => balance.asset_type === 'liquidity_pool_shares' && balance.liquidity_pool_id)
        .map((balance) => ({
          poolId: balance.liquidity_pool_id as string,
          shares: balance.balance,
        }))
      setPositions(poolShares)
    } catch {
      setAccountBalances([])
      setPositions([])
    } finally {
      setLoadingAccount(false)
    }
  }, [server])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadPools(), loadAccount()])
  }, [loadAccount, loadPools])

  useEffect(() => {
    if (!walletAddress) return
    refreshAll()
  }, [walletAddress, refreshAll])

  const selectedPosition = selectedPool
    ? positions.find((position) => position.poolId === selectedPool.id) ?? null
    : null

  const depositEstimate = useMemo(() => {
    if (!selectedPool) return null
    const amountA = Number(depositAmountA)
    if (!Number.isFinite(amountA) || amountA <= 0) return null

    const reserveA = Number(selectedPool.reserves[0].amount)
    const reserveB = Number(selectedPool.reserves[1].amount)
    const totalShares = Number(selectedPool.totalShares)
    if (!Number.isFinite(reserveA) || !Number.isFinite(reserveB) || !Number.isFinite(totalShares) || reserveA <= 0 || reserveB <= 0 || totalShares <= 0) return null

    const amountB = amountA * (reserveB / reserveA)
    const sharesFromA = (amountA / reserveA) * totalShares
    const sharesFromB = (amountB / reserveB) * totalShares
    const estimatedShares = Math.min(sharesFromA, sharesFromB)
    const { min, max } = priceBounds(selectedPool.reversePrice)

    return {
      amountA,
      amountB,
      estimatedShares,
      minPrice: min,
      maxPrice: max,
    }
  }, [depositAmountA, selectedPool])

  const withdrawEstimate = useMemo(() => {
    if (!selectedPool) return null
    const shares = Number(withdrawShares)
    if (!Number.isFinite(shares) || shares <= 0) return null

    const reserveA = Number(selectedPool.reserves[0].amount)
    const reserveB = Number(selectedPool.reserves[1].amount)
    const totalShares = Number(selectedPool.totalShares)
    if (!Number.isFinite(reserveA) || !Number.isFinite(reserveB) || !Number.isFinite(totalShares) || reserveA <= 0 || reserveB <= 0 || totalShares <= 0) return null

    const ratio = shares / totalShares
    const receivedA = ratio * reserveA
    const receivedB = ratio * reserveB

    return {
      shares,
      receivedA,
      receivedB,
      minAmountA: receivedA * WITHDRAW_BUFFER,
      minAmountB: receivedB * WITHDRAW_BUFFER,
    }
  }, [selectedPool, withdrawShares])

  const poolSharesLabel = selectedPool
    ? `${canonicalAssetKey(selectedPool.reserves[0].meta)} / ${canonicalAssetKey(selectedPool.reserves[1].meta)}`
    : 'Select a pool'

  const assetTrustlineMissing = useMemo(() => {
    if (!selectedPool || mode !== 'deposit') return false
    return selectedPool.reserves.some(({ meta }) => !isNativeAsset(meta) && !accountBalances.some((balance) =>
      balance.asset_type !== 'liquidity_pool_shares'
      && balance.asset_code === meta.code
      && balance.asset_issuer === meta.issuer
    ))
  }, [accountBalances, mode, selectedPool])

  const shareTrustlineMissing = useMemo(() => {
    if (!selectedPool || mode !== 'deposit') return false
    const key = selectedPool.id
    return !accountBalances.some((balance) => balance.asset_type === 'liquidity_pool_shares' && balance.liquidity_pool_id === key)
  }, [accountBalances, mode, selectedPool])

  async function submitTransaction() {
    if (!selectedPool) return
    setError(null)
    setTxMessage(null)
    setTxHash(null)
    setTxState('submitting')
    beginTx()

    try {
      await requirePasskey()
      const signerSecret = getSignerSecret()
      if (!signerSecret) {
        throw new Error('Signing key not found. Unlock the wallet again.')
      }

      const signerKeypair = Keypair.fromSecret(signerSecret)
      const signerPubKey = signerKeypair.publicKey()
      const account = await server.loadAccount(signerPubKey)
      const txBuilder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: network.networkPassphrase,
      })

      if (mode === 'deposit') {
        if (!depositEstimate) {
          throw new Error('Enter a valid deposit amount.')
        }

        const [reserveA, reserveB] = selectedPool.reserves
        const trustlineTargets: StellarAssetInfo[] = []
        if (!isNativeAsset(reserveA.meta)) trustlineTargets.push(reserveA.meta)
        if (!isNativeAsset(reserveB.meta)) trustlineTargets.push(reserveB.meta)

        trustlineTargets.forEach((meta) => {
          const exists = account.balances.some((balance: any) => balance.asset_type !== 'native' && balance.asset_code === meta.code && balance.asset_issuer === meta.issuer)
          if (!exists) {
            txBuilder.addOperation(Operation.changeTrust({ asset: meta.asset }))
          }
        })

        const poolShareAsset = makePoolShareAsset(selectedPool)
        const hasShareTrustline = account.balances.some((balance: any) =>
          balance.asset_type === 'liquidity_pool_shares'
          && balance.liquidity_pool_id === selectedPool.id
        )
        if (!hasShareTrustline) {
          txBuilder.addOperation(Operation.changeTrust({ asset: poolShareAsset }))
        }

        txBuilder.addOperation(
          Operation.liquidityPoolDeposit({
            liquidityPoolId: selectedPool.id,
            maxAmountA: toFixed7(depositEstimate.amountA),
            maxAmountB: toFixed7(depositEstimate.amountB),
            minPrice: toFixed7(depositEstimate.minPrice),
            maxPrice: toFixed7(depositEstimate.maxPrice),
          })
        )
      } else {
        if (!withdrawEstimate) {
          throw new Error('Enter a valid share amount.')
        }

        txBuilder.addOperation(
          Operation.liquidityPoolWithdraw({
            liquidityPoolId: selectedPool.id,
            amount: toFixed7(withdrawEstimate.shares),
            minAmountA: toFixed7(withdrawEstimate.minAmountA),
            minAmountB: toFixed7(withdrawEstimate.minAmountB),
          })
        )
      }

      txBuilder.setTimeout(30)
      const tx = txBuilder.build()
      tx.sign(signerKeypair)
      const result = await server.submitTransaction(tx)
      setTxHash(result.hash)
      setTxState('success')
      setTxMessage(mode === 'deposit'
        ? 'Deposit submitted. Shares were minted against the current pool ratio.'
        : 'Withdrawal submitted. LP shares were redeemed for the underlying assets.')
      await refreshAll()
    } catch (err: unknown) {
      setTxState('error')
      const horizonError = (err as any)?.response?.data
      const resultCodes = horizonError?.extras?.result_codes
      const message = resultCodes
        ? `${resultCodes.transaction ?? ''}${resultCodes.operations ? ` / ${resultCodes.operations.join(', ')}` : ''}`.trim()
        : err instanceof Error
          ? err.message
          : String(err)
      setError(message)
    } finally {
      endTx()
    }
  }

  const selectedPoolHasPosition = Boolean(selectedPosition && Number(selectedPosition.shares) > 0)

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button
          onClick={() => router.push('/dashboard')}
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
        <div style={{ textAlign: 'center' }}>
          <p style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.08em', color: 'var(--warm-grey)' }}>
            POOLS
          </p>
        </div>
        <button
          onClick={refreshAll}
          title="Refresh pools"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'rgba(246,247,248,0.55)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.375rem',
            fontSize: '0.875rem',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M1.5 4.5V7h2.5M14.5 11.5V9h-2.5M12.9 6.1A5.5 5.5 0 0 0 4.4 4.8L1.5 7m13 2.9A5.5 5.5 0 0 1 3.1 12.2L1.5 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Refresh
        </button>
      </nav>

      <main className="wallet-main">
        <div style={{ marginBottom: '1.5rem' }}>
          <p style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', color: 'var(--warm-grey)', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>
            LIQUIDITY POOLS
          </p>
          <h1 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.9rem', lineHeight: 1.1, marginBottom: '0.5rem' }}>
            Put capital to work in the AMM
          </h1>
          <p style={{ color: 'rgba(246,247,248,0.52)', fontSize: '0.875rem', lineHeight: 1.6, maxWidth: 460 }}>
            Browse active Horizon pools, review the current reserve ratio, and deposit or withdraw with the share estimate shown before you submit.
          </p>
        </div>

        {error && (
          <div className="card" style={{ marginBottom: '1rem', borderColor: 'rgba(0,167,181,0.28)', background: 'rgba(0,167,181,0.07)' }}>
            <p style={{ fontSize: '0.8125rem', color: 'var(--off-white)' }}>{error}</p>
          </div>
        )}

        {txState !== 'idle' && txMessage && (
          <div className="card" style={{ marginBottom: '1rem', borderColor: 'rgba(0,167,181,0.24)', background: 'rgba(0,167,181,0.06)' }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--off-white)', marginBottom: txHash ? '0.375rem' : 0 }}>{txMessage}</p>
            {txHash && (
              <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)', fontFamily: 'Inconsolata, monospace' }}>
                {shortHash(txHash)}
              </p>
            )}
          </div>
        )}

        <section style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
            <h2 style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', color: 'var(--warm-grey)', letterSpacing: '0.08em' }}>
              AVAILABLE POOLS
            </h2>
            <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)' }}>
              {loadingPools ? 'Loading...' : `${pools.length} found`}
            </p>
          </div>

          {loadingPools ? (
            <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
              <div className="skeleton" style={{ width: '40%', height: '0.875rem' }} />
              <div className="skeleton" style={{ width: '82%', height: '1.2rem' }} />
              <div className="skeleton" style={{ width: '65%', height: '0.875rem' }} />
            </div>
          ) : pools.length === 0 ? (
            <div className="card" style={{ textAlign: 'center' }}>
              <p style={{ fontSize: '0.875rem', color: 'rgba(246,247,248,0.45)' }}>
                No liquidity pools were returned by Horizon.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {pools.map((pool) => {
                const isSelected = pool.id === selectedPool?.id
                return (
                  <button
                    key={pool.id}
                    onClick={() => setSelectedPoolId(pool.id)}
                    className="card"
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      cursor: 'pointer',
                      borderColor: isSelected ? 'rgba(253,218,36,0.35)' : 'var(--border-dim)',
                      background: isSelected ? 'rgba(253,218,36,0.05)' : 'var(--surface)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.65rem' }}>
                      <div>
                        <p style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.1rem', marginBottom: '0.3rem' }}>
                          {pool.reserves[0].meta.code} / {pool.reserves[1].meta.code}
                        </p>
                        <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.42)' }}>
                          Fee {pool.feeBp / 100}% / {pool.totalTrustlines} trustlines
                        </p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)' }}>Total shares</p>
                        <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.95rem' }}>
                          {formatAmount(pool.totalShares)}
                        </p>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                      <div>
                        <p style={{ fontSize: '0.7rem', color: 'rgba(246,247,248,0.34)', marginBottom: '0.15rem' }}>Reserve A</p>
                        <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.875rem' }}>
                          {formatAmount(pool.reserves[0].amount)} {pool.reserves[0].meta.code}
                        </p>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <p style={{ fontSize: '0.7rem', color: 'rgba(246,247,248,0.34)', marginBottom: '0.15rem' }}>Reserve B</p>
                        <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.875rem' }}>
                          {formatAmount(pool.reserves[1].amount)} {pool.reserves[1].meta.code}
                        </p>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </section>

        {selectedPool && (
          <section style={{ marginBottom: '1.5rem' }}>
            <div className="card" style={{ marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', marginBottom: '0.9rem' }}>
                <div>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', marginBottom: '0.25rem' }}>Selected pool</p>
                  <h2 style={{ fontFamily: 'Lora, Georgia, serif', fontWeight: 600, fontStyle: 'italic', fontSize: '1.4rem' }}>
                    {selectedPool.reserves[0].meta.code} / {selectedPool.reserves[1].meta.code}
                  </h2>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.42)', marginTop: '0.35rem' }}>
                    Pool ID {shortHash(selectedPool.id)}
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)' }}>Spot price</p>
                  <p style={{ fontFamily: 'Inconsolata, monospace', fontSize: '0.95rem' }}>
                    1 {selectedPool.reserves[0].meta.code} ~ {formatAmount(selectedPool.spotPrice, 6)} {selectedPool.reserves[1].meta.code}
                  </p>
                  <p style={{ fontSize: '0.7rem', color: 'rgba(246,247,248,0.35)', marginTop: '0.2rem' }}>
                    Reverse {formatAmount(selectedPool.reversePrice, 6)} {selectedPool.reserves[0].meta.code} per {selectedPool.reserves[1].meta.code}
                  </p>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                {(['deposit', 'withdraw'] as Mode[]).map((item) => (
                  <button
                    key={item}
                    onClick={() => setMode(item)}
                    style={{
                      flex: 1,
                      padding: '0.6rem 0.75rem',
                      borderRadius: 999,
                      border: '1px solid',
                      cursor: 'pointer',
                      background: mode === item ? 'var(--gold)' : 'transparent',
                      borderColor: mode === item ? 'var(--gold)' : 'rgba(246,247,248,0.12)',
                      color: mode === item ? 'var(--near-black)' : 'var(--off-white)',
                      fontSize: '0.875rem',
                      fontWeight: 600,
                    }}
                  >
                    {item === 'deposit' ? 'Deposit' : 'Withdraw'}
                  </button>
                ))}
              </div>
            </div>

            {mode === 'deposit' ? (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                    <label style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.08em', color: 'var(--warm-grey)' }}>
                      DEPOSIT AMOUNT
                    </label>
                    <span style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)' }}>
                      In {selectedPool.reserves[0].meta.code}
                    </span>
                  </div>
                  <input
                    className="input-field mono"
                    type="number"
                    min="0"
                    step="0.0000001"
                    value={depositAmountA}
                    onChange={(e) => setDepositAmountA(e.target.value)}
                    placeholder="0.0000000"
                  />
                </div>

                <div className="card" style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)' }}>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', marginBottom: '0.85rem' }}>
                    Preview
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    <Row label={`You provide ${selectedPool.reserves[0].meta.code}`} value={depositEstimate ? `${formatAmount(depositEstimate.amountA)} ${selectedPool.reserves[0].meta.code}` : '0'} />
                    <Row label={`Balanced ${selectedPool.reserves[1].meta.code}`} value={depositEstimate ? `${formatAmount(depositEstimate.amountB)} ${selectedPool.reserves[1].meta.code}` : '0'} />
                    <Row label="Estimated pool shares" value={depositEstimate ? formatAmount(depositEstimate.estimatedShares) : '0'} />
                    <Row label="Price bounds" value={depositEstimate ? `${toFixed7(depositEstimate.minPrice)} - ${toFixed7(depositEstimate.maxPrice)}` : '-'} />
                  </div>
                </div>

                {assetTrustlineMissing || shareTrustlineMissing ? (
                  <div style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.45)', lineHeight: 1.5 }}>
                    {assetTrustlineMissing ? 'A trustline is missing for one of the pool assets. The transaction will add it automatically if needed. ' : ''}
                    {shareTrustlineMissing ? 'A trustline for pool shares will also be created before the deposit.' : ''}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.45)', lineHeight: 1.5 }}>
                    Your account already has the trustlines needed for this deposit.
                  </div>
                )}

                <button
                  className="btn-gold"
                  onClick={submitTransaction}
                  disabled={txState === 'submitting' || !depositEstimate}
                >
                  {txState === 'submitting' ? 'Submitting deposit...' : `Deposit into ${selectedPool.reserves[0].meta.code}/${selectedPool.reserves[1].meta.code}`}
                </button>
              </div>
            ) : (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem' }}>
                    <label style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.08em', color: 'var(--warm-grey)' }}>
                      LP SHARES
                    </label>
                    <span style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)' }}>
                      {selectedPoolHasPosition ? `You hold ${formatAmount(selectedPosition!.shares)} shares` : 'No position found'}
                    </span>
                  </div>
                  <input
                    className="input-field mono"
                    type="number"
                    min="0"
                    step="0.0000001"
                    value={withdrawShares}
                    onChange={(e) => setWithdrawShares(e.target.value)}
                    placeholder="0.0000000"
                  />
                </div>

                <div className="card" style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)' }}>
                  <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)', marginBottom: '0.85rem' }}>
                    Estimated withdrawal
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                    <Row label={selectedPool.reserves[0].meta.code} value={withdrawEstimate ? `${formatAmount(withdrawEstimate.receivedA)} ${selectedPool.reserves[0].meta.code}` : '0'} />
                    <Row label={selectedPool.reserves[1].meta.code} value={withdrawEstimate ? `${formatAmount(withdrawEstimate.receivedB)} ${selectedPool.reserves[1].meta.code}` : '0'} />
                    <Row label="LP shares redeemed" value={withdrawEstimate ? formatAmount(withdrawEstimate.shares) : '0'} />
                  </div>
                </div>

                {!selectedPoolHasPosition && (
                  <div style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.45)', lineHeight: 1.5 }}>
                    No LP balance was found for this pool on the connected account. You can still view the estimate, but the transaction will only succeed if you own shares.
                  </div>
                )}

                <button
                  className="btn-gold"
                  onClick={submitTransaction}
                  disabled={txState === 'submitting' || !withdrawEstimate}
                >
                  {txState === 'submitting' ? 'Submitting withdrawal...' : 'Withdraw from pool'}
                </button>
              </div>
            )}
          </section>
        )}

        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.75rem' }}>
            <h2 style={{ fontSize: '0.75rem', fontFamily: 'Anton, Impact, sans-serif', color: 'var(--warm-grey)', letterSpacing: '0.08em' }}>
              YOUR POSITION
            </h2>
            <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.35)' }}>
              {loadingAccount ? 'Loading...' : signerAddress ? shortHash(signerAddress) : 'No signer'}
            </p>
          </div>

          <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <Row label="Wallet address" value={walletAddress ? shortHash(walletAddress) : '-'} />
            <Row label="Signer account" value={signerAddress ? shortHash(signerAddress) : '-'} />
            <Row label="Pool selected" value={selectedPool ? poolSharesLabel : '-'} />
            <Row label="LP balance" value={selectedPosition ? formatAmount(selectedPosition.shares) : '0'} />
          </div>
        </section>
      </main>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
      <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: '0.875rem', textAlign: 'right', wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
}

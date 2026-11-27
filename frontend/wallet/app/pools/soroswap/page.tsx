'use client'

/**
 * #1308 — add and remove Soroswap liquidity on the web wallet.
 *
 * This screen quotes the pool the wallet already holds assets for; it does not
 * discover or rank pools, and it never invents a pair. Deposits and withdrawals
 * are built by the same Soroswap client the swap screen uses (lib/soroswap) and
 * signed through the same Soroban path (lib/sorobanTx), so there is one router
 * configuration and one signing flow, not two.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { PageHeader, Card, SectionLabel, Pill } from '@/components/ui/primitives'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'
import { requirePasskey } from '@/lib/passkeyAuth'
import { isPasskeyCancellation } from '@/lib/passkeyOutcome'
import { signAndSubmitSorobanXdr } from '@/lib/sorobanTx'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import {
  checkSwapAsset,
  sameSwapAsset,
  swapAssetKey,
  swapAssetLabel,
  swapDestinations,
  swapRouteInput,
  type SwapAsset,
  type SwapRouteInput,
} from '@/lib/swapAssets'
import {
  DEFAULT_LIQUIDITY_SLIPPAGE_BPS,
  IMPERMANENT_LOSS_SENTENCE,
  LIQUIDITY_SLIPPAGE_OPTIONS,
  addLiquiditySlippageBreach,
  buildAddLiquidityXdr,
  buildRemoveLiquidityXdr,
  formatStroops,
  getSoroswapLiquidityPool,
  getSoroswapPositions,
  heldStroops,
  liquidityBalanceIssue,
  lpForPercent,
  parseAmountToStroops,
  quoteAddLiquidity,
  quoteRemoveLiquidity,
  readLpTotalSupply,
  removeLiquiditySlippageBreach,
  verifyLiquidityTransaction,
  type AddLiquidityQuote,
  type HeldBalance,
  type LpPosition,
  type RemoveLiquidityQuote,
  type SoroswapPoolView,
} from '@/lib/soroswapLiquidity'

const network = getNetwork()
const DESTINATIONS = swapDestinations(network.name)
const Server = Horizon.Server

type Mode = 'add' | 'remove'
type Step = 'form' | 'confirm' | 'sending' | 'done' | 'error'

interface PairOption {
  a: SwapAsset
  b: SwapAsset
  key: string
  labelA: string
  labelB: string
}

type PoolState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; pool: SoroswapPoolView }
  | { status: 'error'; reason: string }

function toSwapAsset(balance: HeldBalance): SwapAsset {
  return { code: balance.code, issuer: balance.issuer }
}

/**
 * Pairs the wallet already holds at least one side of: every held asset
 * against the registered assets, plus held-held pairs. Discovery — which pools
 * to show and in what order — is deliberately not attempted.
 */
function candidatePairs(balances: HeldBalance[]): PairOption[] {
  const held = balances
    .filter((b) => checkSwapAsset(toSwapAsset(b), network.name).ok)
    .map((b) => ({ asset: toSwapAsset(b), balance: b }))
  const out: PairOption[] = []
  const seen = new Set<string>()

  const push = (a: SwapAsset, b: SwapAsset) => {
    if (sameSwapAsset(a, b)) return
    const key = [swapAssetKey(a), swapAssetKey(b)].sort().join('|')
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      a,
      b,
      key,
      labelA: swapAssetLabel(a, network.name),
      labelB: swapAssetLabel(b, network.name),
    })
  }

  for (const { asset } of held) {
    for (const destination of DESTINATIONS) push(asset, destination)
    for (const other of held) push(asset, other.asset)
  }
  return out
}

function percent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(4)}%`
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err && typeof err === 'object') {
    const message = (err as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return String(err)
}

export default function SoroswapLiquidityPage() {
  const router = useRouter()
  useInactivityLock()
  const server = useMemo(() => new Server(network.horizonUrl), [])

  const [signerAddress, setSignerAddress] = useState<string | null>(null)
  const [balances, setBalances] = useState<HeldBalance[]>([])
  const [loadingAccount, setLoadingAccount] = useState(true)
  const [accountError, setAccountError] = useState<string | null>(null)

  const [pairKey, setPairKey] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('add')
  const [step, setStep] = useState<Step>('form')

  const [poolState, setPoolState] = useState<PoolState>({ status: 'idle' })
  const [position, setPosition] = useState<LpPosition | null>(null)
  const [lpSupply, setLpSupply] = useState<bigint | null>(null)

  const [amountA, setAmountA] = useState('')
  const [removePercent, setRemovePercent] = useState('100')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_LIQUIDITY_SLIPPAGE_BPS)
  const [showSlippage, setShowSlippage] = useState(false)

  const [reviewedAdd, setReviewedAdd] = useState<AddLiquidityQuote | null>(null)
  const [reviewedRemove, setReviewedRemove] = useState<RemoveLiquidityQuote | null>(null)
  /** The slippage the reviewed quote was built with; changing the pill later
   *  must not silently widen what was approved. */
  const [reviewedSlippageBps, setReviewedSlippageBps] = useState(DEFAULT_LIQUIDITY_SLIPPAGE_BPS)

  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const pairs = useMemo(() => candidatePairs(balances), [balances])
  const pair = pairs.find((p) => p.key === pairKey) ?? pairs[0] ?? null

  const route = useMemo<SwapRouteInput | null>(() => {
    if (!pair) return null
    return swapRouteInput(pair.a, pair.b, network.name, network.networkPassphrase)
  }, [pair])

  // ── Session & balances ─────────────────────────────────────────────────────
  useEffect(() => {
    const storedWallet = walletSession.getItem('invisible_wallet_address')
    if (!storedWallet) {
      router.replace('/lock')
      return
    }
    const signerSecret =
      walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    const signer = signerSecret
      ? Keypair.fromSecret(signerSecret).publicKey()
      : walletLocal.getItem('veil_signer_public_key')
    setSignerAddress(signer)
  }, [router])

  useEffect(() => {
    if (!signerAddress) return
    let cancelled = false
    setLoadingAccount(true)
    setAccountError(null)
    ;(async () => {
      try {
        const account = await server.loadAccount(signerAddress)
        if (cancelled) return
        const held: HeldBalance[] = (account.balances as unknown as Array<Record<string, unknown>>)
          .filter((b) => b.asset_type !== 'liquidity_pool_shares')
          .map((b) => ({
            code: typeof b.asset_code === 'string' ? b.asset_code : 'XLM',
            issuer: typeof b.asset_issuer === 'string' ? b.asset_issuer : null,
            balance: String(b.balance ?? '0'),
          }))
        setBalances(held)
      } catch (err) {
        if (!cancelled) setAccountError(errorMessage(err))
      } finally {
        if (!cancelled) setLoadingAccount(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [server, signerAddress, refreshKey])

  // Select the first pair the wallet holds once balances arrive.
  useEffect(() => {
    if (pairKey && pairs.some((p) => p.key === pairKey)) return
    setPairKey(pairs[0]?.key ?? null)
  }, [pairKey, pairs])

  // ── The pool, the user's LP, and the LP total supply ───────────────────────
  useEffect(() => {
    let cancelled = false
    setPosition(null)
    setLpSupply(null)
    setReviewedAdd(null)
    setReviewedRemove(null)
    setErrorMsg(null)

    if (!pair || !route) {
      setPoolState({ status: 'idle' })
      return
    }
    if (!route.ok) {
      setPoolState({ status: 'error', reason: route.reason })
      return
    }

    setPoolState({ status: 'loading' })
    ;(async () => {
      const lookup = await getSoroswapLiquidityPool(
        route.tokenIn,
        route.tokenOut,
        pair.labelA,
        pair.labelB,
      )
      if (cancelled) return
      if (!lookup.ok) {
        setPoolState({ status: 'error', reason: lookup.reason })
        return
      }

      let found: LpPosition | null = null
      let supply: bigint | null = lookup.pool.lpSupply
      if (signerAddress) {
        const positions = await getSoroswapPositions(signerAddress)
        if (cancelled) return
        found =
          positions.find((p) => p.poolAddress === lookup.pool.address) ??
          positions.find(
            (p) =>
              (p.tokenA === route.tokenIn && p.tokenB === route.tokenOut) ||
              (p.tokenA === route.tokenOut && p.tokenB === route.tokenIn),
          ) ??
          null
        supply = supply ?? found?.totalSupply ?? null
        if (!supply) {
          supply = await readLpTotalSupply({
            poolAddress: lookup.pool.address,
            sourceAddress: signerAddress,
            rpcUrl: network.rpcUrl,
            networkPassphrase: network.networkPassphrase,
          })
        }
      }
      if (cancelled) return
      setPosition(found)
      setLpSupply(supply)
      setPoolState({ status: 'ready', pool: lookup.pool })
    })()

    return () => {
      cancelled = true
    }
  }, [pair, route, signerAddress])

  const pool = poolState.status === 'ready' ? poolState.pool : null
  const userLp = position?.userLp ?? 0n

  // ── Live quotes ────────────────────────────────────────────────────────────
  const addResult = useMemo(() => {
    if (mode !== 'add' || !pool) return null
    const stroops = parseAmountToStroops(amountA)
    if (!stroops) return null
    return quoteAddLiquidity(pool, stroops, slippageBps, userLp, lpSupply)
  }, [amountA, lpSupply, mode, pool, slippageBps, userLp])

  const removeResult = useMemo(() => {
    if (mode !== 'remove' || !pool) return null
    const requested = Number(removePercent)
    const liquidity = lpForPercent(userLp, requested)
    if (liquidity <= 0n) return null
    return quoteRemoveLiquidity(pool, liquidity, slippageBps, lpSupply, userLp)
  }, [lpSupply, mode, pool, removePercent, slippageBps, userLp])

  const balanceNote = useMemo(() => {
    if (!pair) return null
    return liquidityBalanceIssue({
      pairA: pair.a,
      pairB: pair.b,
      labelA: pair.labelA,
      labelB: pair.labelB,
      balances,
      requiredA: addResult?.ok ? addResult.quote.amountA : undefined,
      requiredB: addResult?.ok ? addResult.quote.amountB : undefined,
    })
  }, [addResult, balances, pair])

  const readyToReview =
    mode === 'add'
      ? Boolean(addResult?.ok) && !balanceNote
      : Boolean(removeResult?.ok) && userLp > 0n

  // ── Submit ─────────────────────────────────────────────────────────────────
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), [])

  async function handleConfirm() {
    if (!pair || !route || !route.ok) return
    beginTx()
    setStep('sending')
    setErrorMsg(null)
    setTxHash(null)

    try {
      await requirePasskey()

      const signerSecret =
        walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
      if (!signerSecret) throw new Error('Signing key not found. Unlock the wallet again.')
      const signerPubKey = Keypair.fromSecret(signerSecret).publicKey()

      // Re-read the pool at submit, not the one from when the form was opened.
      // A move past the reviewed slippage stops here, before anything is built.
      const lookup = await getSoroswapLiquidityPool(
        route.tokenIn,
        route.tokenOut,
        pair.labelA,
        pair.labelB,
      )
      if (!lookup.ok) throw new Error(lookup.reason)

      const positions = await getSoroswapPositions(signerPubKey)
      const freshPosition =
        positions.find((p) => p.poolAddress === lookup.pool.address) ?? null
      let freshSupply = lookup.pool.lpSupply ?? freshPosition?.totalSupply ?? null
      if (!freshSupply) {
        freshSupply = await readLpTotalSupply({
          poolAddress: lookup.pool.address,
          sourceAddress: signerPubKey,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
        })
      }

      if (mode === 'add') {
        if (!reviewedAdd) throw new Error('Review the deposit before confirming it.')
        const fresh = quoteAddLiquidity(
          lookup.pool,
          reviewedAdd.amountA,
          reviewedSlippageBps,
          freshPosition?.userLp ?? 0n,
          freshSupply,
        )
        if (!fresh.ok) throw new Error(fresh.reason)

        const breach = addLiquiditySlippageBreach(reviewedAdd, fresh.quote.amountB, reviewedSlippageBps)
        if (breach) {
          setErrorMsg(breach)
          setStep('error')
          return
        }

        const built = await buildAddLiquidityXdr({
          tokenA: route.tokenIn,
          tokenB: route.tokenOut,
          amountA: fresh.quote.amountA,
          amountB: fresh.quote.amountB,
          to: signerPubKey,
          slippageBps: reviewedSlippageBps,
        })
        if (!built.ok) throw new Error(built.reason)

        // The API returns the transaction already built; check the bytes we
        // are about to sign against what the review step promised.
        const depositGuard = verifyLiquidityTransaction({
          xdr: built.built.xdr,
          networkPassphrase: network.networkPassphrase,
          expected: {
            action: 'add_liquidity',
            tokenA: route.tokenIn,
            tokenB: route.tokenOut,
            to: signerPubKey,
            minAmountA: reviewedAdd.minA,
            minAmountB: reviewedAdd.minB,
          },
        })
        if (depositGuard) {
          setErrorMsg(depositGuard)
          setStep('error')
          return
        }

        const hash = await signAndSubmitSorobanXdr({
          xdr: built.built.xdr,
          signerSecret,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
        })
        setTxHash(hash)
        setStep('done')
        refresh()
        return
      }

      if (!reviewedRemove) throw new Error('Review the withdrawal before confirming it.')
      const freshRemove = quoteRemoveLiquidity(
        lookup.pool,
        reviewedRemove.liquidity,
        reviewedSlippageBps,
        freshSupply,
        freshPosition?.userLp ?? 0n,
      )
      if (!freshRemove.ok) throw new Error(freshRemove.reason)

      const breach = removeLiquiditySlippageBreach(
        reviewedRemove,
        freshRemove.quote,
        reviewedSlippageBps,
      )
      if (breach) {
        setErrorMsg(breach)
        setStep('error')
        return
      }

      const built = await buildRemoveLiquidityXdr({
        tokenA: route.tokenIn,
        tokenB: route.tokenOut,
        liquidity: freshRemove.quote.liquidity,
        amountA: freshRemove.quote.amountA,
        amountB: freshRemove.quote.amountB,
        to: signerPubKey,
        slippageBps: reviewedSlippageBps,
      })
      if (!built.ok) throw new Error(built.reason)

      const withdrawalGuard = verifyLiquidityTransaction({
        xdr: built.built.xdr,
        networkPassphrase: network.networkPassphrase,
        expected: {
          action: 'remove_liquidity',
          tokenA: route.tokenIn,
          tokenB: route.tokenOut,
          to: signerPubKey,
          minAmountA: reviewedRemove.minA,
          minAmountB: reviewedRemove.minB,
        },
      })
      if (withdrawalGuard) {
        setErrorMsg(withdrawalGuard)
        setStep('error')
        return
      }

      const hash = await signAndSubmitSorobanXdr({
        xdr: built.built.xdr,
        signerSecret,
        rpcUrl: network.rpcUrl,
        networkPassphrase: network.networkPassphrase,
      })
      setTxHash(hash)
      setStep('done')
      refresh()
    } catch (err) {
      if (isPasskeyCancellation(err)) {
        setErrorMsg(null)
        setStep('confirm')
        return
      }
      setErrorMsg(errorMessage(err))
      setStep('error')
    } finally {
      endTx()
    }
  }

  function review() {
    setReviewedSlippageBps(slippageBps)
    if (mode === 'add') {
      if (!addResult?.ok || balanceNote) return
      setReviewedAdd(addResult.quote)
      setReviewedRemove(null)
    } else {
      if (!removeResult?.ok) return
      setReviewedRemove(removeResult.quote)
      setReviewedAdd(null)
    }
    setErrorMsg(null)
    setStep('confirm')
  }

  const feeXlm = '0.00001'
  const pairTitle = pair ? `${pair.labelA} / ${pair.labelB}` : 'No pair selected'

  return (
    <div className="wallet-shell">
      <nav className="wallet-nav">
        <button
          onClick={() => router.push('/pools')}
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
            <path
              d="M10 3L5 8l5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Pools
        </button>
        <p
          style={{
            fontSize: '0.75rem',
            fontFamily: 'Anton, Impact, sans-serif',
            letterSpacing: '0.08em',
            color: 'var(--warm-grey)',
          }}
        >
          SOROSWAP LIQUIDITY
        </p>
        <button
          onClick={() => { refresh(); setStep('form'); setTxHash(null) }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'rgba(246,247,248,0.55)',
            fontSize: '0.875rem',
          }}
        >
          Refresh
        </button>
      </nav>

      <main className="wallet-main wallet-main--wide">
        <div style={{ marginBottom: '1.5rem' }}>
          <PageHeader
            eyebrow="Pools"
            title="Soroswap liquidity"
            action={
              step === 'form' ? (
                <Pill
                  variant={showSlippage ? 'outline-gold' : 'ghost'}
                  onClick={() => setShowSlippage((v) => !v)}
                >
                  {slippageBps / 100}% slippage
                </Pill>
              ) : undefined
            }
          />
          <p style={{ color: 'rgba(246,247,248,0.52)', fontSize: '0.875rem', lineHeight: 1.6, maxWidth: 560 }}>
            Supply both assets to a Soroswap pool and receive its LP token, or burn LP tokens to
            take both assets back. Only pairs the wallet already holds assets for are offered.
          </p>
        </div>

        {step === 'form' && showSlippage && (
          <Card className="mb-4">
            <div className="flex items-center gap-2">
              <SectionLabel tone="dim">Slippage</SectionLabel>
              <div className="flex gap-2 ml-auto">
                {LIQUIDITY_SLIPPAGE_OPTIONS.map((option) => (
                  <Pill
                    key={option.bps}
                    variant={slippageBps === option.bps ? 'outline-gold' : 'ghost'}
                    onClick={() => { setSlippageBps(option.bps); setShowSlippage(false) }}
                  >
                    {option.label}
                  </Pill>
                ))}
              </div>
            </div>
          </Card>
        )}

        {accountError && (
          <Card className="mb-4">
            <p className="text-[13px] text-teal">{accountError}</p>
          </Card>
        )}

        {step === 'form' && (
          <div className="vw-row vw-row--first" style={{ alignItems: 'flex-start' }}>
            <div className="vw-swapcol">
              <Card>
                <div className="flex justify-between items-center mb-3">
                  <SectionLabel tone="dim">Pair</SectionLabel>
                  <span className="font-mono text-[12px] text-[rgba(246,247,248,0.35)]">
                    {loadingAccount ? 'Loading balances…' : `${pairs.length} pair${pairs.length === 1 ? '' : 's'}`}
                  </span>
                </div>

                {pairs.length === 0 ? (
                  <p className="text-[13px] text-[rgba(246,247,248,0.5)]">
                    This wallet holds no assets with a Soroswap pair. Receive an asset first, then
                    come back — pool discovery is a separate piece of work and Veil will not
                    invent a selection here.
                  </p>
                ) : (
                  <select
                    className="bg-surface-md border-0 text-off-white py-2 px-3 rounded-xl cursor-pointer text-[15px] font-semibold w-full"
                    value={pair?.key ?? ''}
                    onChange={(e) => {
                      setPairKey(e.target.value)
                      setAmountA('')
                      setStep('form')
                    }}
                  >
                    {pairs.map((option) => (
                      <option key={option.key} value={option.key}>
                        {option.labelA} / {option.labelB}
                      </option>
                    ))}
                  </select>
                )}

                {pair && (
                  <div className="flex gap-2 mt-3">
                    {(['add', 'remove'] as Mode[]).map((item) => (
                      <Pill
                        key={item}
                        variant={mode === item ? 'outline-gold' : 'ghost'}
                        onClick={() => { setMode(item); setStep('form'); setErrorMsg(null) }}
                      >
                        {item === 'add' ? 'Add liquidity' : 'Remove liquidity'}
                      </Pill>
                    ))}
                  </div>
                )}
              </Card>

              {pair && poolState.status === 'loading' && (
                <Card>
                  <div className="flex flex-col gap-3">
                    <div className="skeleton" style={{ width: '40%', height: '0.875rem' }} />
                    <div className="skeleton" style={{ width: '80%', height: '1.2rem' }} />
                  </div>
                </Card>
              )}

              {pair && poolState.status === 'error' && (
                <Card>
                  <p className="text-[13px] text-teal">{poolState.reason}</p>
                </Card>
              )}

              {pair && pool && (
                <>
                  {mode === 'add' ? (
                    <Card>
                      <div className="flex justify-between items-center mb-3">
                        <SectionLabel tone="dim">You supply</SectionLabel>
                        <span className="font-mono text-[12px] text-[rgba(246,247,248,0.35)]">
                          Balance: {formatStroops(heldStroops(balances, pair.a))} {pair.a.code}
                        </span>
                      </div>
                      <div className="flex gap-4 items-center">
                        <span className="text-[15px] font-semibold">{pair.a.code}</span>
                        <input
                          className="input-field"
                          type="number"
                          min="0"
                          step="0.0000001"
                          placeholder="0.00"
                          value={amountA}
                          onChange={(e) => setAmountA(e.target.value)}
                          style={{
                            flex: 1,
                            textAlign: 'right',
                            border: 'none',
                            padding: 0,
                            fontSize: '1.75rem',
                            background: 'none',
                            fontFamily: 'Inconsolata, monospace',
                          }}
                        />
                      </div>
                      <div className="flex justify-between items-center mt-3">
                        <span className="text-[12px] text-[rgba(246,247,248,0.4)]">
                          {pair.b.code} required at the pool’s ratio
                        </span>
                        <span className="font-mono text-[14px]">
                          {addResult?.ok ? formatStroops(addResult.quote.amountB) : '—'} {pair.b.code}
                        </span>
                      </div>
                    </Card>
                  ) : (
                    <Card>
                      <div className="flex justify-between items-center mb-3">
                        <SectionLabel tone="dim">Withdraw</SectionLabel>
                        <span className="font-mono text-[12px] text-[rgba(246,247,248,0.35)]">
                          LP held: {formatStroops(userLp)}
                        </span>
                      </div>
                      {userLp <= 0n ? (
                        <p className="text-[13px] text-[rgba(246,247,248,0.5)]">
                          This account holds no LP tokens in this pool. Add liquidity first.
                        </p>
                      ) : (
                        <>
                          <div className="flex gap-2 mb-3">
                            {[25, 50, 100].map((pct) => (
                              <Pill
                                key={pct}
                                variant={removePercent === String(pct) ? 'outline-gold' : 'ghost'}
                                onClick={() => setRemovePercent(String(pct))}
                              >
                                {pct}%
                              </Pill>
                            ))}
                          </div>
                          <div className="flex gap-4 items-center">
                            <span className="text-[15px] font-semibold">Percent</span>
                            <input
                              className="input-field"
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              value={removePercent}
                              onChange={(e) => setRemovePercent(e.target.value)}
                              style={{
                                flex: 1,
                                textAlign: 'right',
                                border: 'none',
                                padding: 0,
                                fontSize: '1.75rem',
                                background: 'none',
                                fontFamily: 'Inconsolata, monospace',
                              }}
                            />
                          </div>
                          <div className="flex justify-between items-center mt-3">
                            <span className="text-[12px] text-[rgba(246,247,248,0.4)]">
                              LP burned
                            </span>
                            <span className="font-mono text-[14px]">
                              {removeResult?.ok ? formatStroops(removeResult.quote.liquidity) : '—'}
                            </span>
                          </div>
                          <div className="flex justify-between items-center mt-2">
                            <span className="text-[12px] text-[rgba(246,247,248,0.4)]">
                              You receive (expected)
                            </span>
                            <span className="font-mono text-[14px] text-right">
                              {removeResult?.ok
                                ? `${formatStroops(removeResult.quote.amountA)} ${pair.a.code} + ${formatStroops(removeResult.quote.amountB)} ${pair.b.code}`
                                : '—'}
                            </span>
                          </div>
                        </>
                      )}
                    </Card>
                  )}

                  {balanceNote && (
                    <Card>
                      <p className="text-[13px] text-teal">{balanceNote}</p>
                    </Card>
                  )}

                  {mode === 'add' && addResult && !addResult.ok && (
                    <Card>
                      <p className="text-[13px] text-teal">{addResult.reason}</p>
                    </Card>
                  )}
                  {mode === 'remove' && removeResult && !removeResult.ok && (
                    <Card>
                      <p className="text-[13px] text-teal">{removeResult.reason}</p>
                    </Card>
                  )}

                  <div style={{ marginTop: '0.5rem' }}>
                    <button className="btn-gold" onClick={review} disabled={!readyToReview}>
                      Review {mode === 'add' ? 'deposit' : 'withdrawal'}
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="vw-swapside">
              <Card>
                <SectionLabel tone="dim" className="mb-3">Pool</SectionLabel>
                <div className="flex flex-col gap-2">
                  <Row label="Pair" value={pairTitle} />
                  <Row
                    label="Reserves"
                    value={
                      pool
                        ? `${formatStroops(pool.reserveA)} ${pair?.a.code} / ${formatStroops(pool.reserveB)} ${pair?.b.code}`
                        : '—'
                    }
                  />
                  <Row
                    label="Ratio required"
                    value={
                      pool && pair
                        ? `1 ${pair.a.code} = ${formatRatio(pool.reserveB, pool.reserveA)} ${pair.b.code}`
                        : '—'
                    }
                  />
                  <Row
                    label="Your pool share"
                    value={userLp > 0n && lpSupply ? percent(Number(userLp) / Number(lpSupply)) : lpSupply ? '0.0000%' : '—'}
                  />
                  <Row
                    label="LP minted (est.)"
                    value={
                      mode === 'add' && addResult?.ok && addResult.quote.mintedLp !== null
                        ? formatStroops(addResult.quote.mintedLp)
                        : mode === 'remove' && removeResult?.ok
                          ? `−${formatStroops(removeResult.quote.liquidity)}`
                          : '—'
                    }
                  />
                  <Row
                    label="Share after"
                    value={
                      mode === 'add' && addResult?.ok
                        ? percent(addResult.quote.shareAfter)
                        : mode === 'remove' && removeResult?.ok && lpSupply
                          ? percent(Number(userLp - removeResult.quote.liquidity) / Number(lpSupply))
                          : '—'
                    }
                  />
                  <Row
                    label="Min. receive A / B"
                    value={
                      mode === 'remove' && removeResult?.ok
                        ? `${formatStroops(removeResult.quote.minA)} ${pair?.a.code} / ${formatStroops(removeResult.quote.minB)} ${pair?.b.code}`
                        : '—'
                    }
                  />
                  <Row label="Slippage" value={`${slippageBps / 100}%`} />
                  <Row label="Network fee" value={`${feeXlm} XLM`} />
                </div>
              </Card>
              <p className="text-[12px] text-[rgba(246,247,248,0.4)] mt-3" style={{ lineHeight: 1.6 }}>
                Soroswap liquidity is provided to the pool contract. LP tokens are the receipt and
                the only way to withdraw; the amounts shown are estimates from the current
                reserves.
              </p>
            </div>
          </div>
        )}

        {step === 'confirm' && pair && (
          <div className="flex flex-col gap-5">
            <Card>
              <SectionLabel tone="dim" className="mb-4">
                Confirm {mode === 'add' ? 'deposit' : 'withdrawal'}
              </SectionLabel>
              <div className="flex flex-col gap-3">
                <Row label="Pair" value={pairTitle} />
                <div className="flex flex-col gap-1">
                  <span className="text-[13px] text-[rgba(246,247,248,0.4)]">Pool contract</span>
                  <span className="font-mono text-[12px] text-[rgba(246,247,248,0.75)] break-all select-all">
                    {pool?.address ?? '—'}
                  </span>
                </div>
                {mode === 'add' && reviewedAdd ? (
                  <>
                    <Row label="You supply" value={`${formatStroops(reviewedAdd.amountA)} ${pair.a.code}`} />
                    <Row
                      label="Second asset required"
                      value={`${formatStroops(reviewedAdd.amountB)} ${pair.b.code}`}
                    />
                    <Row
                      label="Ratio required"
                      value={`1 ${pair.a.code} = ${formatRatio(pool?.reserveB ?? 0n, pool?.reserveA ?? 0n)} ${pair.b.code}`}
                    />
                    <Row
                      label="LP tokens minted (est.)"
                      value={
                        reviewedAdd.mintedLp !== null
                          ? formatStroops(reviewedAdd.mintedLp)
                          : 'Unavailable — pool LP supply could not be read'
                      }
                    />
                    <Row
                      label="Pool share"
                      value={
                        reviewedAdd.shareBefore !== null && reviewedAdd.shareAfter !== null
                          ? `${percent(reviewedAdd.shareBefore)} → ${percent(reviewedAdd.shareAfter)}`
                          : 'Unavailable — pool LP supply could not be read'
                      }
                    />
                    <Row
                      label="Minimum after slippage"
                      value={`${formatStroops(reviewedAdd.minA)} ${pair.a.code} / ${formatStroops(reviewedAdd.minB)} ${pair.b.code}`}
                    />
                  </>
                ) : mode === 'remove' && reviewedRemove ? (
                  <>
                    <Row label="LP burned" value={formatStroops(reviewedRemove.liquidity)} />
                    <Row
                      label={`Expected ${pair.a.code}`}
                      value={formatStroops(reviewedRemove.amountA)}
                    />
                    <Row
                      label={`Expected ${pair.b.code}`}
                      value={formatStroops(reviewedRemove.amountB)}
                    />
                    <Row
                      label="Minimum after slippage"
                      value={`${formatStroops(reviewedRemove.minA)} ${pair.a.code} / ${formatStroops(reviewedRemove.minB)} ${pair.b.code}`}
                    />
                    <Row label="Share burned" value={percent(reviewedRemove.shareBurned)} />
                  </>
                ) : null}
                <Row label="Slippage tolerance" value={`${reviewedSlippageBps / 100}%`} />
                <Row label="Network fee" value={`${feeXlm} XLM`} />
              </div>
              <div
                className="mt-4"
                style={{
                  borderTop: '1px solid var(--border-dim)',
                  paddingTop: '0.875rem',
                }}
              >
                <p className="text-[12px] text-[rgba(246,247,248,0.55)]" style={{ lineHeight: 1.6 }}>
                  {IMPERMANENT_LOSS_SENTENCE}
                </p>
              </div>
            </Card>
            <div className="flex flex-col gap-3">
              <button className="btn-gold" onClick={handleConfirm}>
                Confirm {mode === 'add' ? 'deposit' : 'withdrawal'}
              </button>
              <button className="btn-ghost" onClick={() => setStep('form')}>
                Edit
              </button>
            </div>
          </div>
        )}

        {step === 'sending' && (
          <Card className="text-center">
            <div className="flex justify-center mb-4">
              <div className="spinner spinner-light" />
            </div>
            <p className="font-medium">Waiting for passkey…</p>
            <p className="text-[13px] text-[rgba(246,247,248,0.4)] mt-2">
              Approve with Face ID / fingerprint to continue
            </p>
          </Card>
        )}

        {step === 'done' && (
          <Card className="flex flex-col gap-5 items-center text-center">
            <div className="text-teal text-[2.5rem]">✓</div>
            <div>
              <p className="font-lora italic font-semibold text-[1.25rem]">
                {mode === 'add' ? 'Liquidity added' : 'Liquidity removed'}
              </p>
              {txHash && (
                <p className="font-mono text-[12px] text-[rgba(246,247,248,0.35)] mt-2 break-all">
                  {txHash}
                </p>
              )}
            </div>
            <button className="btn-gold" onClick={() => router.push('/pools')}>
              Done
            </button>
          </Card>
        )}

        {step === 'error' && (
          <Card className="flex flex-col gap-5 items-center text-center">
            <div className="text-teal text-[2.5rem]">!</div>
            <div>
              <p className="font-medium">
                {mode === 'add' ? 'Deposit not submitted' : 'Withdrawal not submitted'}
              </p>
              <p className="text-[13px] text-[rgba(246,247,248,0.4)] mt-2">{errorMsg}</p>
            </div>
            <button className="btn-ghost" onClick={() => setStep('form')}>
              Try again
            </button>
          </Card>
        )}
      </main>
    </div>
  )
}

function formatRatio(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) return '—'
  const scaled = (numerator * 1_0000000n) / denominator
  return formatStroops(scaled, 6)
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-[13px] text-[rgba(246,247,248,0.4)] shrink-0">{label}</span>
      <span className="text-[14px] text-right break-all">{value}</span>
    </div>
  )
}

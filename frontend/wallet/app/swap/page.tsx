'use client'

import { spendableNativeXlm } from '@/lib/reserves'
import { getUsdcIssuer } from '@/lib/network'
import { inclusionFee } from '@/lib/fees'
import { PageHeader, Card, SectionLabel, Pill } from '@/components/ui/primitives'
import { DEST_CODES, makeDestAsset, resolveFlip, type StellarAsset } from './direction'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Asset,
  Horizon,
  Networks,
  Transaction,
} from '@stellar/stellar-sdk'
import { walletLocal, walletSession } from '@/lib/walletStorage'
const Server = Horizon.Server
import { VeilMark } from '@/components/ui/VeilMark'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { getNetwork } from '@/lib/network'
import { beginTx, endTx } from '@/lib/txState'
import { requirePasskey } from '@/lib/passkeyAuth'
import { signAndSubmitSorobanXdr } from '@/lib/sorobanTx'
import {
  getSoroswapQuote,
  buildSoroswapSwapXdr,
  resolveTokenAddress,
  type SwapQuote,
} from '@/lib/soroswap'

const network = getNetwork()

// ── Constants ──────────────────────────────────────────────────────────────────
const DEBOUNCE_MS = 600
// Resolved per network — see getUsdcIssuer(). Previously pinned to the
// testnet issuer, which made mainnet swaps default to the wrong asset.
const DEFAULT_USDC = { code: 'USDC', issuer: getUsdcIssuer() }

const SLIPPAGE_OPTIONS = [
  { label: '0.1%', bps: 10 },
  { label: '0.5%', bps: 50 },
  { label: '1.0%', bps: 100 },
]

type Step = 'form' | 'confirm' | 'swapping' | 'done' | 'error'


// ── Swap Page ─────────────────────────────────────────────────────────────────
export default function SwapPage() {
  const router = useRouter()
  useInactivityLock()
  const [step, setStep] = useState<Step>('form')
  const [walletAddress, setWalletAddress] = useState<string | null>(null)

  // Assets & Amounts
  const [sourceBalances, setSourceBalances] = useState<StellarAsset[]>([])
  // Native XLM that can actually leave the account once the base reserve and
  // any selling liabilities are held back. Null until the account is loaded.
  const [spendableXlm, setSpendableXlm] = useState<string | null>(null)
  const [sourceAsset, setSourceAsset] = useState<StellarAsset | null>(null)
  const [destAsset, setDestAsset] = useState<StellarAsset>({
    code: 'USDC',
    issuer: DEFAULT_USDC.issuer,
    balance: '0',
  })
  const [sourceAmount, setSourceAmount] = useState('')
  const [destAmount, setDestAmount] = useState('')

  // Soroswap
  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [usingSoroswap, setUsingSoroswap] = useState(false)
  const [isFetchingQuote, setIsFetchingQuote] = useState(false)

  // Classic SDEX fallback
  const [path, setPath] = useState<Asset[]>([])

  // Slippage
  const [slippageBps, setSlippageBps] = useState(50)
  const [showSlippage, setShowSlippage] = useState(false)

  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const server = new Server(network.horizonUrl)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Load session ──
  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }
    setWalletAddress(addr)
    fetchBalances(addr)
  }, [router])

  const fetchBalances = async (_addr: string) => {
    try {
      const signerSecret = walletSession.getItem('veil_signer_secret')
      const accountAddr = signerSecret
        ? Keypair.fromSecret(signerSecret).publicKey()
        : (walletLocal.getItem('veil_signer_public_key') || null)
      if (!accountAddr || accountAddr.startsWith('C')) {
        setErrorMsg('Signing key not found. Go to Dashboard and tap "Set up fee-payer" first.')
        return
      }
      const res = await fetch(`${network.horizonUrl}/accounts/${accountAddr}`)
      if (res.ok) {
        const data = await res.json()
        const assets: StellarAsset[] = data.balances.map((b: any) => ({
          code: b.asset_code || 'XLM',
          issuer: b.asset_issuer,
          balance: b.balance,
        }))
        setSpendableXlm(spendableNativeXlm(data))
        setSourceBalances(assets)
        setSourceAsset(assets.find((a) => a.code === 'XLM') || assets[0])
      }
    } catch (err) {
      console.error('Failed to fetch balances', err)
    }
  }

  // ── Quote fetching (Soroswap first, SDEX fallback) ──
  useEffect(() => {
    if (
      !sourceAsset ||
      !destAsset ||
      !sourceAmount ||
      isNaN(parseFloat(sourceAmount)) ||
      parseFloat(sourceAmount) <= 0
    ) {
      setDestAmount('')
      setQuote(null)
      setPath([])
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(async () => {
      setIsFetchingQuote(true)
      setErrorMsg(null)
      setUsingSoroswap(false)

      // --- Try Soroswap aggregator first ---
      try {
        const [tokenInAddress, tokenOutAddress] = await Promise.all([
          sourceAsset.code === 'XLM'
            ? Asset.native().contractId(network.networkPassphrase)
            : resolveTokenAddress(sourceAsset.code),
          destAsset.code === 'XLM'
            ? Asset.native().contractId(network.networkPassphrase)
            : resolveTokenAddress(destAsset.code),
        ])

        if (tokenInAddress && tokenOutAddress) {
          const amountInStroops = Math.round(
            parseFloat(sourceAmount) * 1e7
          ).toString()
          const signerPub =
            Keypair.fromSecret(
              walletSession.getItem('veil_signer_secret') ||
                walletLocal.getItem('veil_signer_secret') ||
                ''
            ).publicKey() || ''

          const q = await getSoroswapQuote({
            tokenIn: tokenInAddress,
            tokenOut: tokenOutAddress,
            amountIn: amountInStroops,
            slippageBps,
            feePayerAddress: signerPub,
          })

          if (q) {
            setQuote(q)
            setUsingSoroswap(true)
            // Convert stroops back to display units
            setDestAmount((Number(q.amountOut) / 1e7).toFixed(7))
            setIsFetchingQuote(false)
            return
          }
        }
      } catch (soroErr) {
        console.warn('Soroswap quote failed, falling back to SDEX:', soroErr)
      }

      // --- SDEX Fallback ---
      try {
        const source =
          sourceAsset.code === 'XLM' || !sourceAsset.issuer
            ? Asset.native()
            : new Asset(sourceAsset.code, sourceAsset.issuer!)
        const dest =
          destAsset.code === 'XLM' || !destAsset.issuer
            ? Asset.native()
            : new Asset(destAsset.code, destAsset.issuer!)
        const pathsResult = await server.strictSendPaths(source, sourceAmount, [dest]).call()
        if (pathsResult.records.length > 0) {
          const bestPath = pathsResult.records[0]
          setDestAmount(bestPath.destination_amount)
          setPath(
            bestPath.path.map((p: any) =>
              p.asset_type === 'native' || !p.asset_code
                ? Asset.native()
                : new Asset(p.asset_code, p.asset_issuer)
            )
          )
          setUsingSoroswap(false)
          setQuote(null)
        } else {
          setErrorMsg('No path found. Try a different amount or asset.')
          setDestAmount('')
        }
      } catch (err) {
        console.error('SDEX pathfind error', err)
        setErrorMsg('Error finding swap path. Check your connection.')
      } finally {
        setIsFetchingQuote(false)
      }
    }, DEBOUNCE_MS)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [sourceAmount, sourceAsset, destAsset, slippageBps])

  // ── Swap Execution ──
  async function handleSwap() {
    beginTx()
    setStep('swapping')
    setErrorMsg(null)
    try {
      await requirePasskey()

      const signerSecret =
        walletSession.getItem('veil_signer_secret') ||
        walletLocal.getItem('veil_signer_secret')
      if (!signerSecret) {
        setErrorMsg('Signing key not found.')
        setStep('error')
        return
      }
      const signerKeypair = Keypair.fromSecret(signerSecret)
      const signerPubKey = signerKeypair.publicKey()

      // ── Soroswap path ──
      if (usingSoroswap && quote) {
        // Re-fetch quote if it has expired
        const liveQuote =
          Date.now() > quote.ttl
            ? await (async () => {
                const tokenIn = await (sourceAsset!.code === 'XLM'
                  ? Asset.native().contractId(network.networkPassphrase)
                  : resolveTokenAddress(sourceAsset!.code))
                const tokenOut = await (destAsset.code === 'XLM'
                  ? Asset.native().contractId(network.networkPassphrase)
                  : resolveTokenAddress(destAsset.code))
                return tokenIn && tokenOut
                  ? getSoroswapQuote({
                      tokenIn,
                      tokenOut,
                      amountIn: Math.round(parseFloat(sourceAmount) * 1e7).toString(),
                      slippageBps,
                      feePayerAddress: signerPubKey,
                    })
                  : null
              })()
            : quote

        if (!liveQuote) {
          setErrorMsg('Quote expired and could not be refreshed. Please retry.')
          setStep('error')
          return
        }

        const tokenIn = await (sourceAsset!.code === 'XLM'
          ? Asset.native().contractId(network.networkPassphrase)
          : resolveTokenAddress(sourceAsset!.code))
        const tokenOut = await (destAsset.code === 'XLM'
          ? Asset.native().contractId(network.networkPassphrase)
          : resolveTokenAddress(destAsset.code))

        const xdr = await buildSoroswapSwapXdr({
          tokenIn: tokenIn!,
          tokenOut: tokenOut!,
          amountIn: Math.round(parseFloat(sourceAmount) * 1e7).toString(),
          slippageBps,
          feePayerAddress: signerPubKey,
        })

        if (!xdr) {
          throw new Error('Failed to build Soroswap transaction. Falling back to SDEX is required.')
        }

        const hash = await signAndSubmitSorobanXdr({
          xdr,
          signerSecret,
          rpcUrl: network.rpcUrl,
          networkPassphrase: network.networkPassphrase,
        })
        setTxHash(hash)
        setStep('done')
        return
      }

      // ── Classic SDEX fallback ──
      const account = await server.loadAccount(signerPubKey)
      const source =
        sourceAsset!.code === 'XLM' || !sourceAsset!.issuer
          ? Asset.native()
          : new Asset(sourceAsset!.code, sourceAsset!.issuer!)
      const dest =
        destAsset.code === 'XLM' || !destAsset.issuer
          ? Asset.native()
          : new Asset(destAsset.code, destAsset.issuer!)

      const destMin = (parseFloat(destAmount) * (1 - slippageBps / 10000)).toFixed(7)

      const hasTrustline =
        dest.isNative() ||
        account.balances.some(
          (b: any) =>
            b.asset_code === dest.getCode() && b.asset_issuer === dest.getIssuer()
        )

      const txBuilder = new TransactionBuilder(account, {
        fee: inclusionFee(),
        networkPassphrase: network.networkPassphrase,
      })

      if (!hasTrustline) {
        txBuilder.addOperation(Operation.changeTrust({ asset: dest }))
      }

      txBuilder
        .addOperation(
          Operation.pathPaymentStrictSend({
            sendAsset: source,
            sendAmount: sourceAmount,
            destination: signerPubKey,
            destAsset: dest,
            destMin,
            path,
          })
        )
        .setTimeout(30)

      const tx = txBuilder.build()
      tx.sign(signerKeypair)
      const result = await server.submitTransaction(tx)
      setTxHash(result.hash)
      setStep('done')
    } catch (err: unknown) {
      const horizonError = (err as any)?.response?.data
      const codes = horizonError?.extras?.result_codes
      const msg = codes
        ? `${codes.transaction ?? ''} — ${(codes.operations ?? []).join(', ')}`
            .trim()
            .replace(/^—\s*/, '')
        : err instanceof Error
        ? err.message
        : String(err)
      setErrorMsg(msg)
      setStep('error')
    } finally {
      endTx()
    }
  }

  const rate =
    sourceAmount && destAmount
      ? (parseFloat(destAmount) / parseFloat(sourceAmount)).toFixed(4)
      : null

  const slippageTolerance = slippageBps / 10000

  const flip = resolveFlip(sourceAsset?.code, destAsset.code, sourceBalances, DEFAULT_USDC.issuer)

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
            <path
              d="M10 3L5 8l5 5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Dashboard
        </button>
        <VeilMark size={22} />
      </nav>

      <main className="wallet-main wallet-main--wide">
        <div style={{ marginBottom: '1.75rem' }}>
          <PageHeader
            eyebrow="Exchange"
            title="Swap"
            action={
              <Pill
                variant={showSlippage ? 'outline-gold' : 'ghost'}
                onClick={() => setShowSlippage((v) => !v)}
              >
                {slippageBps / 100}% slippage
              </Pill>
            }
          />
        </div>

        {/* Slippage selector */}
        {showSlippage && (
          <Card className="mb-4">
            <div className="flex items-center gap-2">
              <SectionLabel tone="dim">Slippage</SectionLabel>
              <div className="flex gap-2 ml-auto">
                {SLIPPAGE_OPTIONS.map((opt) => (
                  <Pill
                    key={opt.bps}
                    variant={slippageBps === opt.bps ? 'outline-gold' : 'ghost'}
                    onClick={() => { setSlippageBps(opt.bps); setShowSlippage(false) }}
                  >
                    {opt.label}
                  </Pill>
                ))}
              </div>
            </div>
          </Card>
        )}

        {step === 'form' && (
          <div className="vw-row vw-row--first" style={{ alignItems: 'flex-start' }}>
            <div className="vw-swapcol">
            {/* The pay/receive pair sits flush so the toggle straddles the seam. */}
            <div className="flex flex-col relative">
            {/* You Pay */}
            <Card>
              <div className="flex justify-between items-center mb-3">
                <SectionLabel tone="dim">You pay</SectionLabel>
                <div className="flex gap-2 items-center">
                  <span className="font-mono text-[12px] text-[rgba(246,247,248,0.35)]">
                    Balance: {sourceAsset?.balance || '0'} {sourceAsset?.code}
                  </span>
                  <Pill
                    variant="outline-gold"
                    onClick={() =>
                      setSourceAmount(
                        sourceAsset?.code === 'XLM' && spendableXlm !== null
                          ? spendableXlm
                          : sourceAsset?.balance || '',
                      )
                    }
                  >
                    Max
                  </Pill>
                </div>
              </div>
              <div className="flex gap-4 items-center">
                <select
                  className="bg-surface-md border-0 text-off-white py-2 px-3 rounded-xl cursor-pointer text-[15px] font-semibold"
                  value={sourceAsset?.code || ''}
                  onChange={(e) =>
                    setSourceAsset(sourceBalances.find((b) => b.code === e.target.value) || null)
                  }
                >
                  {sourceBalances.map((b) => (
                    <option key={b.code} value={b.code}>
                      {b.code}
                    </option>
                  ))}
                </select>
                <input
                  className="input-field"
                  type="number"
                  placeholder="0.00"
                  value={sourceAmount}
                  onChange={(e) => setSourceAmount(e.target.value)}
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
            </Card>

            {/* Circular swap toggle */}
            <div className="flex justify-center" style={{ margin: '-18px 0', zIndex: 10 }}>
              <button
                type="button"
                aria-label="Swap direction"
                disabled={!flip}
                title={flip ? 'Swap direction' : 'This pair cannot be flipped'}
                onClick={() => {
                  if (!flip) return
                  setDestAsset(flip.nextDest)
                  setSourceAsset(flip.nextSource)
                  // The receive amount becomes what we now pay; the quote effect
                  // refills the other side rather than showing a stale figure.
                  setSourceAmount(destAmount)
                  setDestAmount('')
                }}
                className="rounded-full flex items-center justify-center transition-transform duration-200 hover:scale-110 active:scale-95 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100"
                style={{
                  width: 40,
                  height: 40,
                  background: 'var(--surface-md)',
                  border: '4px solid var(--near-black)',
                }}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path
                    d="M9 3v12M5 11l4 4 4-4"
                    stroke="var(--gold)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            {/* You Receive */}
            <Card>
              <div className="flex justify-between items-center mb-3">
                <SectionLabel tone="dim">You receive</SectionLabel>
                {usingSoroswap && quote && (
                  <span className="text-[11px] font-semibold uppercase rounded-pill px-2 py-[2px] whitespace-nowrap text-gold bg-[rgba(253,218,36,0.1)]" style={{ letterSpacing: '0.08em' }}>
                    via {quote.protocols.join(' · ')}
                  </span>
                )}
              </div>
              <div className="flex gap-4 items-center">
                <select
                  className="bg-surface-md border-0 text-off-white py-2 px-3 rounded-xl cursor-pointer text-[15px] font-semibold"
                  value={destAsset.code}
                  onChange={(e) => setDestAsset(makeDestAsset(e.target.value, DEFAULT_USDC.issuer))}
                >
                  {DEST_CODES.map((code) => (
                    <option key={code} value={code}>
                      {code}
                    </option>
                  ))}
                </select>
                <div className="flex-1 text-right font-mono text-[1.75rem] text-off-white">
                  {isFetchingQuote ? '...' : destAmount || '0.00'}
                </div>
              </div>
            </Card>

            </div>

            {errorMsg && (
              <div
                className="card"
                style={{ background: 'rgba(255,0,0,0.05)', border: '1px solid rgba(255,0,0,0.1)' }}
              >
                <p className="text-[13px] text-teal text-center">
                  {errorMsg}
                </p>
              </div>
            )}

            <div style={{ marginTop: '0.5rem' }}>
              <button
                className="btn-gold"
                onClick={() => setStep('confirm')}
                disabled={!sourceAmount || !destAmount || isFetchingQuote || !!errorMsg}
              >
                Review swap
              </button>
            </div>
            </div>

            <div className="vw-swapside">
            {/* Quote panel */}
            {rate && !errorMsg && (
              <Card>
                <SectionLabel tone="dim" className="mb-3">Quote details</SectionLabel>
                <div className="flex flex-col gap-2">
                  <Row label="Rate" value={`1 ${sourceAsset?.code} ≈ ${rate} ${destAsset.code}`} />
                  {usingSoroswap && quote && (
                    <>
                      <Row
                        label="Price impact"
                        value={
                          quote.priceImpact < 0.005
                            ? '< 0.01%'
                            : `${(quote.priceImpact * 100).toFixed(2)}%`
                        }
                      />
                      <Row label="Route" value={quote.protocols.join(' · ')} />
                    </>
                  )}
                  {!usingSoroswap && (
                    <Row label="Route" value="SDEX" />
                  )}
                  <Row label="Slippage" value={`${slippageBps / 100}%`} />
                  <Row
                    label="Min. received"
                    value={`${(parseFloat(destAmount) * (1 - slippageTolerance)).toFixed(7)} ${destAsset.code}`}
                  />
                </div>
              </Card>
            )}
            </div>
          </div>
        )}

        {step === 'confirm' && (
          <div className="flex flex-col gap-5">
            <Card>
              <SectionLabel tone="dim" className="mb-4">Confirm swap</SectionLabel>
              <div className="flex flex-col gap-3">
                <Row label="Pay" value={`${sourceAmount} ${sourceAsset?.code}`} />
                <Row label="Receive (est.)" value={`${destAmount} ${destAsset.code}`} />
                <Row
                  label="Min. received"
                  value={`${(parseFloat(destAmount) * (1 - slippageTolerance)).toFixed(7)} ${destAsset.code}`}
                />
                <Row label="Slippage tolerance" value={`${slippageBps / 100}%`} />
                {usingSoroswap && quote && (
                  <>
                    <Row
                      label="Price impact"
                      value={
                        quote.priceImpact < 0.005
                          ? '< 0.01%'
                          : `${(quote.priceImpact * 100).toFixed(2)}%`
                      }
                    />
                    <Row label="Route" value={quote.protocols.join(' · ')} />
                  </>
                )}
                {!usingSoroswap && <Row label="Route" value="SDEX" />}
                <Row label="Network fee" value="0.00001 XLM" />
              </div>
            </Card>
            <div className="flex flex-col gap-3">
              <button className="btn-gold" onClick={handleSwap}>
                Confirm swap
              </button>
              <button className="btn-ghost" onClick={() => setStep('form')}>
                Edit
              </button>
            </div>
          </div>
        )}

        {step === 'swapping' && (
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
            <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
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
              <p className="font-lora italic font-semibold text-[1.25rem]">
                Swap successful
              </p>
              {txHash && (
                <p className="font-mono text-[12px] text-[rgba(246,247,248,0.35)] mt-2 break-all">
                  {txHash.slice(0, 20)}...
                </p>
              )}
            </div>
            <button className="btn-gold" onClick={() => router.push('/dashboard')}>
              Done
            </button>
          </Card>
        )}

        {step === 'error' && (
          <Card className="flex flex-col gap-5 items-center text-center">
            <div className="text-teal text-[2.5rem]">!</div>
            <div>
              <p className="font-medium">Swap failed</p>
              <p className="text-[13px] text-[rgba(246,247,248,0.4)] mt-2">
                {errorMsg}
              </p>
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-start gap-4">
      <span className="text-[13px] text-[rgba(246,247,248,0.4)] shrink-0">
        {label}
      </span>
      <span className="text-[14px] text-right break-all">
        {value}
      </span>
    </div>
  )
}

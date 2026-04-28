'use client'

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
const Server = Horizon.Server
import { VeilLogo } from '@/components/VeilLogo'
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
const TESTNET_USDC = {
  code: 'USDC',
  issuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
}

const SLIPPAGE_OPTIONS = [
  { label: '0.1%', bps: 10 },
  { label: '0.5%', bps: 50 },
  { label: '1.0%', bps: 100 },
]

type Step = 'form' | 'confirm' | 'swapping' | 'done' | 'error'

interface StellarAsset {
  code: string
  issuer?: string
  balance: string
}

// ── Swap Page ─────────────────────────────────────────────────────────────────
export default function SwapPage() {
  const router = useRouter()
  useInactivityLock()
  const [step, setStep] = useState<Step>('form')
  const [walletAddress, setWalletAddress] = useState<string | null>(null)

  // Assets & Amounts
  const [sourceBalances, setSourceBalances] = useState<StellarAsset[]>([])
  const [sourceAsset, setSourceAsset] = useState<StellarAsset | null>(null)
  const [destAsset, setDestAsset] = useState<StellarAsset>({
    code: 'USDC',
    issuer: TESTNET_USDC.issuer,
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
    const addr = sessionStorage.getItem('invisible_wallet_address')
    if (!addr) { router.replace('/lock'); return }
    setWalletAddress(addr)
    fetchBalances(addr)
  }, [router])

  const fetchBalances = async (_addr: string) => {
    try {
      const signerSecret = sessionStorage.getItem('veil_signer_secret')
      const accountAddr = signerSecret
        ? Keypair.fromSecret(signerSecret).publicKey()
        : (localStorage.getItem('veil_signer_public_key') || null)
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
              sessionStorage.getItem('veil_signer_secret') ||
                localStorage.getItem('veil_signer_secret') ||
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
        sessionStorage.getItem('veil_signer_secret') ||
        localStorage.getItem('veil_signer_secret')
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
        fee: BASE_FEE,
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
        <VeilLogo size={22} />
        {/* Slippage settings icon */}
        <button
          onClick={() => setShowSlippage((v) => !v)}
          title="Slippage settings"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'rgba(246,247,248,0.5)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
            <circle cx="10" cy="10" r="9" stroke="currentColor" strokeWidth="1.4" />
            <path
              d="M7 10h6M10 7v6"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </nav>

      {/* Slippage panel */}
      {showSlippage && (
        <div
          className="card"
          style={{ margin: '0 1.25rem', padding: '0.875rem', display: 'flex', gap: '0.5rem' }}
        >
          <span style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.45)', alignSelf: 'center', marginRight: '0.5rem' }}>
            Slippage:
          </span>
          {SLIPPAGE_OPTIONS.map((opt) => (
            <button
              key={opt.bps}
              onClick={() => { setSlippageBps(opt.bps); setShowSlippage(false) }}
              style={{
                padding: '0.25rem 0.75rem',
                borderRadius: '999px',
                border: slippageBps === opt.bps ? '1px solid var(--gold)' : '1px solid rgba(246,247,248,0.15)',
                background: slippageBps === opt.bps ? 'rgba(212,175,55,0.12)' : 'transparent',
                color: slippageBps === opt.bps ? 'var(--gold)' : 'var(--off-white)',
                cursor: 'pointer',
                fontSize: '0.8125rem',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      <main className="wallet-main">
        <h2
          style={{
            fontFamily: 'Lora, Georgia, serif',
            fontWeight: 600,
            fontStyle: 'italic',
            fontSize: '1.75rem',
            marginBottom: '1.75rem',
          }}
        >
          Swap tokens
        </h2>

        {step === 'form' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* You Pay */}
            <div className="card" style={{ padding: '1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <label
                  style={{
                    fontSize: '0.75rem',
                    color: 'rgba(246,247,248,0.4)',
                    fontFamily: 'Anton, Impact, sans-serif',
                    letterSpacing: '0.06em',
                  }}
                >
                  YOU PAY
                </label>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.3)' }}>
                    Balance: {sourceAsset?.balance || '0'} {sourceAsset?.code}
                  </span>
                  <button
                    onClick={() => setSourceAmount(sourceAsset?.balance || '')}
                    style={{
                      fontSize: '0.6875rem',
                      padding: '0.125rem 0.375rem',
                      border: '1px solid rgba(212,175,55,0.35)',
                      borderRadius: '4px',
                      background: 'transparent',
                      color: 'var(--gold)',
                      cursor: 'pointer',
                    }}
                  >
                    Max
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <select
                  style={{
                    background: 'var(--surface-md)',
                    border: 'none',
                    color: 'white',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    cursor: 'pointer',
                  }}
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
                    fontSize: '1.5rem',
                    background: 'none',
                  }}
                />
              </div>
            </div>

            {/* Down Arrow */}
            <div style={{ display: 'flex', justifyContent: 'center', margin: '-0.5rem 0' }}>
              <div
                style={{
                  background: 'var(--surface-md)',
                  borderRadius: '50%',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: '4px solid var(--background)',
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 3v10M4 9l4 4 4-4"
                    stroke="var(--gold)"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>

            {/* You Receive */}
            <div className="card" style={{ padding: '1.25rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                <label
                  style={{
                    fontSize: '0.75rem',
                    color: 'rgba(246,247,248,0.4)',
                    fontFamily: 'Anton, Impact, sans-serif',
                    letterSpacing: '0.06em',
                  }}
                >
                  YOU RECEIVE
                </label>
                {usingSoroswap && quote && (
                  <span
                    style={{
                      fontSize: '0.6875rem',
                      background: 'rgba(212,175,55,0.1)',
                      border: '1px solid rgba(212,175,55,0.3)',
                      color: 'var(--gold)',
                      padding: '0.125rem 0.5rem',
                      borderRadius: '999px',
                    }}
                  >
                    via {quote.protocols.join(' · ')}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <select
                  style={{
                    background: 'var(--surface-md)',
                    border: 'none',
                    color: 'white',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    cursor: 'pointer',
                  }}
                  value={destAsset.code}
                  onChange={(e) =>
                    setDestAsset(
                      e.target.value === 'XLM'
                        ? { code: 'XLM', balance: '0' }
                        : { code: 'USDC', issuer: TESTNET_USDC.issuer, balance: '0' }
                    )
                  }
                >
                  <option value="USDC">USDC</option>
                  <option value="XLM">XLM</option>
                </select>
                <div
                  style={{
                    flex: 1,
                    textAlign: 'right',
                    fontSize: '1.5rem',
                    fontFamily: 'Inconsolata, monospace',
                  }}
                >
                  {isFetchingQuote ? '...' : destAmount || '0.00'}
                </div>
              </div>
            </div>

            {/* Quote details */}
            {usingSoroswap && quote && !errorMsg && (
              <div className="card" style={{ padding: '0.875rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                <Row
                  label="Price impact"
                  value={
                    quote.priceImpact < 0.005
                      ? '< 0.01%'
                      : `${(quote.priceImpact * 100).toFixed(2)}%`
                  }
                />
                <Row label="Route" value={quote.protocols.join(' · ')} />
                <Row label="Slippage" value={`${slippageBps / 100}%`} />
              </div>
            )}

            {!usingSoroswap && rate && !errorMsg && (
              <div style={{ textAlign: 'center', margin: '0.5rem 0' }}>
                <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)' }}>
                  1 {sourceAsset?.code} ≈ {rate} {destAsset.code}
                  {' '}· via SDEX (no Soroswap liquidity)
                </p>
              </div>
            )}

            {errorMsg && (
              <div
                className="card"
                style={{ background: 'rgba(255,0,0,0.05)', border: '1px solid rgba(255,0,0,0.1)' }}
              >
                <p style={{ fontSize: '0.8125rem', color: 'var(--teal)', textAlign: 'center' }}>
                  {errorMsg}
                </p>
              </div>
            )}

            <button
              className="btn-gold"
              onClick={() => setStep('confirm')}
              disabled={!sourceAmount || !destAmount || isFetchingQuote || !!errorMsg}
              style={{ marginTop: '1rem' }}
            >
              Review swap
            </button>
          </div>
        )}

        {step === 'confirm' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div className="card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <Row label="Pay" value={`${sourceAmount} ${sourceAsset?.code}`} />
                <Row label="Receive (est.)" value={`${destAmount} ${destAsset.code}`} />
                <Row
                  label="Min. Received"
                  value={`${(parseFloat(destAmount) * (1 - slippageTolerance)).toFixed(7)} ${
                    destAsset.code
                  }`}
                />
                <Row label="Slippage Tolerance" value={`${slippageBps / 100}%`} />
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
                <Row label="Network Fee" value="0.00001 XLM" />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
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
          <div className="card" style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '1rem' }}>
              <div className="spinner spinner-light" />
            </div>
            <p style={{ fontWeight: 500 }}>Waiting for passkey…</p>
            <p
              style={{
                fontSize: '0.8125rem',
                color: 'rgba(246,247,248,0.4)',
                marginTop: '0.5rem',
              }}
            >
              Approve with Face ID / fingerprint to continue
            </p>
          </div>
        )}

        {step === 'done' && (
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
                Swap successful
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
            <button className="btn-gold" onClick={() => router.push('/dashboard')}>
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
          <div
            className="card"
            style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', textAlign: 'center' }}
          >
            <div style={{ color: 'var(--teal)', fontSize: '2.5rem' }}>!</div>
            <div>
              <p style={{ fontWeight: 500 }}>Swap failed</p>
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
            <button className="btn-ghost" onClick={() => setStep('form')}>
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
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '1rem',
      }}
    >
      <span style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.4)', flexShrink: 0 }}>
        {label}
      </span>
      <span style={{ fontSize: '0.875rem', textAlign: 'right', wordBreak: 'break-all' }}>
        {value}
      </span>
    </div>
  )
}

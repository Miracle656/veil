import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Platform,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as SecureStore from 'expo-secure-store'
import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Operation,
  Asset,
  Horizon,
  Networks,
  rpc as SorobanRpc,
} from '@stellar/stellar-sdk'
import {
  SoroswapSDK,
  SupportedNetworks,
  SupportedProtocols,
  TradeType,
} from '@soroswap/sdk'
import Constants from 'expo-constants'

// ── Network config ─────────────────────────────────────────────────────────────

const HORIZON_URL = 'https://horizon-testnet.stellar.org'
const RPC_URL = 'https://soroban-testnet.stellar.org'
const NETWORK_PASSPHRASE = Networks.TESTNET
const SOROSWAP_API_KEY: string =
  (Constants.expoConfig?.extra as Record<string, string> | undefined)
    ?.soroswapApiKey ?? ''

// ── Constants ──────────────────────────────────────────────────────────────────

const DEBOUNCE_MS = 600
const TESTNET_USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'

const SLIPPAGE_OPTIONS = [
  { label: '0.1%', bps: 10 },
  { label: '0.5%', bps: 50 },
  { label: '1.0%', bps: 100 },
]

// ── Types ──────────────────────────────────────────────────────────────────────

type Step = 'form' | 'confirm' | 'signing' | 'submitting' | 'done' | 'error'

interface StellarAsset {
  code: string
  issuer?: string
  balance: string
}

interface SwapQuote {
  amountOut: string
  priceImpact: number
  protocols: string[]
  ttl: number
}

// ── Secure key storage ─────────────────────────────────────────────────────────
// The signing key is kept in the iOS Keychain / Android Keystore via
// expo-secure-store. requireAuthentication: true makes the OS gate retrieval
// behind device biometrics, so the biometric prompt is load-bearing: the
// signing key is physically inaccessible until the user approves.

async function getStoredSecret(): Promise<string> {
  const secret = await SecureStore.getItemAsync('veil_signer_secret', {
    requireAuthentication: true,
  })
  if (!secret) {
    throw new Error(
      'Signing key not found. Return to Dashboard and complete wallet setup first.',
    )
  }
  return secret
}

// ── Soroswap helpers ───────────────────────────────────────────────────────────

function getSoroswapClient(): SoroswapSDK | null {
  if (!SOROSWAP_API_KEY) return null
  return new SoroswapSDK({
    apiKey: SOROSWAP_API_KEY,
    defaultNetwork: SupportedNetworks.TESTNET,
  })
}

async function fetchSoroswapQuote(
  tokenIn: string,
  tokenOut: string,
  amountInStroops: string,
  slippageBps: number,
): Promise<SwapQuote | null> {
  try {
    const client = getSoroswapClient()
    if (!client) return null

    const result = await client.quote({
      assetIn: tokenIn,
      assetOut: tokenOut,
      amount: BigInt(amountInStroops),
      tradeType: TradeType.EXACT_IN,
      protocols: [
        SupportedProtocols.SOROSWAP,
        SupportedProtocols.PHOENIX,
        SupportedProtocols.AQUA,
        SupportedProtocols.SDEX,
      ],
      slippageBps,
    })

    if (!result?.amountOut) return null
    const routePlan = result.routePlan ?? []
    return {
      amountOut: result.amountOut.toString(),
      priceImpact: Number(result.priceImpactPct ?? '0'),
      protocols: [...new Set(routePlan.map((r: any) => r.swapInfo.protocol as string))],
      ttl: Date.now() + 30_000,
    }
  } catch {
    return null
  }
}

async function buildSoroswapXdr(
  tokenIn: string,
  tokenOut: string,
  amountInStroops: string,
  slippageBps: number,
  feePayerAddress: string,
): Promise<string | null> {
  try {
    const client = getSoroswapClient()
    if (!client) return null

    const quote = await client.quote({
      assetIn: tokenIn,
      assetOut: tokenOut,
      amount: BigInt(amountInStroops),
      tradeType: TradeType.EXACT_IN,
      protocols: [
        SupportedProtocols.SOROSWAP,
        SupportedProtocols.PHOENIX,
        SupportedProtocols.AQUA,
        SupportedProtocols.SDEX,
      ],
      slippageBps,
    })

    const built = await client.build({ quote, from: feePayerAddress, to: feePayerAddress })
    return built.xdr
  } catch {
    return null
  }
}

async function resolveTokenAddress(symbol: string): Promise<string | null> {
  try {
    const res = await fetch(
      'https://raw.githubusercontent.com/soroswap/token-list/main/tokenList.json',
    )
    const list = await res.json()
    const tokens: Array<{ symbol: string; contract: string; network: string }> =
      list.tokens ?? []
    const found = tokens.find(
      (t) => t.symbol.toUpperCase() === symbol.toUpperCase() && t.network === 'TESTNET',
    )
    return found?.contract ?? null
  } catch {
    return null
  }
}

// ── Transaction signing and submission ─────────────────────────────────────────
// Ported from frontend/wallet/lib/sorobanTx.ts

async function signAndSubmitSoroban(
  xdr: string,
  signerSecret: string,
): Promise<string> {
  const rpc = new SorobanRpc.Server(RPC_URL)
  const signer = Keypair.fromSecret(signerSecret)
  const built = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE)

  const sim = await rpc.simulateTransaction(built)
  if (SorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`)
  }

  const assembled = SorobanRpc.assembleTransaction(built, sim).build()
  assembled.sign(signer)

  const sendResult = await rpc.sendTransaction(assembled)
  if (sendResult.status === 'ERROR') {
    throw new Error(
      `Transaction rejected: ${sendResult.errorResult?.toXDR('base64') ?? 'unknown'}`,
    )
  }

  for (let i = 0; i < 30; i++) {
    const result = await rpc.getTransaction(sendResult.hash)
    if (result.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (result.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction failed: ${result.status}`)
      }
      return sendResult.hash
    }
    await new Promise<void>((r) => setTimeout(r, 1_000))
  }

  throw new Error('Transaction timed out — check status manually.')
}

// ── Swap screen ────────────────────────────────────────────────────────────────

export default function SwapScreen() {
  const router = useRouter()

  const [step, setStep] = useState<Step>('form')
  const [sourceBalances, setSourceBalances] = useState<StellarAsset[]>([])
  const [sourceAsset, setSourceAsset] = useState<StellarAsset | null>(null)
  const [destAsset, setDestAsset] = useState<StellarAsset>({
    code: 'USDC',
    issuer: TESTNET_USDC_ISSUER,
    balance: '0',
  })
  const [sourceAmount, setSourceAmount] = useState('')
  const [destAmount, setDestAmount] = useState('')
  const [quote, setQuote] = useState<SwapQuote | null>(null)
  const [usingSoroswap, setUsingSoroswap] = useState(false)
  const [isFetchingQuote, setIsFetchingQuote] = useState(false)
  const [sdexPath, setSdexPath] = useState<Asset[]>([])
  const [slippageBps, setSlippageBps] = useState(50)
  const [showSlippage, setShowSlippage] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const horizonServer = useRef(new Horizon.Server(HORIZON_URL))

  // ── Load balances ──────────────────────────────────────────────────────────

  const loadBalances = useCallback(async () => {
    try {
      // No requireAuthentication here — we only need the public key for a
      // read-only Horizon call, so we don't ask for biometrics on every mount.
      const secret = await SecureStore.getItemAsync('veil_signer_secret')
      if (!secret) return
      const pubKey = Keypair.fromSecret(secret).publicKey()
      const res = await fetch(`${HORIZON_URL}/accounts/${pubKey}`)
      if (!res.ok) return
      const data = await res.json()
      const assets: StellarAsset[] = (data.balances as any[]).map((b) => ({
        code: b.asset_code ?? 'XLM',
        issuer: b.asset_issuer,
        balance: b.balance,
      }))
      setSourceBalances(assets)
      setSourceAsset(assets.find((a) => a.code === 'XLM') ?? assets[0] ?? null)
    } catch {
      // Non-fatal
    }
  }, [])

  useEffect(() => { loadBalances() }, [loadBalances])

  // ── Quote fetching ─────────────────────────────────────────────────────────

  useEffect(() => {
    const amount = parseFloat(sourceAmount)
    if (!sourceAsset || !destAsset || !sourceAmount || isNaN(amount) || amount <= 0) {
      setDestAmount('')
      setQuote(null)
      setSdexPath([])
      return
    }

    if (debounceRef.current) clearTimeout(debounceRef.current)

    debounceRef.current = setTimeout(async () => {
      setIsFetchingQuote(true)
      setErrorMsg(null)
      setUsingSoroswap(false)

      try {
        const [tokenInAddress, tokenOutAddress] = await Promise.all([
          sourceAsset.code === 'XLM'
            ? Asset.native().contractId(NETWORK_PASSPHRASE)
            : resolveTokenAddress(sourceAsset.code),
          destAsset.code === 'XLM'
            ? Asset.native().contractId(NETWORK_PASSPHRASE)
            : resolveTokenAddress(destAsset.code),
        ])

        if (tokenInAddress && tokenOutAddress) {
          const amountInStroops = Math.round(amount * 1e7).toString()
          const q = await fetchSoroswapQuote(tokenInAddress, tokenOutAddress, amountInStroops, slippageBps)
          if (q) {
            setQuote(q)
            setUsingSoroswap(true)
            setDestAmount((Number(q.amountOut) / 1e7).toFixed(7))
            setIsFetchingQuote(false)
            return
          }
        }
      } catch {
        // Fall through to SDEX
      }

      try {
        const source =
          sourceAsset.code === 'XLM' || !sourceAsset.issuer
            ? Asset.native()
            : new Asset(sourceAsset.code, sourceAsset.issuer)
        const dest =
          destAsset.code === 'XLM' || !destAsset.issuer
            ? Asset.native()
            : new Asset(destAsset.code, destAsset.issuer)

        const pathsResult = await horizonServer.current
          .strictSendPaths(source, sourceAmount, [dest])
          .call()

        if (pathsResult.records.length > 0) {
          const best = pathsResult.records[0]
          setDestAmount(best.destination_amount)
          setSdexPath(
            best.path.map((p: any) =>
              p.asset_type === 'native' || !p.asset_code
                ? Asset.native()
                : new Asset(p.asset_code, p.asset_issuer),
            ),
          )
          setUsingSoroswap(false)
          setQuote(null)
        } else {
          setErrorMsg('No swap path found. Try a different amount or asset pair.')
          setDestAmount('')
        }
      } catch {
        setErrorMsg('Could not find a swap path. Check your connection and try again.')
      } finally {
        setIsFetchingQuote(false)
      }
    }, DEBOUNCE_MS)

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [sourceAmount, sourceAsset, destAsset, slippageBps])

  // ── Swap execution ─────────────────────────────────────────────────────────
  // Steps: signing (OS biometric gates SecureStore key retrieval) then
  // submitting (network broadcast). Kept separate so the UI communicates
  // exactly what the user is waiting on at each point.

  async function handleExecute() {
    setErrorMsg(null)

    // The 'signing' state is shown while SecureStore blocks on biometrics.
    // requireAuthentication: true means the secret is physically inaccessible
    // without the user's biometric approval — the gate is load-bearing.
    setStep('signing')

    let signerSecret: string
    try {
      signerSecret = await getStoredSecret()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      const cancelled =
        msg.includes('cancel') ||
        msg.includes('Cancel') ||
        msg.includes('UserCanceled') ||
        msg.includes('LAError')
      setErrorMsg(
        cancelled
          ? 'Authentication was cancelled. Tap "Try again" to retry.'
          : msg,
      )
      setStep('error')
      return
    }

    const signerKeypair = Keypair.fromSecret(signerSecret)
    const signerPubKey = signerKeypair.publicKey()

    setStep('submitting')
    try {
      if (usingSoroswap && quote) {
        const liveQuote =
          Date.now() > quote.ttl
            ? await (async () => {
                const tokenIn =
                  sourceAsset!.code === 'XLM'
                    ? Asset.native().contractId(NETWORK_PASSPHRASE)
                    : await resolveTokenAddress(sourceAsset!.code)
                const tokenOut =
                  destAsset.code === 'XLM'
                    ? Asset.native().contractId(NETWORK_PASSPHRASE)
                    : await resolveTokenAddress(destAsset.code)
                return tokenIn && tokenOut
                  ? fetchSoroswapQuote(
                      tokenIn,
                      tokenOut,
                      Math.round(parseFloat(sourceAmount) * 1e7).toString(),
                      slippageBps,
                    )
                  : null
              })()
            : quote

        if (!liveQuote) {
          throw new Error('Quote expired and could not be refreshed. Please retry.')
        }

        const tokenIn =
          sourceAsset!.code === 'XLM'
            ? Asset.native().contractId(NETWORK_PASSPHRASE)
            : await resolveTokenAddress(sourceAsset!.code)
        const tokenOut =
          destAsset.code === 'XLM'
            ? Asset.native().contractId(NETWORK_PASSPHRASE)
            : await resolveTokenAddress(destAsset.code)

        const xdr = await buildSoroswapXdr(
          tokenIn!,
          tokenOut!,
          Math.round(parseFloat(sourceAmount) * 1e7).toString(),
          slippageBps,
          signerPubKey,
        )

        if (!xdr) throw new Error('Failed to build Soroswap transaction.')

        const hash = await signAndSubmitSoroban(xdr, signerSecret)
        setTxHash(hash)
        setStep('done')
        return
      }

      // Classic SDEX path
      const account = await horizonServer.current.loadAccount(signerPubKey)
      const source =
        sourceAsset!.code === 'XLM' || !sourceAsset!.issuer
          ? Asset.native()
          : new Asset(sourceAsset!.code, sourceAsset!.issuer)
      const dest =
        destAsset.code === 'XLM' || !destAsset.issuer
          ? Asset.native()
          : new Asset(destAsset.code, destAsset.issuer)

      const destMin = (parseFloat(destAmount) * (1 - slippageBps / 10_000)).toFixed(7)
      const hasTrustline =
        dest.isNative() ||
        (account.balances as any[]).some(
          (b) => b.asset_code === dest.getCode() && b.asset_issuer === dest.getIssuer(),
        )

      const txBuilder = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
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
            path: sdexPath,
          }),
        )
        .setTimeout(30)

      const tx = txBuilder.build()
      tx.sign(signerKeypair)

      const result = await horizonServer.current.submitTransaction(tx)
      setTxHash(result.hash)
      setStep('done')
    } catch (err: unknown) {
      const horizonError = (err as any)?.response?.data
      const codes = horizonError?.extras?.result_codes
      const msg = codes
        ? [codes.transaction, ...(codes.operations ?? [])]
            .filter(Boolean)
            .join(' - ')
        : err instanceof Error
        ? err.message
        : String(err)
      setErrorMsg(msg)
      setStep('error')
    }
  }

  // ── Computed ───────────────────────────────────────────────────────────────

  const rate =
    sourceAmount && destAmount && parseFloat(sourceAmount) > 0
      ? (parseFloat(destAmount) / parseFloat(sourceAmount)).toFixed(6)
      : null

  const minReceived =
    destAmount
      ? (parseFloat(destAmount) * (1 - slippageBps / 10_000)).toFixed(7)
      : null

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <ScrollView style={s.shell} contentContainerStyle={s.content}>

      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn}>
          <Text style={s.backArrow}>{'<'}</Text>
        </TouchableOpacity>
        <Text style={s.headerTitle}>Swap</Text>
        <TouchableOpacity onPress={() => setShowSlippage((v) => !v)} style={s.slippageBtn}>
          <Text style={s.slippageBtnText}>Slippage: {slippageBps / 100}%</Text>
        </TouchableOpacity>
      </View>

      {/* Slippage picker */}
      {showSlippage && (
        <View style={s.card}>
          <Text style={s.label}>Slippage tolerance</Text>
          <View style={s.row}>
            {SLIPPAGE_OPTIONS.map((opt) => (
              <TouchableOpacity
                key={opt.bps}
                onPress={() => { setSlippageBps(opt.bps); setShowSlippage(false) }}
                style={[s.pill, slippageBps === opt.bps && s.pillActive]}
              >
                <Text style={[s.pillText, slippageBps === opt.bps && s.pillTextActive]}>
                  {opt.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* ── FORM ── */}
      {step === 'form' && (
        <>
          <View style={s.card}>
            <View style={s.rowBetween}>
              <Text style={s.label}>YOU PAY</Text>
              <Text style={s.dimText}>
                Bal: {sourceAsset?.balance ?? '0'} {sourceAsset?.code}
              </Text>
            </View>
            <View style={s.row}>
              <TouchableOpacity
                style={s.assetBadge}
                onPress={() => {
                  if (sourceBalances.length < 2) return
                  const idx = sourceBalances.findIndex((a) => a.code === sourceAsset?.code)
                  setSourceAsset(sourceBalances[(idx + 1) % sourceBalances.length])
                  setSourceAmount('')
                }}
              >
                <Text style={s.assetBadgeText}>{sourceAsset?.code ?? '-'}</Text>
              </TouchableOpacity>
              <TextInput
                style={s.amountInput}
                keyboardType="decimal-pad"
                placeholder="0.00"
                placeholderTextColor="rgba(246,247,248,0.25)"
                value={sourceAmount}
                onChangeText={setSourceAmount}
              />
            </View>
            <TouchableOpacity
              onPress={() => setSourceAmount(sourceAsset?.balance ?? '')}
              style={s.maxBtn}
            >
              <Text style={s.maxBtnText}>MAX</Text>
            </TouchableOpacity>
          </View>

          <View style={s.arrowWrap}>
            <View style={s.arrowCircle}>
              <Text style={s.arrowText}>v</Text>
            </View>
          </View>

          <View style={s.card}>
            <View style={s.rowBetween}>
              <Text style={s.label}>YOU RECEIVE</Text>
              {usingSoroswap && quote && (
                <View style={s.routeBadge}>
                  <Text style={s.routeBadgeText}>
                    via {quote.protocols.join(' / ')}
                  </Text>
                </View>
              )}
            </View>
            <View style={s.row}>
              <TouchableOpacity
                style={s.assetBadge}
                onPress={() =>
                  setDestAsset(
                    destAsset.code === 'XLM'
                      ? { code: 'USDC', issuer: TESTNET_USDC_ISSUER, balance: '0' }
                      : { code: 'XLM', balance: '0' },
                  )
                }
              >
                <Text style={s.assetBadgeText}>{destAsset.code}</Text>
              </TouchableOpacity>
              <View style={s.destAmountWrap}>
                {isFetchingQuote ? (
                  <ActivityIndicator color={GOLD} size="small" />
                ) : (
                  <Text style={s.destAmount}>{destAmount || '0.00'}</Text>
                )}
              </View>
            </View>
          </View>

          {!errorMsg && rate && (
            <View style={s.card}>
              <InfoRow label="Rate" value={`1 ${sourceAsset?.code} ~ ${rate} ${destAsset.code}`} />
              {usingSoroswap && quote && (
                <>
                  <InfoRow
                    label="Price impact"
                    value={quote.priceImpact < 0.00005 ? '< 0.01%' : `${(quote.priceImpact * 100).toFixed(2)}%`}
                  />
                  <InfoRow label="Route" value={quote.protocols.join(' / ')} />
                </>
              )}
              {!usingSoroswap && (
                <InfoRow label="Route" value="SDEX (no Soroswap liquidity)" />
              )}
              <InfoRow label="Slippage" value={`${slippageBps / 100}%`} />
            </View>
          )}

          {errorMsg && (
            <View style={s.errorCard}>
              <Text style={s.errorText}>{errorMsg}</Text>
            </View>
          )}

          <TouchableOpacity
            style={[s.btnGold, (!sourceAmount || !destAmount || isFetchingQuote || !!errorMsg) && s.btnDisabled]}
            onPress={() => setStep('confirm')}
            disabled={!sourceAmount || !destAmount || isFetchingQuote || !!errorMsg}
          >
            <Text style={s.btnGoldText}>Review swap</Text>
          </TouchableOpacity>
        </>
      )}

      {/* ── CONFIRM ── */}
      {step === 'confirm' && (
        <>
          <View style={s.card}>
            <InfoRow label="Pay" value={`${sourceAmount} ${sourceAsset?.code}`} />
            <InfoRow label="Receive (est.)" value={`${destAmount} ${destAsset.code}`} />
            {minReceived && (
              <InfoRow label="Min. received" value={`${minReceived} ${destAsset.code}`} />
            )}
            <InfoRow label="Slippage tolerance" value={`${slippageBps / 100}%`} />
            {usingSoroswap && quote && (
              <>
                <InfoRow
                  label="Price impact"
                  value={quote.priceImpact < 0.00005 ? '< 0.01%' : `${(quote.priceImpact * 100).toFixed(2)}%`}
                />
                <InfoRow label="Route" value={quote.protocols.join(' / ')} />
              </>
            )}
            <InfoRow label="Network fee" value="~0.00001 XLM" />
          </View>

          <TouchableOpacity style={s.btnGold} onPress={handleExecute}>
            <Text style={s.btnGoldText}>Confirm swap</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.btnGhost} onPress={() => setStep('form')}>
            <Text style={s.btnGhostText}>Edit</Text>
          </TouchableOpacity>
        </>
      )}

      {/* ── SIGNING ── */}
      {step === 'signing' && (
        <View style={s.centeredCard}>
          <ActivityIndicator color={GOLD} size="large" style={{ marginBottom: 20 }} />
          <Text style={s.statusTitle}>Awaiting biometrics</Text>
          <Text style={s.statusSub}>
            Approve with Face ID or fingerprint to authorize this swap
          </Text>
        </View>
      )}

      {/* ── SUBMITTING ── */}
      {step === 'submitting' && (
        <View style={s.centeredCard}>
          <ActivityIndicator color={GOLD} size="large" style={{ marginBottom: 20 }} />
          <Text style={s.statusTitle}>Broadcasting</Text>
          <Text style={s.statusSub}>Submitting your swap to Stellar Testnet</Text>
        </View>
      )}

      {/* ── DONE ── */}
      {step === 'done' && (
        <View style={s.centeredCard}>
          <Text style={s.successIcon}>OK</Text>
          <Text style={s.statusTitle}>Swap successful</Text>
          <Text style={s.statusSub}>
            {sourceAmount} {sourceAsset?.code} to {destAmount} {destAsset.code}
          </Text>
          {txHash && (
            <Text style={s.hashText}>
              {txHash.slice(0, 12)}...{txHash.slice(-8)}
            </Text>
          )}
          <TouchableOpacity
            style={[s.btnGold, { marginTop: 24 }]}
            onPress={() => router.back()}
          >
            <Text style={s.btnGoldText}>Done</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── ERROR ── */}
      {step === 'error' && (
        <View style={s.centeredCard}>
          <Text style={s.errorIcon}>!</Text>
          <Text style={s.statusTitle}>Swap failed</Text>
          <Text style={s.statusSub}>{errorMsg}</Text>
          <TouchableOpacity
            style={[s.btnGhost, { marginTop: 24 }]}
            onPress={() => { setStep('form'); setErrorMsg(null) }}
          >
            <Text style={s.btnGhostText}>Try again</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  )
}

// ── InfoRow helper ─────────────────────────────────────────────────────────────

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue}>{value}</Text>
    </View>
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────

const NEAR_BLACK = '#0B0B0F'
const SURFACE = '#16181D'
const BORDER = 'rgba(246,247,248,0.1)'
const OFF_WHITE = '#F6F7F8'
const WARM_GREY = '#9BA1A6'
const GOLD = '#D4AF37'
const TEAL = '#4EC9B0'

const s = StyleSheet.create({
  shell: { flex: 1, backgroundColor: NEAR_BLACK },
  content: { padding: 20, paddingBottom: 48 },

  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 24 },
  backBtn: { padding: 4, marginRight: 12 },
  backArrow: { color: OFF_WHITE, fontSize: 22 },
  headerTitle: { flex: 1, color: OFF_WHITE, fontSize: 20, fontWeight: '700' },
  slippageBtn: {
    borderWidth: 1, borderColor: BORDER, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  slippageBtnText: { color: WARM_GREY, fontSize: 13 },

  card: {
    backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1,
    borderColor: BORDER, padding: 16, marginBottom: 12,
  },
  centeredCard: {
    backgroundColor: SURFACE, borderRadius: 16, borderWidth: 1,
    borderColor: BORDER, padding: 32, alignItems: 'center', marginTop: 32,
  },
  errorCard: {
    backgroundColor: 'rgba(255,80,80,0.07)', borderRadius: 12, borderWidth: 1,
    borderColor: 'rgba(255,80,80,0.15)', padding: 14, marginBottom: 12,
  },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },

  label: { color: WARM_GREY, fontSize: 11, fontWeight: '700', letterSpacing: 0.8 },
  dimText: { color: 'rgba(246,247,248,0.35)', fontSize: 12 },

  assetBadge: {
    backgroundColor: 'rgba(212,175,55,0.1)', borderRadius: 10, borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.25)', paddingHorizontal: 12, paddingVertical: 6,
  },
  assetBadgeText: { color: GOLD, fontWeight: '600', fontSize: 15 },

  amountInput: {
    flex: 1, color: OFF_WHITE, fontSize: 28, fontWeight: '600',
    textAlign: 'right',
  },

  maxBtn: { alignSelf: 'flex-end', marginTop: 6 },
  maxBtnText: { color: GOLD, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },

  arrowWrap: { alignItems: 'center', marginVertical: -6, zIndex: 1 },
  arrowCircle: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: SURFACE, borderWidth: 2, borderColor: NEAR_BLACK,
    alignItems: 'center', justifyContent: 'center',
  },
  arrowText: { color: GOLD, fontSize: 18 },

  destAmountWrap: { flex: 1, alignItems: 'flex-end' },
  destAmount: { color: OFF_WHITE, fontSize: 28, fontWeight: '600' },

  routeBadge: {
    backgroundColor: 'rgba(212,175,55,0.08)', borderWidth: 1,
    borderColor: 'rgba(212,175,55,0.25)', borderRadius: 999,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  routeBadgeText: { color: GOLD, fontSize: 11 },

  pill: {
    flex: 1, paddingVertical: 8, borderRadius: 8,
    borderWidth: 1, borderColor: BORDER, alignItems: 'center',
  },
  pillActive: { borderColor: GOLD, backgroundColor: 'rgba(212,175,55,0.1)' },
  pillText: { color: WARM_GREY, fontSize: 13 },
  pillTextActive: { color: GOLD, fontWeight: '600' },

  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', paddingVertical: 5,
  },
  infoLabel: { color: WARM_GREY, fontSize: 13, flex: 1 },
  infoValue: { color: OFF_WHITE, fontSize: 13, textAlign: 'right', flex: 1 },

  statusTitle: { color: OFF_WHITE, fontSize: 18, fontWeight: '700', marginBottom: 8 },
  statusSub: { color: WARM_GREY, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  hashText: {
    color: 'rgba(246,247,248,0.3)', fontSize: 11, marginTop: 12,
    fontVariant: ['tabular-nums'],
  },
  successIcon: { color: TEAL, fontSize: 36, marginBottom: 16, fontWeight: '700' },
  errorIcon: {
    color: TEAL, fontSize: 32, marginBottom: 16, width: 56, height: 56,
    textAlign: 'center', textAlignVertical: 'center',
    borderRadius: 28, borderWidth: 2, borderColor: TEAL,
    lineHeight: 56,
  },
  errorText: { color: TEAL, fontSize: 13, textAlign: 'center' },

  btnGold: {
    backgroundColor: GOLD, borderRadius: 14, paddingVertical: 16,
    alignItems: 'center', marginTop: 8,
  },
  btnGoldText: { color: NEAR_BLACK, fontSize: 16, fontWeight: '700' },
  btnDisabled: { opacity: 0.4 },

  btnGhost: {
    borderRadius: 14, paddingVertical: 16, alignItems: 'center',
    marginTop: 8, borderWidth: 1, borderColor: BORDER,
  },
  btnGhostText: { color: OFF_WHITE, fontSize: 16, fontWeight: '500' },
})

'use client'
import { walletLocal, walletSession } from '@/lib/walletStorage'

export const dynamic = 'force-dynamic'

import { inclusionFee } from '@/lib/fees'
import { Suspense, useEffect, useRef, useCallback, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Horizon, Keypair, rpc as SorobanRpc, Contract, Account,
  TransactionBuilder, BASE_FEE, Networks, Asset, nativeToScVal, scValToNative,
} from '@stellar/stellar-sdk'
const Server = Horizon.Server
import { ConnectDAppModal } from '@/components/ConnectDAppModal'
import { WalletConnectApprovalModal } from '@/components/WalletConnectApprovalModal'
import { DepositModal } from '@/components/DepositModal'
import { TxDetailSheet, type TxRecord } from '@/components/TxDetailSheet'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { ensureFeePayer } from '@/lib/feePayer'
import { fetchPrices } from '@/lib/fetchPrice'
import { change24h, historyKey, isComparableTotal, readHistory, recordSnapshot, writeHistory } from '@/lib/balanceHistory'
import { buildFriendbotUrl, getNativeAssetContractId, getNetwork, getNetworkName } from '@/lib/network'
import { sweepContractBalance } from '@/lib/sweepContractBalance'
import { derToRawSignature, hexToUint8Array } from '@veil/utils'
import type { WebAuthnSignature } from '@veil/sdk'
import { getDueSchedules, updateSchedule, advanceNextRun, type PaymentSchedule } from '@/lib/schedules'
import { VeilMark } from '@/components/ui/VeilMark'
import { Amount, Label, Row, TokenIcon } from '@/components/ui/primitives'
import { formatFiat, hydrateCurrency, useCurrency } from '@/lib/currency'
import { useActivityFeed, initActivityFeed, hydrateActivityFeed, appendActivityFeed } from '@/lib/activityFeed'

const network = getNetwork()

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletAsset {
  code: string
  issuer: string | null
  balance: string
}

// ── Shared types ─────────────────────────────────────────────────────────────

type HorizonOp = {
  id: string; type: string
  from?: string; to?: string; funder?: string; account?: string
  amount?: string; starting_balance?: string
  asset_type?: string; asset_code?: string; asset_issuer?: string
  source_amount?: string
  source_asset_type?: string; source_asset_code?: string
  created_at: string; transaction_hash: string
  transaction?: { memo?: string }
}

type WraithTransfer = {
  id: number; eventType: string; fromAddress: string | null
  toAddress: string | null; amount: string; ledger: number
  ledgerClosedAt: string; txHash: string; contractId: string
}

type WraithPage = { transfers: WraithTransfer[], next_cursor?: string | null }

function mapHorizonOps(ops: HorizonOp[], signerPublicKey: string): import('@/components/TxDetailSheet').TxRecord[] {
  return ops
    .filter(p => p.type === 'payment' || p.type === 'create_account' || p.type === 'path_payment_strict_send')
    .map(p => {
      if (p.type === 'create_account') {
        return {
          id: p.id, type: 'received' as const,
          amount: p.starting_balance ?? '0', asset: 'XLM',
          counterparty: p.funder ?? 'Friendbot',
          timestamp: Math.floor(new Date(p.created_at).getTime() / 1000),
          hash: p.transaction_hash,
        }
      }
      if (p.type === 'path_payment_strict_send') {
        const srcAsset = p.source_asset_type === 'native' ? 'XLM' : (p.source_asset_code ?? 'XLM')
        const dstAsset = p.asset_type === 'native' ? 'XLM' : (p.asset_code ?? '')
        return {
          id: p.id, type: 'swapped' as const,
          amount: p.source_amount ?? '0', asset: srcAsset,
          destAmount: p.amount ?? '0', destAsset: dstAsset,
          counterparty: 'Stellar DEX',
          timestamp: Math.floor(new Date(p.created_at).getTime() / 1000),
          hash: p.transaction_hash,
        }
      }
      return {
        id: p.id,
        type: p.from === signerPublicKey ? 'sent' as const : 'received' as const,
        amount: p.amount ?? '0',
        asset: p.asset_type === 'native' ? 'XLM' : (p.asset_code ?? ''),
        counterparty: p.from === signerPublicKey ? (p.to ?? '') : (p.from ?? ''),
        timestamp: Math.floor(new Date(p.created_at).getTime() / 1000),
        hash: p.transaction_hash,
        memo: p.transaction?.memo,
      }
    })
}

// ── Module-level cache ────────────────────────────────────────────────────────
// Survives component unmount/remount within the SPA so navigating away and
// back doesn't flash the skeleton state. Cleared on hard refresh (intentional).
// Refetch still happens in the background to keep data fresh.
let cachedAssets:      WalletAsset[]                 | null = null
let cachedContractXlm: number                        | null = null
let cachedPrices:      Record<string, number | null>        = {}

// ── Dashboard page ────────────────────────────────────────────────────────────
function DashboardPageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  useInactivityLock()

  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [assets, setAssets]               = useState<WalletAsset[]>(() => cachedAssets ?? [])
  const transactions                      = useActivityFeed()
  const [selectedTx, setSelectedTx]       = useState<TxRecord | null>(null)
  const [txFilter, setTxFilter]           = useState<'all' | 'transfers' | 'swaps'>('all')
  const [loading, setLoading]             = useState(cachedAssets === null)
  const [prices, setPrices]               = useState<Record<string, number | null>>(() => cachedPrices)
  const [isFunding, setIsFunding]         = useState(false)
  const [fundingError, setFundingError]   = useState<string | null>(null)
  const [copied, setCopied]               = useState(false)
  const [hasFeePayerKey, setHasFeePayerKey] = useState(true)
  const [agentBadge, setAgentBadge]         = useState(false)
  const [contractXlm, setContractXlm]       = useState(() => cachedContractXlm ?? 0)
  const [isSweeping, setIsSweeping]         = useState(false)
  const [sweepError, setSweepError]         = useState<string | null>(null)
  const [sweepDismissed, setSweepDismissed] = useState(false)
  const [showConnectDapp, setShowConnectDapp] = useState(false)
  const [connectToast, setConnectToast] = useState<string | null>(null)
  const [sep24Modal, setSep24Modal] = useState<'deposit' | 'withdraw' | null>(null)
  const [wraithInCursor, setWraithInCursor]   = useState<string | null>(null)
  const [wraithOutCursor, setWraithOutCursor] = useState<string | null>(null)
  const [hasMorePages, setHasMorePages]       = useState(false)
  const [isLoadingMore, setIsLoadingMore]     = useState(false)

  // Shoulder-surfing guard. Persisted, but read after mount so the server and
  // client render the same first paint.
  const [hideAmounts, setHideAmounts] = useState(false)
  const hideLoaded = useRef(false)
  useEffect(() => {
    try { setHideAmounts(localStorage.getItem('veil_hide_amounts') === '1') } catch { /* blocked storage */ }
    hideLoaded.current = true
  }, [])
  useEffect(() => {
    if (!hideLoaded.current) return
    try { localStorage.setItem('veil_hide_amounts', hideAmounts ? '1' : '0') } catch { /* blocked storage */ }
  }, [hideAmounts])

  // Time-of-day greeting is resolved after mount: the server's clock and the
  // viewer's are not the same, and a mismatch breaks hydration.
  const [greeting, setGreeting] = useState('Welcome back')
  useEffect(() => {
    const h = new Date().getHours()
    setGreeting(h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening')
  }, [])

  const priceOf = useCallback(
    (a: { code: string; issuer?: string | null }) =>
      prices[a.issuer ? `${a.code}:${a.issuer}` : a.code] ?? null,
    [prices],
  )

  // Balances are priced in USD upstream; this renders them in whichever
  // currency the user picked (naira by default for the launch market).
  const { code: currencyCode, rate: fxRate } = useCurrency()
  useEffect(() => { hydrateCurrency() }, [])
  const usd = (n: number) => formatFiat(n, currencyCode, fxRate)

  const pricedAssets = assets.filter((a) => priceOf(a) != null)
  const totalUsd = pricedAssets.reduce(
    (sum, a) => sum + parseFloat(a.balance) * (priceOf(a) as number),
    0,
  )
  // Only show a total once at least one asset has a price. A partial sum
  // rendered as "the" balance understates the wallet without saying so.
  const totalLabel = pricedAssets.length > 0 ? usd(totalUsd) : '—'

  // 24h change on the total. Recorded locally rather than fetched: Lens serves
  // a spot price and nothing historical, so this is the change in what the
  // wallet is worth. Null — and so hidden — until a snapshot is a day old.
  const [dayChange, setDayChange] = useState<number | null>(null)
  useEffect(() => {
    // A partial total is not comparable with a full one, and recording it would
    // report a price-feed outage as a loss. Drop the chip entirely until every
    // asset is priced rather than showing a number nobody can act on.
    if (!walletAddress || !isComparableTotal(assets.length, pricedAssets.length)) {
      setDayChange(null)
      return
    }
    const key = historyKey(getNetworkName(), walletAddress)
    const now = Date.now()
    const history = recordSnapshot(readHistory(key), totalUsd, now)
    writeHistory(key, history)
    setDayChange(change24h(history, totalUsd, now))
  }, [walletAddress, totalUsd, assets.length, pricedAssets.length])

  const balanceLine = assets
    .slice()
    .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))
    .slice(0, 2)
    .map((a) => `${parseFloat(a.balance).toFixed(2)} ${a.code}`)
    .join(' · ')

  const recent = transactions.slice(0, 4)

  const horizonNextRef = useRef<(() => Promise<any>) | null>(null)

  useEffect(() => {
    const stored = walletSession.getItem('invisible_wallet_address')
    if (!stored) { router.replace('/lock'); return }
    setWalletAddress(stored)

    // Establish the fee-payer for this session (idempotent, fire-and-forget).
    // PRF wallets keep the seed in sessionStorage only — never copied to
    // localStorage — so the lock protects it at rest (ADR 0003, C3).
    void ensureFeePayer()
  }, [router])

  const fetchData = useCallback(async () => {
    if (!walletAddress) return   // keep loading=true until address is ready
    if (cachedAssets === null) setLoading(true)
    horizonNextRef.current = null
    setWraithInCursor(null)
    setWraithOutCursor(null)
    setHasMorePages(false)

    const horizonServer = new Server(network.horizonUrl)
    const rpcServer     = new SorobanRpc.Server(network.rpcUrl)

    // ── 1. Wallet contract (C...) XLM balance via native SAC ────────────────
    // This is the canonical on-chain balance — survives cache clears and
    // cross-device recovery because it reads directly from the ledger.
    let contractXlm = 0
    try {
      const sacAddress  = getNativeAssetContractId()
      const sacContract = new Contract(sacAddress)
      const dummyKp     = Keypair.random()
      const dummyAcct   = new Account(dummyKp.publicKey(), '0')
      const balanceTx   = new TransactionBuilder(dummyAcct, {
        fee: inclusionFee(), networkPassphrase: network.networkPassphrase,
      })
        .addOperation(sacContract.call('balance', nativeToScVal(walletAddress, { type: 'address' })))
        .setTimeout(30)
        .build()

      const sim = await rpcServer.simulateTransaction(balanceTx)
      if (!SorobanRpc.Api.isSimulationError(sim)) {
        const result = (sim as SorobanRpc.Api.SimulateTransactionSuccessResponse).result
        if (result) {
          const stroops = scValToNative(result.retval) as bigint
          contractXlm  = Number(stroops) / 10_000_000
        }
      }
    } catch { /* contract has no balance entry yet */ }

    cachedContractXlm = contractXlm
    setContractXlm(contractXlm)

    // ── 2. Fee-payer G... balance (holds the testnet faucet XLM) ────────────
    const signerSecret    = walletSession.getItem('veil_signer_secret')
    const signerPublicKey = signerSecret
      ? Keypair.fromSecret(signerSecret).publicKey()
      : (walletLocal.getItem('veil_signer_public_key') || null)

    // Track whether fee-payer exists so we can show a recovery banner
    setHasFeePayerKey(!!signerPublicKey)

    let feePayerXlm = 0
    let otherAssets: WalletAsset[] = []
    let txRecords: TxRecord[] = []

    if (signerPublicKey) {
      try {
        const account = await horizonServer.loadAccount(signerPublicKey)
        const native  = account.balances.find((b: any) => b.asset_type === 'native')
        feePayerXlm   = native ? parseFloat(native.balance) : 0

        // All non-XLM balances (e.g. USDC from swaps)
        otherAssets = (account.balances as any[])
          .filter(b => b.asset_type !== 'native' && parseFloat(b.balance) > 0)
          .map(b => ({ code: b.asset_code, issuer: b.asset_issuer, balance: b.balance }))

        // Transaction history (fee-payer account)
        const paymentsPage = await horizonServer
          .payments()
          .forAccount(signerPublicKey)
          .limit(20)
          .order('desc')
          .call()

        horizonNextRef.current = paymentsPage.records.length >= 20 ? paymentsPage.next : null
        txRecords = mapHorizonOps(paymentsPage.records as HorizonOp[], signerPublicKey)
      } catch { /* not yet funded */ }
    }

    // ── 3. Wraith: incoming SAC transfers to the wallet contract ────────────
    const wraithUrl = process.env.NEXT_PUBLIC_WRAITH_URL
    let localInCursor: string | null = null
    let localOutCursor: string | null = null
    if (wraithUrl) {
      try {
        // Incoming: to wallet C... address
        // Outgoing: from fee-payer G... address (sends go from fee-payer, not contract)
        const feePayerAddr = signerPublicKey || walletAddress
        const [inRes, outRes] = await Promise.all([
          fetch(`${wraithUrl}/transfers/incoming/${walletAddress}?limit=20`),
          fetch(`${wraithUrl}/transfers/outgoing/${feePayerAddr}?limit=20`),
        ])
        const inData  = inRes.ok  ? await inRes.json()  as WraithPage : { transfers: [] as WraithTransfer[], next_cursor: null }
        const outData = outRes.ok ? await outRes.json() as WraithPage : { transfers: [] as WraithTransfer[], next_cursor: null }
        localInCursor  = inData.next_cursor  ?? null
        localOutCursor = outData.next_cursor ?? null
        setWraithInCursor(localInCursor)
        setWraithOutCursor(localOutCursor)

        const wraithRecords: TxRecord[] = [
          ...inData.transfers.map(t => ({
            id:           `w-${t.id}`,
            type:         'received' as const,
            amount:       (Math.abs(Number(t.amount)) / 10_000_000).toFixed(7),
            asset:        'XLM',
            counterparty: t.fromAddress ?? 'unknown',
            timestamp:    Math.floor(new Date(t.ledgerClosedAt).getTime() / 1000),
            hash:         t.txHash,
          })),
          ...outData.transfers.map(t => ({
            id:           `w-${t.id}`,
            type:         'sent' as const,
            amount:       (Math.abs(Number(t.amount)) / 10_000_000).toFixed(7),
            asset:        'XLM',
            counterparty: t.toAddress ?? 'unknown',
            timestamp:    Math.floor(new Date(t.ledgerClosedAt).getTime() / 1000),
            hash:         t.txHash,
          })),
        ]

        // Merge Wraith records with Horizon records, deduplicate by hash, sort newest first
        const merged = [...wraithRecords, ...txRecords]
          .filter((tx, i, arr) => arr.findIndex(t => t.hash === tx.hash) === i)
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 30)
        txRecords = merged
      } catch { /* Wraith offline — fall back to Horizon only */ }
    }

    // ── 4. Check for new incoming transfers → agent notification badge ─────
    const lastVisit = parseInt(localStorage.getItem('veil_agent_last_visit') ?? '0', 10)
    const newIncoming = txRecords.filter(
      tx => tx.type === 'received' && tx.timestamp * 1000 > lastVisit,
    )
    if (newIncoming.length > 0) {
      const latest = newIncoming[0]
      localStorage.setItem('veil_agent_notification', JSON.stringify({
        amount: parseFloat(latest.amount).toFixed(2),
        asset: latest.asset,
        from: latest.counterparty,
        timestamp: latest.timestamp,
      }))
      setAgentBadge(true)
    } else {
      // Check if a stale notification exists
      setAgentBadge(!!localStorage.getItem('veil_agent_notification'))
    }

    // ── 5. Combine and display ───────────────────────────────────────────────
    const totalXlm = (contractXlm + feePayerXlm).toFixed(7)
    const finalAssets: WalletAsset[] = [
      { code: 'XLM', issuer: null, balance: totalXlm },
      ...otherAssets,
    ]
    cachedAssets = finalAssets
    setAssets(finalAssets)

    // Seed the live feed with history and start streaming from now.
    // hydrateActivityFeed notifies all subscribers (including useActivityFeed),
    // so no separate setTransactions call is needed.
    hydrateActivityFeed(txRecords)
    if (signerPublicKey) initActivityFeed(signerPublicKey)

    setHasMorePages(horizonNextRef.current !== null || localInCursor !== null || localOutCursor !== null)
    setLoading(false)
  }, [walletAddress])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    if (!connectToast) return
    const timer = setTimeout(() => setConnectToast(null), 2500)
    return () => clearTimeout(timer)
  }, [connectToast])

  // Re-fetch when user navigates back to this tab/page (e.g. after sending)
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') fetchData() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [fetchData])

  const handleLoadMore = useCallback(async () => {
    if (!walletAddress) return
    setIsLoadingMore(true)
    try {
      const signerSecret    = walletSession.getItem('veil_signer_secret')
      const signerPublicKey = signerSecret
        ? Keypair.fromSecret(signerSecret).publicKey()
        : (walletLocal.getItem('veil_signer_public_key') || '')

      const additionalRecords: import('@/components/TxDetailSheet').TxRecord[] = []

      if (horizonNextRef.current) {
        try {
          const page = await horizonNextRef.current()
          additionalRecords.push(...mapHorizonOps(page.records as HorizonOp[], signerPublicKey))
          horizonNextRef.current = page.records.length >= 20 ? page.next : null
        } catch { /* Horizon unavailable */ }
      }

      const wraithUrl = process.env.NEXT_PUBLIC_WRAITH_URL
      let newInCursor: string | null = null
      let newOutCursor: string | null = null

      if (wraithUrl && (wraithInCursor || wraithOutCursor)) {
        try {
          const feePayerAddr = signerPublicKey || walletAddress
          const fetches: Promise<Response>[] = []
          if (wraithInCursor)  fetches.push(fetch(`${wraithUrl}/transfers/incoming/${walletAddress}?limit=20&cursor=${wraithInCursor}`))
          if (wraithOutCursor) fetches.push(fetch(`${wraithUrl}/transfers/outgoing/${feePayerAddr}?limit=20&cursor=${wraithOutCursor}`))
          const responses = await Promise.all(fetches)
          let idx = 0

          if (wraithInCursor) {
            const res = responses[idx++]
            const data = res.ok ? await res.json() as WraithPage : { transfers: [] as WraithTransfer[], next_cursor: null }
            newInCursor = data.next_cursor ?? null
            additionalRecords.push(...data.transfers.map(t => ({
              id: `w-${t.id}`, type: 'received' as const,
              amount: (Math.abs(Number(t.amount)) / 10_000_000).toFixed(7), asset: 'XLM',
              counterparty: t.fromAddress ?? 'unknown',
              timestamp: Math.floor(new Date(t.ledgerClosedAt).getTime() / 1000),
              hash: t.txHash,
            })))
          }

          if (wraithOutCursor) {
            const res = responses[idx++]
            const data = res.ok ? await res.json() as WraithPage : { transfers: [] as WraithTransfer[], next_cursor: null }
            newOutCursor = data.next_cursor ?? null
            additionalRecords.push(...data.transfers.map(t => ({
              id: `w-${t.id}`, type: 'sent' as const,
              amount: (Math.abs(Number(t.amount)) / 10_000_000).toFixed(7), asset: 'XLM',
              counterparty: t.toAddress ?? 'unknown',
              timestamp: Math.floor(new Date(t.ledgerClosedAt).getTime() / 1000),
              hash: t.txHash,
            })))
          }
        } catch { /* Wraith unavailable — hide button, keep existing list */ }
      }

      setWraithInCursor(newInCursor)
      setWraithOutCursor(newOutCursor)
      setHasMorePages(horizonNextRef.current !== null || newInCursor !== null || newOutCursor !== null)
      if (additionalRecords.length > 0) appendActivityFeed(additionalRecords)
    } finally {
      setIsLoadingMore(false)
    }
  }, [walletAddress, wraithInCursor, wraithOutCursor])

  // Fetch live USDC prices from Lens after balances load.
  // Runs in the background — does not block balance rendering and does not
  // interact with the inactivity lock (no user-activity signals are emitted).
  useEffect(() => {
    if (assets.length === 0) return
    let cancelled = false
    fetchPrices(assets.map(a => ({ code: a.code, issuer: a.issuer }))).then(result => {
      if (!cancelled) {
        cachedPrices = result
        setPrices(result)
      }
    })
    return () => { cancelled = true }
  }, [assets])

  // ── Service worker registration + background polling ─────────────────────
  useEffect(() => {
    if (!walletAddress || typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    navigator.serviceWorker.register('/sw.js').then(reg => {
      const sw = reg.active ?? reg.installing ?? reg.waiting
      sw?.postMessage({ type: 'VEIL_REGISTER_ACCOUNT', account: walletAddress, cursor: 'now' })
    }).catch(() => { /* SW registration failed — non-fatal */ })
  }, [walletAddress])

  // ── Notification permission — ask once after first successful data load ───
  useEffect(() => {
    if (loading || transactions.length === 0) return
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'default') return
    if (localStorage.getItem('veil_notif_asked')) return
    localStorage.setItem('veil_notif_asked', '1')
    Notification.requestPermission().catch(() => { /* denied — graceful degradation */ })
  }, [loading, transactions])

  // ── Deep-link: ?tx=<hash> from notification tap ───────────────────────────
  useEffect(() => {
    const hash = searchParams?.get('tx')
    if (!hash || transactions.length === 0) return
    const tx = transactions.find(t => t.hash === hash)
    if (tx) setSelectedTx(tx)
  }, [searchParams, transactions])

  const xlmBalance = assets.find(a => a.code === 'XLM')?.balance ?? null

  const handleFund = async () => {
    setIsFunding(true)
    setFundingError(null)
    try {
      // Friendbot only funds classic G... accounts, not C... contract addresses.
      // ensureFeePayer re-establishes the fee-payer (PRF-derived when supported,
      // legacy fallback otherwise) without persisting the seed to localStorage.
      const feePayer = await ensureFeePayer()
      if (!feePayer) throw new Error('No passkey found. Please register again.')
      const signerPublicKey = feePayer.publicKey()

      const friendbotUrl = buildFriendbotUrl(signerPublicKey)
      if (!friendbotUrl) {
        await fetchData()
        setFundingError(
          `Fee-payer restored. Fund ${signerPublicKey} with XLM from an external wallet to send or swap on mainnet.`
        )
        return
      }

      const res = await fetch(friendbotUrl)
      if (!res.ok) {
        // 400 means the account is already funded — just refresh balances
        if (res.status === 400) {
          await fetchData()
          return
        }
        throw new Error('Friendbot failed')
      }
      await new Promise(r => setTimeout(r, 2000))
      await fetchData()
    } catch (err: unknown) {
      setFundingError(err instanceof Error ? err.message : 'Funding failed. Please try again.')
    } finally {
      setIsFunding(false)
    }
  }

  // ── Sweep C... SAC balance to fee-payer ─────────────────────────────────────
  // Mirrors the signAuthEntry logic from useInvisibleWallet but without React
  // state management so it can be used in a plain async handler.
  const handleSweep = async () => {
    setIsSweeping(true)
    setSweepError(null)
    try {
      const signerSecret = walletSession.getItem('veil_signer_secret')
        || walletLocal.getItem('veil_signer_secret')
      if (!signerSecret) throw new Error('Signing key not found. Return to dashboard and tap "Set up fee-payer".')
      const feePayerKp = Keypair.fromSecret(signerSecret)

      const localSignAuthEntry = async (payload: Uint8Array): Promise<WebAuthnSignature | null> => {
        const keyId        = walletLocal.getItem('invisible_wallet_key_id')
        const publicKeyHex = walletLocal.getItem('invisible_wallet_public_key')
        if (!keyId || !publicKeyHex) throw new Error('No passkey found. Please register the wallet first.')

        const challenge  = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer
        const normalized = keyId.replace(/-/g, '+').replace(/_/g, '/')
        const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
        const credIdBin  = atob(padded)
        const credId     = Uint8Array.from(credIdBin, c => c.charCodeAt(0))

        const assertion = await navigator.credentials.get({
          publicKey: {
            challenge,
            allowCredentials: [{ id: credId, type: 'public-key' }],
            userVerification: 'required',
          },
        }) as PublicKeyCredential | null

        if (!assertion) return null

        const response   = assertion.response as AuthenticatorAssertionResponse
        const rawSig     = derToRawSignature(response.signature)
        const publicKeyBytes = hexToUint8Array(publicKeyHex)

        return {
          publicKey:      publicKeyBytes,
          authData:       new Uint8Array(response.authenticatorData),
          clientDataJSON: new Uint8Array(response.clientDataJSON),
          signature:      rawSig,
        }
      }

      await sweepContractBalance(
        walletAddress!,
        feePayerKp,
        localSignAuthEntry,
        network.rpcUrl,
        network.networkPassphrase,
      )
      setSweepDismissed(false)
      await fetchData()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setSweepError(
        msg.includes('NotAllowedError') || msg.includes('cancelled')
          ? 'Passkey verification was cancelled. Please try again.'
          : msg
      )
    } finally {
      setIsSweeping(false)
    }
  }

  return (
    <div className="wallet-shell">

      {/* Header */}
      <header className="wallet-nav">
        <span style={{
          fontFamily: 'Anton, Impact, sans-serif',
          fontSize: '1.25rem', letterSpacing: '0.08em',
          color: 'var(--gold)', userSelect: 'none',
        }}>
          VEIL
        </span>
        {walletAddress && (
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(walletAddress)
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }}
            className='settings-button'
            style={{ color: "var(--color-muted)"}}
            title="Copy wallet address"
          >
            <span className="address-chip">
              {walletAddress.slice(0, 6)}…{walletAddress.slice(-6)}
            </span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: copied ? 'var(--teal)' : 'rgba(246,247,248,0.35)', flexShrink: 0 }}>
              {copied
                ? <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                : <><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.75"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" strokeWidth="1.75"/></>
              }
            </svg>
          </button>
        )}
        <button
          aria-label='Settings'
          onClick={() => router.push('/settings')}
          className='settings-button'
          style={{ color: "var(--color-muted)"}}
          title="Settings"
        >
          
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.75"/>
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </header>

      <main className="wallet-main wallet-main--wide" style={{ paddingTop: '3rem', paddingBottom: '3rem' }}>


        {/* ── Header row: greeting, hide-amounts, add money, send ── */}
        <div className="vw-head">
          <div>
            <div className="vw-eyebrow">{greeting}</div>
            <div className="vw-title">Your wallet</div>
          </div>
          <div className="vw-actions">
            <button className="vw-pill" onClick={() => setHideAmounts(v => !v)}>
              {hideAmounts ? 'Show amounts' : 'Hide amounts'}
            </button>
            <button className="vw-pill" onClick={() => setSep24Modal('deposit')}>Add money</button>
          </div>
        </div>

        {/* ── Primary action cards (Send / Receive / Swap / Buy) ─────────── */}
        <div className="vw-actions-grid">
          <button className="vw-action-card" onClick={() => router.push('/send')}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>
              <path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>Send</span>
          </button>
          <button className="vw-action-card" onClick={() => router.push('/receive')}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>
              <path d="M19 12H5M12 19l-7-7 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>Receive</span>
          </button>
          <button className="vw-action-card" onClick={() => router.push('/swap')}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>
              <path d="M7 16l-4-4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M17 8l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M3 12h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            </svg>
            <span>Swap</span>
          </button>
          <button className="vw-action-card" onClick={() => router.push('/buy')}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>
              <path d="M12 1v22M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <span>Buy</span>
          </button>
        </div>

        {/* ── Secondary actions — horizontally scrollable chip row ────────── */}
        <div className="vw-more vw-more--scroll">
          <button className="vw-chip" onClick={() => router.push('/assets')}>Assets</button>
          <button className="vw-chip" onClick={() => setSep24Modal('withdraw')}>Withdraw</button>
          <button className="vw-chip" onClick={() => router.push('/vault')}>Vault</button>
          <button className="vw-chip" onClick={() => router.push('/pools')}>Pools</button>
          <button className="vw-chip" onClick={() => router.push('/multisig')}>Multisig</button>
          <button className="vw-chip" onClick={() => setShowConnectDapp(true)}>Connect dApp</button>
        </div>

        {/* ── Fee-payer missing banner (after cache clear) ── */}
        {!loading && !hasFeePayerKey && (
          <div style={{
            marginBottom: '1.5rem',
            padding: '1rem 1.25rem',
            background: 'rgba(253,218,36,0.07)',
            border: '1px solid rgba(253,218,36,0.25)',
            borderRadius: '12px',
          }}>
            <p style={{ fontSize: '0.875rem', color: 'var(--off-white)', marginBottom: '0.5rem', fontWeight: 500 }}>
              Signing key not found
            </p>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)', marginBottom: '0.875rem', lineHeight: 1.5 }}>
              Your browser storage was cleared. Tap below to set up a new fee-payer account so you can send, swap, and use the agent.
            </p>
            <button
              className="btn-gold"
              onClick={handleFund}
              disabled={isFunding}
              style={{ fontSize: '0.875rem', padding: '0.625rem 1.25rem', color:'var(--color-muted)', }}
            >
              {isFunding
                ? <div className="spinner" style={{ width: '14px', height: '14px' }} />
                : 'Set up fee-payer'}
            </button>
            {fundingError && (
              <p style={{ color: 'var(--teal)', fontSize: '0.75rem', marginTop: '0.625rem' }}>{fundingError}</p>
            )}
          </div>
        )}

        {/* ── Sweep prompt: contract SAC balance detected ── */}
        {!loading && contractXlm > 0 && !sweepDismissed && (
          <div style={{
            marginBottom: '1.5rem',
            padding: '1rem 1.25rem',
            background: 'rgba(253,218,36,0.07)',
            border: '1px solid rgba(253,218,36,0.25)',
            borderRadius: '12px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <p style={{ fontSize: '0.875rem', color: 'var(--off-white)', fontWeight: 500, marginBottom: '0.375rem' }}>
                Funds in contract wallet
              </p>
              <button
                onClick={() => setSweepDismissed(true)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-muted)', fontSize: '1rem', lineHeight: 1, padding: '0 0 0 0.5rem' }}
                title="Dismiss"
              >
                ×
              </button>
            </div>
            <p style={{ fontSize: '0.8125rem', color: 'rgba(246,247,248,0.55)', marginBottom: '0.875rem', lineHeight: 1.5 }}>
              {contractXlm.toFixed(7)} XLM arrived at your contract address (C…) and can&apos;t be spent directly. Move it to your spending wallet to use it.
            </p>
            {sweepError && (
              <p style={{ color: 'var(--teal)', fontSize: '0.75rem', marginBottom: '0.625rem' }}>{sweepError}</p>
            )}
            <button
              className="btn-gold"
              onClick={handleSweep}
              disabled={isSweeping}
              style={{ fontSize: '0.875rem', padding: '0.625rem 1.25rem' }}
            >
              {isSweeping
                ? <div className="spinner" style={{ width: '14px', height: '14px' }} />
                : 'Move to spending wallet'}
            </button>
          </div>
        )}


        {/* ── Three-column layout: center + right rail ── */}
        <div className="vw-center-col">
          {/* ── Balance plate + earning (center top) ── */}
          <div className="vw-balance-row">
            <div className="vw-silver">
              <div className="vw-silver__sheen" />
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div className="vw-silver__label">Total balance</div>
                <VeilMark size={28} color="#0F0F0F" />
              </div>
              <div className="vw-silver__amountrow">
                <div className="vw-silver__amount">{hideAmounts ? '••••' : totalLabel}</div>
                {!hideAmounts && dayChange !== null && (
                  <span className={'vw-silver__delta ' + (dayChange >= 0 ? 'vw-silver__delta--up' : 'vw-silver__delta--down')}>
                    {dayChange >= 0 ? '▲' : '▼'} {Math.abs(dayChange).toFixed(2)}% · 24h
                  </span>
                )}
              </div>
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '24px', gap: '12px' }}>
                <div className="vw-silver__sub">{hideAmounts ? '••••' : (balanceLine || 'No assets yet')}</div>
              </div>
            </div>

            <div className="vw-panel" style={{ flex: 1, minWidth: 0, padding: '26px 28px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '12px' }}>
                <div className="vw-label">Earning</div>
                <div className="vw-meta">Blend USDC pool</div>
              </div>
              <p style={{ fontSize: '14px', color: 'rgba(246,247,248,0.6)', lineHeight: 1.7, marginTop: '16px' }}>
                Idle USDC can earn in the Blend pool. Nothing is deposited automatically —
                you approve every move with your passkey.
              </p>
              <div style={{ flex: 1 }} />
              <button className="vw-pill" style={{ alignSelf: 'flex-start', marginTop: '18px' }} onClick={() => router.push('/earn')}>
                Open earn
              </button>
            </div>
          </div>

          {/* ── Activity feed (center middle) ── */}
          <div className="vw-panel" style={{ padding: '8px 26px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '20px 0 4px' }}>
              <div className="vw-label">Activity</div>
              <button className="vw-meta" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => router.push('/activity')}>See all</button>
            </div>
            {recent.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '14px 0' }}>
                {loading ? 'Loading…' : 'Nothing yet.'}
              </p>
            ) : recent.map((tx) => (
              <Row key={tx.id} className="vw-listrow" onClick={() => setSelectedTx(tx)}>
                <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                  <span style={{ fontSize: '14px', fontWeight: 500 }}>
                    {tx.type === 'sent' ? 'Sent' : tx.type === 'swapped' ? 'Swapped' : 'Received'}
                  </span>
                  <span className="vw-meta">
                    {tx.counterparty.length > 12
                      ? tx.counterparty.slice(0, 6) + '…' + tx.counterparty.slice(-6)
                      : tx.counterparty}
                  </span>
                </span>
                <Amount className={`text-sm font-semibold shrink-0 ${tx.type === 'received' ? 'text-teal' : 'text-off-white'}`}>
                  {hideAmounts
                    ? '••••'
                    : (tx.type === 'sent' ? '-' : tx.type === 'received' ? '+' : '') + tx.amount + ' ' + tx.asset}
                </Amount>
              </Row>
            ))}
          </div>

          {/* ── Agent card (center bottom) ── */}
          <div className="vw-agent">
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'rgba(183,172,232,0.16)', border: '1px solid rgba(183,172,232,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', color: '#B7ACE8', flexShrink: 0 }}>✦</div>
              <div className="vw-label vw-label--lilac">Agent</div>
            </div>
            <div style={{ fontFamily: 'Lora, Georgia, serif', fontStyle: 'italic', fontWeight: 600, fontSize: '19px', lineHeight: 1.4 }}>
              &ldquo;Swap 10 XLM to USDC and send it to Ada.&rdquo;
            </div>
            <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.55)', lineHeight: 1.6 }}>
              It builds the transactions. You sign each one with your passkey.
            </p>
            <button
              onClick={() => router.push('/agent')}
              style={{ border: '1px solid rgba(183,172,232,0.35)', color: '#B7ACE8', background: 'none', borderRadius: '100px', padding: '10px 20px', fontSize: '13px', fontWeight: 600, cursor: 'pointer', marginTop: '4px' }}
            >
              Open agent
            </button>
          </div>
        </div>

        {/* ── Right rail: assets with live fiat values ── */}
        <div className="vw-rail">
          <div className="vw-panel" style={{ padding: '8px 28px 18px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '20px 0 6px' }}>
              <Label className="vw-label">Assets</Label>
              <button className="vw-meta" style={{ background: 'none', border: 0, cursor: 'pointer' }} onClick={() => router.push('/assets')}>Manage</button>
            </div>
            {loading && assets.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '16px 0' }}>Loading…</p>
            ) : assets.length === 0 ? (
              <p style={{ fontSize: '13px', color: 'rgba(246,247,248,0.4)', padding: '16px 0' }}>
                No assets yet. Fund this address to get started.
              </p>
            ) : assets.map((asset) => {
              const price = priceOf(asset)
              const value = price != null ? parseFloat(asset.balance) * price : null
              return (
                <Row
                  key={asset.code + '-' + (asset.issuer ?? 'native')}
                  className="vw-listrow"
                  onClick={() => router.push(asset.issuer ? '/token/' + asset.code + '?issuer=' + asset.issuer : '/token/' + asset.code)}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '14px', minWidth: 0 }}>
                    <TokenIcon code={asset.code} size={38} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 }}>
                      <span style={{ fontSize: '15px', fontWeight: 600 }}>{asset.code}</span>
                      <span className="vw-meta">
                        {hideAmounts ? '••••' : parseFloat(asset.balance).toFixed(4) + ' ' + asset.code}
                      </span>
                    </span>
                  </span>
                  <Amount className="text-[15px] font-semibold shrink-0">
                    {hideAmounts ? '••••' : (value != null ? usd(value) : '—')}
                  </Amount>
                </Row>
              )
            })}
          </div>
        </div>


      </main>

      {selectedTx && (
        <TxDetailSheet tx={selectedTx} onClose={() => setSelectedTx(null)} />
      )}

      <ConnectDAppModal
        isOpen={showConnectDapp}
        onClose={() => setShowConnectDapp(false)}
        onConnected={(name) => {
          setShowConnectDapp(false)
          setConnectToast(`Connected to ${name}`)
        }}
      />

      {connectToast && (
        <div
          style={{
            position: 'fixed',
            left: '50%',
            bottom: '1.25rem',
            transform: 'translateX(-50%)',
            zIndex: 70,
            background: 'rgba(32, 34, 38, 0.95)',
            border: '1px solid rgba(253,218,36,0.25)',
            borderRadius: '999px',
            padding: '0.625rem 0.95rem',
            color: 'var(--off-white)',
            fontSize: '0.8125rem',
          }}
        >
          {connectToast}
        </div>
      )}

      <WalletConnectApprovalModal />

      {sep24Modal && walletAddress && (
        <DepositModal
          mode={sep24Modal}
          walletAddress={walletAddress}
          onClose={() => setSep24Modal(null)}
        />
      )}
    </div>
  )
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<div className="wallet-shell"><main className="wallet-main" /></div>}>
      <DashboardPageContent />
    </Suspense>
  )
}

function ActionButton({ label, onClick, icon, badge }: { label: string; onClick: () => void; icon: React.ReactNode; badge?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="card action-btn"
    >
      {badge && (
        <span style={{
          position: 'absolute', top: '8px', right: '8px',
          width: '10px', height: '10px', borderRadius: '50%',
          background: 'var(--gold)',
          border: '2px solid var(--near-black)',
          animation: 'badgePulse 2s ease-in-out infinite',
        }} />
      )}
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ color: 'var(--gold)' }}>
        {icon}
      </svg>
      <span>{label}</span>
    </button>
  )
}

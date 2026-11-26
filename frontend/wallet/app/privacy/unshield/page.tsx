'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { Horizon, StrKey } from '@stellar/stellar-sdk'
import { Nav, Label, Amount as AmountDisplay, TokenIcon } from '@/components/ui/primitives'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { walletLocal, walletSession } from '@/lib/walletStorage'
import { getNetwork } from '@/lib/network'
import { isPrivacyEnabled } from '@/lib/privacy/config'
import { withdrawableAssetCodes, xlmToStroops, stroopsToXlm } from './amounts'
import {
  attachPrivacyProgress,
  getPrivacyClient,
  toUserFacingPrivacyError,
  type PrivacyClient,
} from '@/lib/privacy/client'
import { explorerNetworkSegment } from '@/lib/about'

type Step = 'amount' | 'review' | 'proving' | 'complete' | 'error'

export default function UnshieldPage() {
  const router = useRouter()
  useInactivityLock()

  const [step, setStep] = useState<Step>('amount')
  const [amount, setAmount] = useState('')
  // null means "we could not read it", which is not the same as zero — a zero
  // shown for an unreadable balance invites someone to try to withdraw nothing.
  const [privateBalanceStroops, setPrivateBalanceStroops] = useState<bigint | null>(null)
  const [publicBalance, setPublicBalance] = useState('0.0000000')

  // Destination account state
  const [ownSpendingAddress, setOwnSpendingAddress] = useState('')
  const [destinationAddress, setDestinationAddress] = useState('')
  const [isCustomRecipient, setIsCustomRecipient] = useState(false)

  // Transaction & Proving state
  const [provingStatus, setProvingStatus] = useState('Generating proof...')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [sentAmount, setSentAmount] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isLoadingBalances, setIsLoadingBalances] = useState(true)

  const network = getNetwork()
  const assetCodes = withdrawableAssetCodes(network.name)
  const assetCode = assetCodes[0] ?? 'XLM'

  // Progress comes from the SPP client as it works, rather than being narrated
  // on a timer. If it says nothing, the screen says the generic line.
  useEffect(
    () => attachPrivacyProgress((event) => setProvingStatus(event.message)),
    [],
  )

  // Load account addresses and initial balances
  useEffect(() => {
    if (!isPrivacyEnabled(network.name)) {
      setErrorMessage('Privacy features are currently available on Stellar Testnet only.')
      setStep('error')
      return
    }

    const walletAddr = walletSession.getItem('invisible_wallet_address') || walletLocal.getItem('invisible_wallet_address')
    const signerPub = walletSession.getItem('veil_signer_secret')
      ? undefined
      : walletLocal.getItem('veil_signer_public_key') || walletSession.getItem('veil_signer_public_key')

    const defaultDest = signerPub || walletAddr || ''
    setOwnSpendingAddress(defaultDest)
    setDestinationAddress(defaultDest)

    async function loadBalances() {
      setIsLoadingBalances(true)
      try {
        const client = await getPrivacyClient()
        setPrivateBalanceStroops(await client.privateBalance())

        // Load public balance if address exists
        if (defaultDest && StrKey.isValidEd25519PublicKey(defaultDest)) {
          const server = new Horizon.Server(network.horizonUrl)
          const account = await server.loadAccount(defaultDest)
          const assetBal = account.balances.find((b) => b.asset_type === 'native')
          setPublicBalance(assetBal ? assetBal.balance : '0.0000000')
        }
      } catch (err) {
        // The shielded balance stays null, which renders as "Unavailable" and
        // blocks the flow, rather than as a zero the user might act on.
        setErrorMessage(toUserFacingPrivacyError(err))
      } finally {
        setIsLoadingBalances(false)
      }
    }

    void loadBalances()
  }, [network])

  const amountStroops = xlmToStroops(amount)
  const isAmountExceeding =
    amountStroops !== null && privateBalanceStroops !== null && amountStroops > privateBalanceStroops
  const isAmountValid =
    amountStroops !== null && amountStroops > 0n && privateBalanceStroops !== null && !isAmountExceeding
  // A withdrawal leaves the pool for a real account. "At least five characters"
  // would send one to a typo, and there is nothing to undo it with.
  const isDestinationValid = StrKey.isValidEd25519PublicKey(destinationAddress.trim())

  const canProceedToReview = isAmountValid && isDestinationValid && !isLoadingBalances

  const handleSetPercent = (percent: number) => {
    if (privateBalanceStroops === null || privateBalanceStroops <= 0n) return
    setAmount(stroopsToXlm((privateBalanceStroops * BigInt(percent)) / 100n))
  }

  const handleStartUnshield = async () => {
    // Strict pre-proof validation check
    if (!isAmountValid || !isDestinationValid || amountStroops === null) return

    setStep('proving')
    setProvingStatus('Initializing zero-knowledge prover...')
    setErrorMessage(null)

    try {
      const client: PrivacyClient = await getPrivacyClient()
      const hash = await client.unshield(amountStroops, destinationAddress.trim())

      setTxHash(hash)
      setSentAmount(stroopsToXlm(amountStroops))

      // Re-read both balances rather than doing arithmetic on them: the pool
      // decides what actually moved, and a locally computed figure beside a
      // real transaction hash is a number nobody can reconcile.
      setPrivateBalanceStroops(await client.privateBalance())
      if (StrKey.isValidEd25519PublicKey(destinationAddress.trim())) {
        try {
          const server = new Horizon.Server(network.horizonUrl)
          const account = await server.loadAccount(destinationAddress.trim())
          const assetBal = account.balances.find((b) => b.asset_type === 'native')
          if (assetBal) setPublicBalance(assetBal.balance)
        } catch {
          // The withdrawal succeeded; only the follow-up read did not. Leave the
          // previous figure rather than inventing one.
        }
      }

      setStep('complete')
    } catch (err) {
      setErrorMessage(toUserFacingPrivacyError(err))
      setStep('error')
    }
  }

  return (
    <div className="min-h-screen bg-[var(--near-black)] text-[var(--off-white)] flex flex-col pb-12">
      <Nav
        title="Unshield Funds"
        onBack={() => {
          if (step === 'review') {
            setStep('amount')
          } else if (step === 'error') {
            setStep('amount')
          } else {
            router.push('/dashboard')
          }
        }}
      />

      <main className="flex-1 max-w-md w-full mx-auto px-4 pt-4 flex flex-col">
        {/* ── STEP 1: AMOUNT & RECIPIENT ─────────────────────────────────────── */}
        {step === 'amount' && (
          <div className="flex flex-col gap-5">
            {/* Balance Overview Card */}
            <div className="rounded-2xl bg-[var(--surface-md)] border border-[var(--border-dim)] p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs uppercase font-anton tracking-wider text-[rgba(246,247,248,0.5)]">
                  Available in Shielded Pool
                </span>
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-[rgba(0,167,181,0.15)] text-[var(--teal)] border border-[rgba(0,167,181,0.3)]">
                  ZK Private
                </span>
              </div>

              <div className="flex items-baseline gap-2">
                <AmountDisplay className="text-3xl font-bold text-[var(--gold)]">
                  {isLoadingBalances
                    ? '...'
                    : privateBalanceStroops === null
                      ? 'Unavailable'
                      : stroopsToXlm(privateBalanceStroops)}
                </AmountDisplay>
                <span className="text-sm font-semibold text-[rgba(246,247,248,0.6)]">
                  {assetCode}
                </span>
              </div>

              <div className="pt-2 border-t border-[rgba(255,255,255,0.06)] flex justify-between text-xs text-[rgba(246,247,248,0.5)]">
                <span>Public Spending Balance:</span>
                <span className="font-mono text-[var(--off-white)]">
                  {publicBalance} {assetCode}
                </span>
              </div>
            </div>

            {/* Asset Selection */}
            <div className="flex flex-col gap-1.5">
              <Label>Select Asset</Label>
              <div className="grid grid-cols-3 gap-2">
                {assetCodes.map((code) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setAmount('')}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border text-left transition-all ${
                      code === assetCode
                        ? 'border-[var(--gold)] bg-[rgba(253,218,36,0.08)]'
                        : 'border-[var(--border-dim)] bg-[var(--surface)] hover:bg-[var(--surface-md)]'
                    }`}
                  >
                    <TokenIcon code={code} size={22} />
                    <span className="font-bold text-sm">{code}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Amount Input & Presets */}
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center">
                <Label>Withdraw Amount</Label>
                {isAmountExceeding && (
                  <span className="text-xs text-red-400 font-semibold" data-testid="error-insufficient">
                    Exceeds private balance
                  </span>
                )}
              </div>

              <div className="relative">
                <input
                  type="number"
                  step="any"
                  min="0"
                  placeholder="0.0000000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={`w-full rounded-xl bg-[var(--surface)] border px-4 py-3 text-lg font-mono text-[var(--off-white)] placeholder-[rgba(246,247,248,0.25)] focus:outline-none transition-colors ${
                    isAmountExceeding
                      ? 'border-red-500 focus:border-red-400'
                      : 'border-[var(--border-dim)] focus:border-[var(--gold)]'
                  }`}
                  data-testid="input-unshield-amount"
                />
                <button
                  type="button"
                  onClick={() => handleSetPercent(100)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-[var(--gold)] px-2 py-1 rounded bg-[rgba(253,218,36,0.1)] hover:bg-[rgba(253,218,36,0.2)]"
                >
                  MAX
                </button>
              </div>

              <div className="grid grid-cols-4 gap-2 mt-1">
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    onClick={() => handleSetPercent(pct)}
                    className="py-1.5 rounded-lg border border-[var(--border-dim)] bg-[var(--surface)] text-xs font-semibold text-[rgba(246,247,248,0.7)] hover:bg-[var(--surface-md)] hover:text-[var(--off-white)] transition-colors"
                  >
                    {pct === 100 ? 'Max' : `${pct}%`}
                  </button>
                ))}
              </div>
            </div>

            {/* Destination Address */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <Label>Destination Address</Label>
                <button
                  type="button"
                  onClick={() => {
                    setIsCustomRecipient(!isCustomRecipient)
                    if (isCustomRecipient) {
                      setDestinationAddress(ownSpendingAddress)
                    } else {
                      setDestinationAddress('')
                    }
                  }}
                  className="text-xs text-[var(--teal)] hover:underline cursor-pointer"
                >
                  {isCustomRecipient ? 'Use My Spending Account' : 'Send to other address'}
                </button>
              </div>

              {!isCustomRecipient ? (
                <div className="rounded-xl border border-[var(--border-dim)] bg-[var(--surface)] p-3 flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-[var(--off-white)]">
                      My Spending Account
                    </span>
                    <span className="text-[10px] uppercase tracking-wider text-[var(--teal)] bg-[rgba(0,167,181,0.1)] px-2 py-0.5 rounded">
                      Default
                    </span>
                  </div>
                  <span className="font-mono text-xs text-[rgba(246,247,248,0.5)] truncate">
                    {ownSpendingAddress || 'Loading spending account...'}
                  </span>
                </div>
              ) : (
                <input
                  type="text"
                  placeholder="G... or federation address"
                  value={destinationAddress}
                  onChange={(e) => setDestinationAddress(e.target.value)}
                  className="w-full rounded-xl bg-[var(--surface)] border border-[var(--border-dim)] px-4 py-3 text-xs font-mono text-[var(--off-white)] placeholder-[rgba(246,247,248,0.25)] focus:outline-none focus:border-[var(--gold)]"
                  data-testid="input-custom-destination"
                />
              )}
            </div>

            {/* Review Button */}
            <button
              type="button"
              disabled={!canProceedToReview}
              onClick={() => setStep('review')}
              className="mt-4 w-full py-3.5 rounded-xl font-anton uppercase tracking-wider text-base transition-all disabled:opacity-40 disabled:cursor-not-allowed bg-[var(--gold)] text-[var(--near-black)] hover:brightness-105 active:scale-[0.99]"
              data-testid="btn-review-unshield"
            >
              Review Unshield
            </button>
          </div>
        )}

        {/* ── STEP 2: REVIEW & VISIBILITY DISCLOSURE ──────────────────────────── */}
        {step === 'review' && (
          <div className="flex flex-col gap-5">
            {/* Critical Privacy Disclosure Banner */}
            <div
              className="rounded-2xl bg-[rgba(253,218,36,0.06)] border border-[rgba(253,218,36,0.3)] p-4 flex gap-3"
              data-testid="privacy-disclosure-banner"
            >
              <div className="text-xl">👁️</div>
              <div className="flex flex-col gap-1 text-xs">
                <span className="font-bold text-[var(--gold)] uppercase tracking-wider">
                  Withdrawal Visible On-Chain
                </span>
                <p className="text-[rgba(246,247,248,0.8)] leading-relaxed">
                  Moving funds out of the private pool to a public address is recorded on the public
                  Stellar ledger. The destination address and withdrawal amount will be visible
                  on-chain. Transactions inside the private pool remain hidden.
                </p>
                <p className="text-[rgba(246,247,248,0.8)] leading-relaxed">
                  Unaudited preview — testnet only. The private pool has not been through a
                  security audit; do not move funds you cannot afford to lose.
                </p>
              </div>
            </div>

            {/* Review Summary Breakdown */}
            <div className="rounded-2xl bg-[var(--surface-md)] border border-[var(--border-dim)] p-4 flex flex-col gap-3.5">
              <Label>Withdrawal Details</Label>

              <div className="flex justify-between items-center py-1">
                <span className="text-sm text-[rgba(246,247,248,0.6)]">Amount</span>
                <div className="flex items-center gap-1.5">
                  <AmountDisplay className="text-lg font-bold text-[var(--gold)]">
                    {amountStroops === null ? '0' : stroopsToXlm(amountStroops)}
                  </AmountDisplay>
                  <span className="text-sm font-semibold">{assetCode}</span>
                </div>
              </div>

              <div className="flex justify-between items-center py-1 border-t border-[rgba(255,255,255,0.06)]">
                <span className="text-sm text-[rgba(246,247,248,0.6)]">Source</span>
                <span className="text-xs font-semibold text-[var(--teal)]">
                  Private Pool (Shielded Note)
                </span>
              </div>

              <div className="flex flex-col gap-1 py-1 border-t border-[rgba(255,255,255,0.06)]">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-[rgba(246,247,248,0.6)]">Destination</span>
                  {destinationAddress === ownSpendingAddress && (
                    <span className="text-[10px] uppercase tracking-wider text-[var(--teal)] font-bold">
                      My Spending Account
                    </span>
                  )}
                </div>
                <span className="font-mono text-xs text-[var(--off-white)] break-all">
                  {destinationAddress}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-t border-[rgba(255,255,255,0.06)]">
                <span className="text-sm text-[rgba(246,247,248,0.6)]">Network Fee</span>
                <span className="text-xs font-bold text-[var(--teal)]">
                  Sponsored (0.00 XLM)
                </span>
              </div>
            </div>

            {/* Confirm Actions */}
            <div className="flex flex-col gap-2 mt-2">
              <button
                type="button"
                onClick={handleStartUnshield}
                className="w-full py-3.5 rounded-xl font-anton uppercase tracking-wider text-base bg-[var(--gold)] text-[var(--near-black)] hover:brightness-105 active:scale-[0.99] transition-all"
                data-testid="btn-confirm-unshield"
              >
                Confirm & Unshield
              </button>

              <button
                type="button"
                onClick={() => setStep('amount')}
                className="w-full py-3 rounded-xl text-sm font-semibold text-[rgba(246,247,248,0.6)] hover:text-[var(--off-white)] hover:bg-[var(--surface)] transition-all"
              >
                Back to Edit
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: PROVING & SETTLEMENT ────────────────────────────────────── */}
        {step === 'proving' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-6 py-12" data-testid="proving-screen">
            <div className="relative w-20 h-20 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full border-2 border-[rgba(253,218,36,0.2)] border-t-[var(--gold)] animate-spin" />
              <div className="text-2xl">🔒</div>
            </div>

            <div className="flex flex-col gap-2 max-w-xs">
              <h2 className="font-anton text-xl uppercase tracking-wider text-[var(--gold)]">
                Unshielding Funds
              </h2>
              <p className="text-xs text-[rgba(246,247,248,0.6)] animate-pulse font-mono">
                {provingStatus}
              </p>
            </div>
          </div>
        )}

        {/* ── STEP 4: COMPLETE ────────────────────────────────────────────────── */}
        {step === 'complete' && txHash && (
          <div className="flex flex-col gap-6 py-6" data-testid="complete-screen">
            <div className="flex flex-col items-center text-center gap-3">
              <div className="w-16 h-16 rounded-full bg-[rgba(0,167,181,0.15)] border border-[rgba(0,167,181,0.4)] flex items-center justify-center text-3xl">
                ✓
              </div>
              <h2 className="font-anton text-2xl uppercase tracking-wider text-[var(--gold)]">
                Unshield Complete
              </h2>
              <p className="text-xs text-[rgba(246,247,248,0.6)]">
                Funds have been withdrawn from the private pool to your public account.
              </p>
            </div>

            {/* Outcome card */}
            <div className="rounded-2xl bg-[var(--surface-md)] border border-[var(--border-dim)] p-4 flex flex-col gap-3">
              <div className="flex justify-between items-center py-1">
                <span className="text-xs text-[rgba(246,247,248,0.5)]">Amount Withdrawn</span>
                <span className="font-mono text-sm font-bold text-[var(--gold)]">
                  +{sentAmount} {assetCode}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-t border-[rgba(255,255,255,0.06)]">
                <span className="text-xs text-[rgba(246,247,248,0.5)]">Updated Private Balance</span>
                <span className="font-mono text-xs text-[var(--off-white)]">
                  {privateBalanceStroops === null ? 'Unavailable' : stroopsToXlm(privateBalanceStroops)} {assetCode}
                </span>
              </div>

              <div className="flex justify-between items-center py-1 border-t border-[rgba(255,255,255,0.06)]">
                <span className="text-xs text-[rgba(246,247,248,0.5)]">Updated Spending Balance</span>
                <span className="font-mono text-xs text-[var(--teal)] font-semibold">
                  {publicBalance} {assetCode}
                </span>
              </div>

              <div className="pt-2 border-t border-[rgba(255,255,255,0.06)] flex flex-col gap-1">
                <span className="text-[10px] uppercase font-anton tracking-wider text-[rgba(246,247,248,0.4)]">
                  Transaction Hash
                </span>
                <a
                  href={`https://stellar.expert/explorer/${explorerNetworkSegment()}/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[11px] text-[var(--teal)] hover:underline truncate"
                >
                  {txHash}
                </a>
              </div>
            </div>

            <div className="flex flex-col gap-2 mt-4">
              <button
                type="button"
                onClick={() => router.push('/dashboard')}
                className="w-full py-3.5 rounded-xl font-anton uppercase tracking-wider text-base bg-[var(--gold)] text-[var(--near-black)] hover:brightness-105 transition-all"
              >
                Back to Dashboard
              </button>

              <button
                type="button"
                onClick={() => router.push('/activity')}
                className="w-full py-3 rounded-xl text-sm font-semibold text-[rgba(246,247,248,0.6)] hover:text-[var(--off-white)] hover:bg-[var(--surface)] transition-all"
              >
                View Activity Feed
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 5: ERROR ───────────────────────────────────────────────────── */}
        {step === 'error' && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-6 py-10" data-testid="error-screen">
            <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center text-3xl text-red-400">
              ✕
            </div>

            <div className="flex flex-col gap-2 max-w-sm">
              <h2 className="font-anton text-xl uppercase tracking-wider text-red-400">
                Unshield Failed
              </h2>
              <p className="text-xs text-[rgba(246,247,248,0.7)] leading-relaxed">
                {errorMessage || 'An unexpected error occurred during unshield.'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setErrorMessage(null)
                setStep('amount')
              }}
              className="mt-4 px-6 py-3 rounded-xl font-anton uppercase tracking-wider text-sm bg-[var(--surface-md)] border border-[var(--border-dim)] hover:bg-[var(--surface)] text-[var(--off-white)] transition-all"
            >
              Try Again
            </button>
          </div>
        )}
      </main>
    </div>
  )
}

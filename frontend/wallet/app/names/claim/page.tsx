'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, PageHeader, PrimaryAction, SectionLabel, Nav } from '@/components/ui/primitives'
import { isNairaVerified } from '@/lib/ngn'
import { walletLocal } from '@/lib/walletStorage'
import {
  checkNameAvailability,
  executeClaim,
  getPendingClaim,
  recoverPendingClaim,
  clearPendingClaim,
  CLAIM_PRICE_DISPLAY,
  type NameAvailabilityResponse,
  type PendingClaimRecord,
  type ClaimResult,
} from '@/lib/claimClient'

export default function ClaimNamePage() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const initialName = searchParams.get('name') || ''
  const [name, setName] = useState(initialName)
  const [walletAddress, setWalletAddress] = useState<string>('')
  const [passkeyPublicKey, setPasskeyPublicKey] = useState<string>('')
  const [verified, setVerified] = useState<boolean | null>(null)

  const [availability, setAvailability] = useState<NameAvailabilityResponse | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successResult, setSuccessResult] = useState<ClaimResult | null>(null)
  const [pendingRecovery, setPendingRecovery] = useState<PendingClaimRecord | null>(null)

  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Hydrate wallet state and verification
  useEffect(() => {
    const address = walletLocal.getItem('invisible_wallet_address') || ''
    const pubKey = walletLocal.getItem('invisible_wallet_public_key') || ''
    setWalletAddress(address)
    setPasskeyPublicKey(pubKey)

    const isUserVerified = isNairaVerified()
    setVerified(isUserVerified)

    const pending = getPendingClaim()
    if (pending) {
      setPendingRecovery(pending)
      if (!name) setName(pending.name)
    }
  }, [])

  // Check availability with server normalisation
  const performCheck = useCallback(async (candidate: string) => {
    const trimmed = candidate.trim()
    if (!trimmed) {
      setAvailability(null)
      setIsChecking(false)
      return
    }

    setIsChecking(true)
    setError(null)
    try {
      const result = await checkNameAvailability(trimmed)
      setAvailability(result)
    } catch {
      setAvailability(null)
    } finally {
      setIsChecking(false)
    }
  }, [])

  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    if (!name.trim()) {
      setAvailability(null)
      return
    }

    debounceTimerRef.current = setTimeout(() => {
      void performCheck(name)
    }, 250)

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [name, performCheck])

  // Handle routing to verification while preserving typed name
  const handleGoToVerify = () => {
    const returnUrl = `/names/claim?name=${encodeURIComponent(name.trim())}`
    router.push(`/verify?returnTo=${encodeURIComponent(returnUrl)}`)
  }

  // Handle payment and claim execution with double-tap protection
  const handleClaim = async () => {
    if (busy || !availability?.available || !walletAddress) return
    setBusy(true)
    setError(null)

    try {
      const result = await executeClaim({
        name: name.trim(),
        walletAddress,
        passkeyPublicKey: passkeyPublicKey || walletAddress,
      })
      setSuccessResult(result)
      setPendingRecovery(null)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Claim failed. Please try again.'
      setError(message)
      // Check if a pending recovery record was established
      const pending = getPendingClaim()
      if (pending) setPendingRecovery(pending)
    } finally {
      setBusy(false)
    }
  }

  // Handle recovery without charging twice
  const handleRecover = async () => {
    if (busy || !pendingRecovery) return
    setBusy(true)
    setError(null)

    try {
      const result = await recoverPendingClaim(pendingRecovery)
      setSuccessResult(result)
      setPendingRecovery(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Recovery failed. Please check network.')
    } finally {
      setBusy(false)
    }
  }

  const handleDismissRecovery = () => {
    clearPendingClaim()
    setPendingRecovery(null)
  }

  // Success screen
  if (successResult) {
    return (
      <div className="wallet-shell">
        <Nav onBack={() => router.push('/dashboard')} title="VEIL" />
        <main className="wallet-main w-full max-w-[520px] mx-auto px-4 py-6">
          <PageHeader eyebrow="Name Claimed" title="Congratulations!" />
          <Card className="mt-6 flex flex-col gap-4 border-teal/40 bg-teal/5">
            <div className="text-center py-4">
              <span className="text-4xl">🎉</span>
              <h2 className="text-xl font-bold text-off-white mt-3">
                {successResult.stellar_address}
              </h2>
              <p className="text-xs text-white/60 font-mono mt-1 break-all">
                Bound to: {successResult.walletAddress}
              </p>
            </div>

            {successResult.hasFigure && successResult.figure && (
              <div className="border border-gold/30 bg-gold/5 rounded-2xl p-4 flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-anton tracking-wider text-gold uppercase">
                    Early Claimant Collectible
                  </span>
                  <span className="text-xs text-white/50 font-mono">
                    Token #{successResult.tokenId}
                  </span>
                </div>
                <h3 className="text-base font-semibold text-off-white">
                  {successResult.figure.name}
                </h3>
                <div className="grid grid-cols-2 gap-2 text-xs text-white/70 mt-1">
                  <div><span className="text-white/40">Crown:</span> {successResult.figure.crown}</div>
                  <div><span className="text-white/40">Aperture:</span> {successResult.figure.aperture}</div>
                  <div><span className="text-white/40">Ornament:</span> {successResult.figure.ornament}</div>
                  <div><span className="text-white/40">Palette:</span> {successResult.figure.palette}</div>
                  <div><span className="text-white/40">Hem:</span> {successResult.figure.hem}</div>
                </div>
                {successResult.figure.isClosedMask && (
                  <p className="text-[11px] text-teal mt-1 font-medium">
                    ✦ Closed Mask: 1 of 1 aperture in the collection
                  </p>
                )}
              </div>
            )}

            {successResult.figureWarning && (
              <div className="border border-white/10 bg-white/5 rounded-xl p-3 text-xs text-white/60">
                {successResult.figureWarning}
              </div>
            )}

            <PrimaryAction onClick={() => router.push('/dashboard')}>
              Go to Dashboard
            </PrimaryAction>
          </Card>
        </main>
      </div>
    )
  }

  return (
    <div className="wallet-shell">
      <Nav onBack={() => router.back()} title="VEIL" />
      <main className="wallet-main w-full max-w-[520px] mx-auto px-4 py-6 flex flex-col gap-5">
        <PageHeader eyebrow="Federation" title="Claim your name" />

        {/* Price shown before keyboard/input */}
        <Card className="flex items-center justify-between py-3 px-4 border-gold/30 bg-gold/5">
          <div>
            <SectionLabel>Registration fee</SectionLabel>
            <p className="text-xs text-white/60 mt-0.5">Permanent ownership · SEP-2 federation</p>
          </div>
          <div className="text-right">
            <span className="font-anton text-xl tracking-wide text-gold">{CLAIM_PRICE_DISPLAY}</span>
          </div>
        </Card>

        {/* Pending recovery card for interrupted payment */}
        {pendingRecovery && (
          <Card className="border-teal/40 bg-teal/10 flex flex-col gap-3">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold text-off-white">Unfinalized Payment Detected</p>
                <p className="text-xs text-white/70 mt-1">
                  You already paid 5 USDC for <span className="font-semibold text-gold">{pendingRecovery.name}</span> (tx: {pendingRecovery.paymentTxHash.slice(0, 10)}...). Complete registration below without paying again.
                </p>
              </div>
              <button
                type="button"
                onClick={handleDismissRecovery}
                className="text-xs text-white/40 hover:text-white"
              >
                ✕
              </button>
            </div>
            <PrimaryAction onClick={handleRecover} disabled={busy}>
              {busy ? 'Finalizing...' : 'Complete Registration Without Charging'}
            </PrimaryAction>
          </Card>
        )}

        {/* Identity Verification Check */}
        {verified === false && (
          <Card className="border-lilac/30 bg-lilac/5 flex flex-col gap-3">
            <div>
              <p className="text-sm font-semibold text-off-white">One-time Verification Required</p>
              <p className="text-xs text-white/70 mt-1">
                Veil requires a one-time identity check to prevent name squatting. Your typed name is saved and will be ready when you return.
              </p>
            </div>
            <PrimaryAction onClick={handleGoToVerify}>
              Verify my identity
            </PrimaryAction>
          </Card>
        )}

        {/* Name input card */}
        <Card className="flex flex-col gap-4">
          <div>
            <SectionLabel>Choose a name</SectionLabel>
            <div className="relative mt-2 flex items-center">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="alice"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                className="w-full bg-surface border border-white/10 rounded-xl px-4 py-3 text-sm text-off-white placeholder:text-white/30 focus:outline-none focus:border-gold transition-colors pr-36 font-mono"
              />
              <span className="absolute right-3 text-xs text-white/40 font-mono pointer-events-none">
                *useveilapp.xyz
              </span>
            </div>
          </div>

          {/* Live Availability Status */}
          {name.trim() && (
            <div className="text-xs transition-all">
              {isChecking ? (
                <span className="text-white/50">Checking availability...</span>
              ) : availability?.available ? (
                <div className="flex items-center gap-1.5 text-teal font-medium">
                  <span>✓</span>
                  <span>
                    <strong className="font-mono">{availability.normalized}*useveilapp.xyz</strong> is available!
                  </span>
                </div>
              ) : availability?.reason ? (
                <div className="flex items-center gap-1.5 text-red-400">
                  <span>✕</span>
                  <span>{availability.reason}</span>
                </div>
              ) : null}
            </div>
          )}
        </Card>

        {/* Masquerade Figure preview card - shown before payment */}
        {availability?.hasFigure && availability.figure && (
          <Card className="border-gold/30 bg-gold/5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-anton tracking-wider text-gold uppercase">
                Early Claimant Reward (First 20)
              </span>
              <span className="text-xs text-white/50 font-mono">
                Figure #{availability.nextClaimOrder} of 20
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold text-off-white">
                {availability.figure.name}
              </h3>
              <p className="text-xs text-white/60">
                Early Veil claimants receive a permanent 1-of-20 Masquerade collectible bound to their name.
              </p>
              <div className="grid grid-cols-2 gap-1.5 text-[11px] text-white/70 mt-2 bg-surface/50 p-2.5 rounded-lg border border-white/5">
                <div><span className="text-white/40">Crown:</span> {availability.figure.crown}</div>
                <div><span className="text-white/40">Aperture:</span> {availability.figure.aperture}</div>
                <div><span className="text-white/40">Ornament:</span> {availability.figure.ornament}</div>
                <div><span className="text-white/40">Palette:</span> {availability.figure.palette}</div>
                <div><span className="text-white/40">Hem:</span> {availability.figure.hem}</div>
              </div>
              {availability.figureNote && (
                <p className="text-[11px] text-teal font-medium mt-1">
                  ✦ {availability.figureNote}
                </p>
              )}
            </div>
          </Card>
        )}

        {/* Claimant 21+ notification - told before payment */}
        {availability && !availability.hasFigure && (
          <Card className="border-white/10 bg-white/5 text-xs text-white/70">
            <p className="font-semibold text-off-white mb-1">Collectible Allocation Finished</p>
            <p>{availability.figureWarning || 'All 20 Veil Masquerade figures have been allocated. You will receive your name, but no Masquerade figure token.'}</p>
          </Card>
        )}

        {/* Error message */}
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-400">
            {error}
          </div>
        )}

        {/* Claim button with double-tap protection */}
        <PrimaryAction
          onClick={handleClaim}
          disabled={
            busy ||
            isChecking ||
            !availability?.available ||
            verified === false
          }
        >
          {busy
            ? 'Processing...'
            : verified === false
            ? 'Verify to Claim Name'
            : `Pay 5 USDC & Claim ${name.trim() ? name.trim() + '*useveilapp.xyz' : 'Name'}`}
        </PrimaryAction>
      </main>
    </div>
  )
}

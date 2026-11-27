'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AlertCircle, CheckCircle2, Fingerprint } from 'lucide-react'

import { Card, Nav, TokenIcon } from '@/components/ui/primitives'
import {
  claimWebLink,
  inspectWebClaimLink,
  parseClaimLinkNetwork,
  parseClaimSecretFromHash,
  retryWebReserveRelease,
  sanitizeInboundClaimNote,
  type WebClaimLinkInspection,
} from '@/lib/claimLink'
import { ensureFeePayer, peekFeePayerKeypair } from '@/lib/feePayer'
import { setActiveNetwork, type VeilNetworkName } from '@/lib/network'
import { passkeyErrorMessage } from '@/lib/passkeyAuth'
import { isPasskeyCancellation } from '@/lib/passkeyOutcome'
import { walletLocal } from '@/lib/walletStorage'

export default function ClaimLinkPage() {
  const router = useRouter()
  const params = useParams<{ id?: string }>()
  const paramId = typeof params?.id === 'string' ? decodeURIComponent(params.id) : ''

  const [balanceId, setBalanceId] = useState(paramId)
  const [linkNetwork, setLinkNetwork] = useState<VeilNetworkName | null>(null)
  const [ephemeralSecret, setEphemeralSecret] = useState<string | null>(null)
  const [senderNote, setSenderNote] = useState<string | null>(null)

  const [hasStoredWallet, setHasStoredWallet] = useState(false)
  const [feePayerReady, setFeePayerReady] = useState(false)

  const [loading, setLoading] = useState(true)
  const [inspection, setInspection] = useState<WebClaimLinkInspection | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [busy, setBusy] = useState(false)
  const [retryingReserve, setRetryingReserve] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [claimed, setClaimed] = useState<{
    txHash: string
    amount: string
    assetCode: string
    destination: string
    reserveReleased: boolean
    reserveReleaseTxHash?: string
    reserveReleaseError?: string
  } | null>(null)

  const loadState = useCallback(
    async (
      targetId: string,
      opts: { targetNetwork?: VeilNetworkName | null; secret?: string | null } = {},
    ) => {
      if (!targetId) {
        setLoading(false)
        setInspection(null)
        setLoadError('This claim link is missing its claimable balance ID.')
        return
      }
      setLoading(true)
      setLoadError(null)
      try {
        const inspected = await inspectWebClaimLink(targetId, {
          linkNetwork: opts.targetNetwork ?? null,
          ephemeralSecret: opts.secret ?? null,
        })
        setInspection(inspected)
      } catch (err) {
        setInspection(null)
        setLoadError(
          `Could not read this claim link from the Stellar network (${err instanceof Error ? err.message : String(err)}).`,
        )
      } finally {
        setLoading(false)
      }
    },
    [],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const q = new URLSearchParams(window.location.search)
    const resolvedId = (paramId || q.get('id') || '').trim()
    const parsedNetwork = parseClaimLinkNetwork(q.get('network'))
    const parsedSecret = parseClaimSecretFromHash(window.location.hash)

    setBalanceId(resolvedId)
    setLinkNetwork(parsedNetwork)
    setSenderNote(sanitizeInboundClaimNote(q.get('note')))
    setEphemeralSecret(parsedSecret)

    const storedAddr = walletLocal.getItem('invisible_wallet_address')
    const storedKeyId = walletLocal.getItem('invisible_wallet_key_id')
    setHasStoredWallet(Boolean(storedAddr || storedKeyId))

    if (peekFeePayerKeypair()) {
      setFeePayerReady(true)
    } else {
      void ensureFeePayer(undefined, { passive: true })
        .then((kp) => {
          if (kp) setFeePayerReady(true)
        })
        .catch(() => null)
    }

    void loadState(resolvedId, { targetNetwork: parsedNetwork, secret: parsedSecret })
  }, [loadState, paramId])

  const handleLeave = useCallback(() => {
    if (hasStoredWallet && feePayerReady) {
      router.push('/dashboard')
    } else {
      router.push('/')
    }
  }, [feePayerReady, hasStoredWallet, router])

  const handleUnlockAndClaim = useCallback(async () => {
    setActionError(null)
    const secret =
      ephemeralSecret ??
      (typeof window !== 'undefined' ? parseClaimSecretFromHash(window.location.hash) : null)
    if (!secret) {
      setActionError(
        'This claim link is missing its bearer secret (#s=…). Open the full link shared by the sender.',
      )
      return
    }

    setBusy(true)
    try {
      let payer = peekFeePayerKeypair()
      if (!payer) {
        payer = await ensureFeePayer()
      }
      if (!payer) {
        setActionError('Could not unlock your Spending account. Unlock your wallet and try again.')
        return
      }
      setFeePayerReady(true)

      const result = await claimWebLink({
        balanceId,
        ephemeralSecret: secret,
        linkNetwork,
      })
      if (result.status === 'already_claimed') {
        await loadState(balanceId, { targetNetwork: linkNetwork, secret })
        return
      }
      if (result.reserveReleased) {
        if (typeof window !== 'undefined' && window.history?.replaceState) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search)
        }
        setEphemeralSecret(null)
      } else {
        // Keep `#s=` in the URL and retain the secret in memory until the
        // 1 XLM sponsor reserve release succeeds so retry can run cleanly.
        setEphemeralSecret(secret)
      }
      setClaimed({
        txHash: result.txHash,
        amount: result.amount,
        assetCode: result.assetCode,
        destination: result.destination,
        reserveReleased: result.reserveReleased,
        reserveReleaseTxHash: result.reserveReleaseTxHash,
        reserveReleaseError: result.reserveReleaseError,
      })
    } catch (err) {
      if (isPasskeyCancellation(err)) return
      setActionError(err instanceof Error ? err.message : passkeyErrorMessage(err))
    } finally {
      setBusy(false)
    }
  }, [balanceId, ephemeralSecret, linkNetwork, loadState])

  const handleRetryReserveRelease = useCallback(async () => {
    if (!claimed || claimed.reserveReleased || retryingReserve) return
    const secret =
      ephemeralSecret ??
      (typeof window !== 'undefined' ? parseClaimSecretFromHash(window.location.hash) : null)
    if (!secret) {
      setClaimed((prev) =>
        prev
          ? {
              ...prev,
              reserveReleaseError:
                'The link bearer secret (#s=…) is missing. Reopen the original link to release the 1 XLM reserve.',
            }
          : prev,
      )
      return
    }

    setRetryingReserve(true)
    try {
      let payer = peekFeePayerKeypair()
      if (!payer) {
        payer = await ensureFeePayer()
      }
      if (!payer) {
        setClaimed((prev) =>
          prev
            ? {
                ...prev,
                reserveReleaseError:
                  'Could not unlock your Spending account. Unlock your wallet and try again.',
              }
            : prev,
        )
        return
      }
      setFeePayerReady(true)

      const outcome = await retryWebReserveRelease({ ephemeralSecret: secret })
      if (outcome.released) {
        if (typeof window !== 'undefined' && window.history?.replaceState) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search)
        }
        setEphemeralSecret(null)
        setClaimed((prev) =>
          prev
            ? {
                ...prev,
                reserveReleased: true,
                reserveReleaseTxHash: outcome.txHash ?? prev.reserveReleaseTxHash,
                reserveReleaseError: undefined,
              }
            : prev,
        )
      } else {
        setClaimed((prev) =>
          prev
            ? {
                ...prev,
                reserveReleased: false,
                reserveReleaseError: outcome.error,
              }
            : prev,
        )
      }
    } catch (err) {
      if (isPasskeyCancellation(err)) return
      setClaimed((prev) =>
        prev
          ? {
              ...prev,
              reserveReleased: false,
              reserveReleaseError: err instanceof Error ? err.message : passkeyErrorMessage(err),
            }
          : prev,
      )
    } finally {
      setRetryingReserve(false)
    }
  }, [claimed, ephemeralSecret, retryingReserve])

  if (claimed) {
    return (
      <div className="min-h-screen flex flex-col">
        <Nav />
        <main className="flex-1 flex flex-col items-center justify-center px-6 py-12 max-w-md mx-auto w-full gap-6">
          <div className="w-14 h-14 rounded-full flex items-center justify-center bg-[rgba(253,218,36,0.14)] text-gold">
            {claimed.reserveReleased ? (
              <CheckCircle2 size={28} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <AlertCircle size={28} strokeWidth={1.75} aria-hidden="true" />
            )}
          </div>
          <div className="text-center">
            <h1
              style={{
                fontFamily: 'Lora, Georgia, serif',
                fontWeight: 600,
                fontStyle: 'italic',
                fontSize: '1.75rem',
                color: 'var(--off-white)',
              }}
            >
              {claimed.reserveReleased ? 'Funds claimed' : 'Funds delivered — reserve still held'}
            </h1>
            <p className="text-sm text-[rgba(246,247,248,0.75)] mt-2">
              {claimed.amount} {claimed.assetCode} swept into your Spending account.
            </p>
            <p
              className="font-mono text-xs text-gold mt-3 break-all"
              data-testid="web-claim-tx-hash"
            >
              tx {claimed.txHash}
            </p>
          </div>
          {!claimed.reserveReleased ? (
            <div
              role="alert"
              data-testid="web-claim-reserve-warning"
              className="w-full rounded-2xl border border-red-400/35 bg-red-500/10 p-4 flex flex-col gap-3 text-left"
            >
              <p className="text-sm font-semibold text-red-200">
                1 XLM sponsor reserve was not released yet
              </p>
              <p className="text-xs text-[rgba(246,247,248,0.85)] leading-relaxed">
                Your {claimed.amount} {claimed.assetCode} arrived in your Spending account, but the
                second transaction to release the temporary 1 XLM sponsor reserve failed. That 1 XLM
                stays held in reserve until released.
              </p>
              {claimed.reserveReleaseError && (
                <p
                  className="text-xs text-red-200 font-mono break-words"
                  data-testid="web-claim-reserve-error"
                >
                  {claimed.reserveReleaseError}
                </p>
              )}
              <button
                type="button"
                disabled={retryingReserve}
                onClick={() => void handleRetryReserveRelease()}
                className="btn-gold w-full"
                data-testid="web-claim-retry-reserve"
              >
                {retryingReserve ? 'Releasing 1 XLM reserve…' : 'Retry release 1 XLM reserve'}
              </button>
            </div>
          ) : (
            <p
              className="text-xs text-[rgba(246,247,248,0.68)] text-center"
              data-testid="web-claim-reserve-released"
            >
              Temporary 1 XLM sponsor reserve released back to your Spending account.
            </p>
          )}
          <button
            type="button"
            onClick={() => router.push('/dashboard')}
            className={claimed.reserveReleased ? 'btn-gold w-full' : 'btn-ghost w-full'}
          >
            Go to dashboard
          </button>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1 flex flex-col justify-center px-6 py-10 max-w-md mx-auto w-full gap-5">
        {loading ? (
          <Card className="flex items-center gap-3">
            <span className="text-sm text-[rgba(246,247,248,0.72)]">
              Reading claimable balance from Stellar…
            </span>
          </Card>
        ) : loadError ? (
          <Card className="flex flex-col gap-4">
            <div className="flex items-start gap-3 text-red-300">
              <AlertCircle size={20} className="shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-sm leading-relaxed" data-testid="web-claim-load-error">
                {loadError}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                void loadState(balanceId, { targetNetwork: linkNetwork, secret: ephemeralSecret })
              }
              className="btn-ghost w-full"
            >
              Try again
            </button>
            <button type="button" onClick={handleLeave} className="btn-ghost w-full">
              Close
            </button>
          </Card>
        ) : inspection?.status === 'network_mismatch' ? (
          <div data-testid="web-claim-network-mismatch">
            <Card className="flex flex-col gap-4">
              <h1 className="text-base font-semibold text-off-white">Wrong network selected</h1>
              <p className="text-sm text-[rgba(246,247,248,0.82)] leading-relaxed">
                {inspection.message}
              </p>
              {inspection.canSwitch && (
                <button
                  type="button"
                  data-testid="web-claim-switch-network"
                  onClick={() => setActiveNetwork(inspection.linkNetwork)}
                  className="btn-gold w-full"
                >
                  Switch to{' '}
                  {inspection.linkNetwork === 'mainnet' ? 'Stellar Mainnet' : 'Stellar Testnet'}
                </button>
              )}
              <button type="button" onClick={handleLeave} className="btn-ghost w-full">
                Close
              </button>
            </Card>
          </div>
        ) : inspection?.status === 'not_found' ? (
          <div data-testid="web-claim-not-found">
            <Card className="flex flex-col gap-4">
              <h1 className="text-base font-semibold text-off-white">Claim link not found</h1>
              <p className="text-sm text-[rgba(246,247,248,0.82)] leading-relaxed">
                {inspection.message}
              </p>
              <button type="button" onClick={handleLeave} className="btn-ghost w-full">
                Close
              </button>
            </Card>
          </div>
        ) : inspection?.status === 'status_unknown' ? (
          <div data-testid="web-claim-status-unknown">
            <Card className="flex flex-col gap-4">
              <h1 className="text-base font-semibold text-off-white">Could not check claim status</h1>
              <p className="text-sm text-[rgba(246,247,248,0.82)] leading-relaxed">
                {inspection.message}
              </p>
              <button
                type="button"
                onClick={() =>
                  void loadState(balanceId, { targetNetwork: linkNetwork, secret: ephemeralSecret })
                }
                className="btn-gold w-full"
              >
                Try again
              </button>
              <button type="button" onClick={handleLeave} className="btn-ghost w-full">
                Close
              </button>
            </Card>
          </div>
        ) : inspection?.status === 'consumed' ? (
          <div data-testid="web-claim-consumed">
            <Card className="flex flex-col gap-4">
              <h1 className="text-base font-semibold text-off-white">{inspection.message}</h1>
              <button type="button" onClick={handleLeave} className="btn-ghost w-full">
                Close
              </button>
            </Card>
          </div>
        ) : inspection?.status === 'claimable' ? (
          <div className="flex flex-col gap-4">
            <Card className="flex flex-col gap-4">
              <div className="flex items-center gap-3">
                {inspection.isVerifiedAsset && <TokenIcon code={inspection.assetCode} size={40} />}
                <div>
                  <p
                    data-testid="web-claim-verification-badge"
                    className={
                      inspection.isVerifiedAsset
                        ? 'text-xs uppercase tracking-[0.12em] text-[rgba(246,247,248,0.68)]'
                        : 'text-xs uppercase tracking-[0.12em] text-red-300 font-semibold'
                    }
                  >
                    {inspection.isVerifiedAsset
                      ? `Verified asset · ${inspection.verifiedIssuerName ?? 'Stellar'}`
                      : 'Unverified asset'}
                  </p>
                  <h1
                    data-testid="web-claim-amount"
                    style={{
                      fontFamily: 'Lora, Georgia, serif',
                      fontWeight: 600,
                      fontStyle: 'italic',
                      fontSize: '1.75rem',
                      color: 'var(--off-white)',
                    }}
                  >
                    {inspection.amount} {inspection.assetCode}
                  </h1>
                </div>
              </div>

              {!inspection.isVerifiedAsset && (
                <div
                  role="note"
                  data-testid="web-claim-unverified-warning"
                  className="rounded-xl border border-red-400/25 bg-red-500/10 px-3.5 py-2.5 text-xs text-red-200 leading-relaxed"
                >
                  Anyone on Stellar can issue an asset named {inspection.assetCode}. This issuer is
                  not in Veil&rsquo;s verified registry &mdash; claiming will add a trustline (0.5
                  XLM reserve) to this issuer.
                </div>
              )}

              {inspection.assetIssuer && (
                <div>
                  <p className="text-xs uppercase tracking-[0.1em] text-[rgba(246,247,248,0.62)]">
                    Asset issuer
                  </p>
                  <p
                    className="font-mono text-xs break-all text-[rgba(246,247,248,0.85)] mt-1"
                    data-testid="web-claim-issuer"
                  >
                    {inspection.assetIssuer}
                  </p>
                </div>
              )}

              {inspection.sponsor && (
                <div>
                  <p className="text-xs uppercase tracking-[0.1em] text-[rgba(246,247,248,0.62)]">
                    From
                  </p>
                  <p
                    className="font-mono text-xs break-all text-[rgba(246,247,248,0.85)] mt-1"
                    data-testid="web-claim-sender"
                  >
                    {inspection.sponsor}
                  </p>
                </div>
              )}

              {inspection.expiryLabel && (
                <p className="text-xs text-gold" data-testid="web-claim-expiry">
                  {inspection.expiryLabel}
                </p>
              )}

              {senderNote && (
                <div className="border-t border-[rgba(255,255,255,0.08)] pt-3">
                  <p className="text-xs uppercase tracking-[0.1em] text-[rgba(246,247,248,0.62)]">
                    Sender note (unverified)
                  </p>
                  <p className="text-sm text-off-white mt-1" data-testid="web-claim-note">
                    {senderNote}
                  </p>
                </div>
              )}
            </Card>

            <p className="text-xs text-[rgba(246,247,248,0.68)] text-center leading-relaxed px-2">
              Paying the claim fee from this wallet&rsquo;s Spending account records that account
              on the public Stellar ledger alongside the claim.
            </p>

            {actionError && (
              <div
                role="alert"
                className="rounded-xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-200"
              >
                {actionError}
              </div>
            )}

            {hasStoredWallet ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleUnlockAndClaim()}
                className="btn-gold w-full"
                data-testid="web-claim-submit"
              >
                {!feePayerReady && <Fingerprint size={18} strokeWidth={1.5} aria-hidden="true" />}
                {busy
                  ? 'Claiming…'
                  : feePayerReady
                    ? `Claim ${inspection.amount} ${inspection.isVerifiedAsset ? inspection.assetCode : `unverified ${inspection.assetCode}`}`
                    : `Unlock & claim ${inspection.amount} ${inspection.isVerifiedAsset ? inspection.assetCode : `unverified ${inspection.assetCode}`}`}
              </button>
            ) : (
              <div data-testid="web-claim-onboarding">
                <Card className="flex flex-col gap-3">
                  <p className="text-sm text-[rgba(246,247,248,0.78)]">
                    Create or recover a Veil wallet in this browser first, then reopen this claim
                    link to receive the funds.
                  </p>
                  <button
                    type="button"
                    onClick={() => router.push('/')}
                    className="btn-gold w-full"
                  >
                    Create wallet
                  </button>
                  <button
                    type="button"
                    onClick={() => router.push('/recover')}
                    className="btn-ghost w-full"
                  >
                    Recover existing wallet
                  </button>
                </Card>
              </div>
            )}

            <button type="button" onClick={handleLeave} className="btn-ghost w-full">
              Leave without claiming
            </button>
          </div>
        ) : null}
      </main>
    </div>
  )
}

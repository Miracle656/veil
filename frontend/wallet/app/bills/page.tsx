'use client'

/**
 * Bills & airtime — the everyday-money surface from the Veil design.
 *
 * Wire the bill flow to the existing /ngn/bills routes, following
 * frontend/mobile/app/airtime.tsx for the sequence: reserve, pay from the
 * wallet, poll to a terminal state.
 *
 * - Reserve first, spend second: Reserving locks the rate and gets the deposit
 *   address. A reservation failure costs nothing.
 * - Same signing path with platform fee: Crypto leaves the wallet via the fee-payer
 *   Stellar account, with the platform fee applied as on other money paths.
 * - Bounded wait and distinguishable retries (V276): The screen never waits
 *   indefinitely and poll errors are retried visibly before moving to unconfirmed,
 *   never saying a purchase failed when the money already left.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Keypair } from '@stellar/stellar-sdk'

import { AccentCard, Card, PageHeader, PrimaryAction, SectionLabel } from '@/components/ui/primitives'
import { previewBillSpendFee, sendBillPayment } from '@/lib/billSpend'
import { isPasskeyCancellation } from '@/lib/passkeyOutcome'
import {
  BillPoller,
  MAX_CONSECUTIVE_POLL_ERRORS,
} from '@/lib/billPolling'
import {
  getCustomerRef,
  getCustomerStatus,
  getOnrampRate,
  isNairaKycMismatch,
  isNairaNetwork,
  isNairaVerified,
  payBill,
  setNairaVerified,
  type NairaCoin,
} from '@/lib/ngn'
import type { PlatformFee } from '@/lib/platformFee'
import { beginTx, endTx } from '@/lib/txState'
import { walletLocal, walletSession } from '@/lib/walletStorage'

type Step = 'form' | 'confirm' | 'paying' | 'done' | 'failed' | 'unconfirmed'

const QUICK_AMOUNTS = [200, 500, 1000, 2000]

/**
 * Nigerian mobile prefixes, so the network is detected rather than asked for.
 */
const PREFIXES: Record<string, string[]> = {
  MTN: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'],
  AIRTEL: ['0802', '0808', '0708', '0812', '0701', '0902', '0901', '0904', '0907', '0912'],
  GLO: ['0805', '0807', '0705', '0815', '0811', '0905', '0915'],
  '9MOBILE': ['0809', '0818', '0817', '0909', '0908'],
}

const NETWORKS = Object.keys(PREFIXES)

function detectNetwork(phone: string): string | null {
  const p = phone.replace(/\D/g, '')
  if (p.length < 4) return null
  const prefix = p.slice(0, 4)
  for (const [network, list] of Object.entries(PREFIXES)) {
    if (list.includes(prefix)) return network
  }
  return null
}

function naira(n: number): string {
  return `₦${n.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
}

export default function BillsPage() {
  const router = useRouter()

  const mainnetOnly = !isNairaNetwork()

  const [step, setStep] = useState<Step>('form')
  const [error, setError] = useState<string | null>(null)

  const [provider, setProvider] = useState<string>('MTN')
  const [providerTouched, setProviderTouched] = useState(false)
  const [phone, setPhone] = useState('')
  const [amountNGN, setAmountNGN] = useState('')
  const [coin, setCoin] = useState<NairaCoin>('usdc')

  const [rate, setRate] = useState<number | null>(null)
  const [rateState, setRateState] = useState<'loading' | 'ready' | 'failed'>('loading')

  const [customerRef, setCustomerRef] = useState<string | null>(null)
  const [feePayerAddress, setFeePayerAddress] = useState<string | null>(null)
  const [mismatch, setMismatch] = useState(false)

  const [orderId, setOrderId] = useState<string | null>(null)
  const [, setPayHash] = useState<string | null>(null)
  const [veilFee, setVeilFee] = useState<PlatformFee | null>(null)
  const [spent, setSpent] = useState<number | null>(null)
  const [waitingForPasskey, setWaitingForPasskey] = useState(false)

  // Status polling state
  const [pollErrorCount, setPollErrorCount] = useState(0)
  const [unconfirmedReason, setUnconfirmedReason] = useState<'error' | 'timeout' | null>(null)
  const [isRechecking, setIsRechecking] = useState(false)

  const pollerRef = useRef<BillPoller | null>(null)

  const phoneDigits = useMemo(() => phone.replace(/\D/g, ''), [phone])
  const detected = useMemo(() => detectNetwork(phone), [phone])

  // A detected network wins until the user overrides it
  useEffect(() => {
    if (detected && !providerTouched) setProvider(detected)
  }, [detected, providerTouched])

  useEffect(() => {
    setMismatch(isNairaKycMismatch())
    const ref = getCustomerRef()
    setCustomerRef(ref)

    const secret = walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    if (secret) {
      try {
        setFeePayerAddress(Keypair.fromSecret(secret).publicKey())
      } catch {
        /* invalid secret falls back */
      }
    } else {
      const pub = walletLocal.getItem('veil_signer_public_key')
      if (pub) setFeePayerAddress(pub)
    }

    if (ref && !isNairaVerified()) {
      void getCustomerStatus(ref)
        .then((s) => {
          if (s.verified) {
            setNairaVerified(true)
          }
        })
        .catch(() => undefined)
    }
  }, [])

  const loadRate = useCallback(async () => {
    if (mainnetOnly) return
    setRateState('loading')
    try {
      const r = await getOnrampRate(coin)
      setRate(r)
      setRateState('ready')
    } catch {
      setRate(null)
      setRateState('failed')
    }
  }, [mainnetOnly, coin])

  useEffect(() => {
    void loadRate()
  }, [loadRate])

  const ngn = Number(amountNGN.replace(/[^\d]/g, '')) || 0
  const code = coin.toUpperCase()
  const cost = rate && ngn > 0 ? ngn / rate : 0

  // Preview fee on confirm step
  useEffect(() => {
    if (step !== 'confirm' || cost <= 0 || !feePayerAddress) {
      setVeilFee(null)
      return
    }
    let cancelled = false
    void previewBillSpendFee({
      amount: String(cost),
      coin,
      feePayerAddress,
    })
      .then((f) => {
        if (!cancelled) setVeilFee(f)
      })
      .catch(() => {
        if (!cancelled) setVeilFee(null)
      })

    return () => {
      cancelled = true
    }
  }, [step, cost, coin, feePayerAddress])

  // Stop polling on unmount
  useEffect(() => {
    return () => {
      if (pollerRef.current) {
        pollerRef.current.stop()
        pollerRef.current = null
      }
    }
  }, [])

  const phoneValid = phoneDigits.length === 11 && phoneDigits.startsWith('0')

  const continueFromForm = useCallback(() => {
    if (!isNairaVerified()) {
      router.push('/verify?returnTo=/bills')
      return
    }
    setStep('confirm')
  }, [router])

  const pay = useCallback(async () => {
    if (!customerRef || !feePayerAddress || !rate || ngn <= 0) return
    const signerSecret =
      walletSession.getItem('veil_signer_secret') || walletLocal.getItem('veil_signer_secret')
    if (!signerSecret) {
      setError('Signing key not found. Ensure your wallet is unlocked.')
      return
    }

    beginTx()
    setStep('paying')
    setError(null)
    setPollErrorCount(0)
    setUnconfirmedReason(null)

    try {
      const amountStableCoin = Number((ngn / rate).toFixed(7))

      // 1. Reserve first
      const order = await payBill({
        customerRef,
        billCategory: 'airtime',
        provider,
        customerId: phoneDigits,
        amountNgn: ngn,
        amountStableCoin,
        rate,
        coin,
        refundAddress: feePayerAddress,
      })

      setOrderId(order.id)
      setSpent(amountStableCoin)

      // 2. Spend second
      setWaitingForPasskey(true)
      const hash = await sendBillPayment({
        destination: order.wallet,
        amount: amountStableCoin,
        coin,
        signerSecret,
      })
      setWaitingForPasskey(false)
      setPayHash(hash)

      // 3. Status Polling with bounded wait and visible error recovery (V276)
      const poller = new BillPoller(
        customerRef,
        order.id,
        {
          onDone: () => setStep('done'),
          onFailed: () => setStep('failed'),
          onUnconfirmed: (reason) => {
            setUnconfirmedReason(reason)
            setStep('unconfirmed')
          },
          onErrorCountChange: (count) => setPollErrorCount(count),
        },
      )
      pollerRef.current = poller
      poller.start()
    } catch (err) {
      setWaitingForPasskey(false)
      // Cancelling returns to the confirmation with the order intact and no
      // error banner. No crypto left the wallet.
      if (isPasskeyCancellation(err)) {
        setError(null)
        setStep('confirm')
        return
      }
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      setStep('confirm')
    } finally {
      endTx()
    }
  }, [customerRef, feePayerAddress, rate, ngn, phoneDigits, provider, coin])

  const manualCheckStatus = useCallback(async () => {
    if (!orderId || !customerRef || isRechecking || !pollerRef.current) return
    setIsRechecking(true)
    try {
      const res = await pollerRef.current.manualCheck()
      if (res === 'done') {
        setStep('done')
      } else if (res === 'failed') {
        setStep('failed')
      } else if (res === 'error') {
        setUnconfirmedReason('error')
      } else {
        setUnconfirmedReason('timeout')
      }
    } finally {
      setIsRechecking(false)
    }
  }, [orderId, customerRef, isRechecking])

  if (mainnetOnly) {
    return (
      <>
        <PageHeader eyebrow="Everyday" title="Bills & airtime" />
        <div className="flex gap-5 mt-[26px] items-start max-xl:flex-col">
          <Card className="flex-1 max-w-[560px]">
            <p className="text-[15px] font-semibold text-off-white mb-2">Switch to mainnet to buy airtime</p>
            <p className="text-[13px] leading-relaxed text-white/55">
              Top-ups are vended against real crypto, so this only works on mainnet — there is
              no test mode. Switch network in Settings, then come back.
            </p>
          </Card>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHeader eyebrow="Everyday" title="Bills & airtime" />

      <div className="flex gap-5 mt-[26px] items-start max-xl:flex-col">
        <div className="flex-1 min-w-0 flex flex-col gap-5 w-full">
          {mismatch && (
            <Card className="border-[rgba(220,38,38,0.35)]">
              <p className="text-[15px] font-semibold text-off-white mb-2">
                Your identity check needs support
              </p>
              <p className="text-[13px] leading-relaxed text-white/55 mb-3">
                Your NIN is verified against a different customer reference, so orders on this
                one are refused. Send this reference to support and they can re-bind it.
              </p>
              <p className="text-[12px] font-mono text-gold break-all">{customerRef ?? '—'}</p>
            </Card>
          )}

          {/* Active Service Category */}
          <Card>
            <SectionLabel>Pay for</SectionLabel>
            <div className="grid grid-cols-4 max-md:grid-cols-2 gap-3 mt-[18px]">
              <div
                tabIndex={0}
                role="button"
                aria-pressed="true"
                aria-label="Airtime - All networks"
                className="bg-[rgba(253,218,36,0.08)] border border-[rgba(253,218,36,0.35)] rounded-[18px] px-4 py-[18px] flex flex-col gap-[5px] cursor-pointer"
              >
                <div className="text-[17px] text-gold">☎</div>
                <div className="text-sm font-semibold mt-1 whitespace-nowrap text-off-white">Airtime</div>
                <div className="text-[11px] text-[rgba(246,247,248,0.55)] whitespace-nowrap">
                  All networks
                </div>
              </div>
            </div>
          </Card>

          {error && (
            <div className="bg-[rgba(255,77,77,0.1)] border border-[rgba(255,77,77,0.35)] rounded-[18px] px-5 py-4">
              <p className="text-[13px] leading-relaxed text-[#FF4D4D] m-0">{error}</p>
            </div>
          )}

          {/* ── b1 · form ─────────────────────────────────────────────────── */}
          {step === 'form' && (
            <Card>
              <div className="flex flex-col gap-6">
                <div>
                  <SectionLabel>Network</SectionLabel>
                  <div className="flex gap-2 flex-wrap mt-3">
                    {NETWORKS.map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => {
                          setProvider(n)
                          setProviderTouched(true)
                        }}
                        className={`px-4 py-2.5 rounded-[12px] text-[13px] font-medium border transition-colors ${
                          provider === n
                            ? 'bg-gold text-near-black border-gold font-semibold'
                            : 'border-border-dim bg-[rgba(255,255,255,0.03)] text-white/70 hover:text-white hover:border-white/20'
                        }`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <SectionLabel>Phone number</SectionLabel>
                  <div className="mt-2.5">
                    <input
                      data-testid="airtime-phone-input"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value.replace(/[^\d]/g, '').slice(0, 11))}
                      placeholder="0803 512 4471"
                      inputMode="numeric"
                      className="w-full bg-surface-md border border-border-dim rounded-[14px] px-4 py-3.5 text-off-white text-[19px] font-mono tracking-wider outline-none focus:border-gold transition-colors"
                    />
                    <p className="text-[12px] text-white/50 mt-2">
                      {detected
                        ? `${detected} number, detected from ${phoneDigits.slice(0, 4)}${
                            providerTouched && provider !== detected ? ` — sending to ${provider}` : ''
                          }`
                        : 'Numbers get ported, so check the network above matches.'}
                    </p>
                  </div>
                </div>

                <div>
                  <SectionLabel>Amount</SectionLabel>
                  <div className="flex items-center gap-2 mt-2.5 bg-surface-md border border-border-dim rounded-[14px] px-4 py-3 focus-within:border-gold transition-colors">
                    <span className="text-[24px] font-semibold text-white/50">₦</span>
                    <input
                      data-testid="airtime-amount-input"
                      value={amountNGN}
                      onChange={(e) => setAmountNGN(e.target.value.replace(/[^\d]/g, ''))}
                      placeholder="0"
                      inputMode="numeric"
                      className="w-full bg-transparent border-none text-off-white text-[24px] font-semibold outline-none"
                    />
                  </div>
                  <div className="flex gap-2 flex-wrap mt-3">
                    {QUICK_AMOUNTS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => setAmountNGN(String(q))}
                        className={`px-3 py-1.5 rounded-pill text-[12px] border transition-colors ${
                          ngn === q
                            ? 'bg-[rgba(253,218,36,0.12)] border-[rgba(253,218,36,0.5)] text-gold font-semibold'
                            : 'border-border-dim bg-[rgba(255,255,255,0.03)] text-white/60 hover:text-white'
                        }`}
                      >
                        ₦{q.toLocaleString('en-NG')}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <SectionLabel>Pay with</SectionLabel>
                  <div className="flex gap-2 mt-2.5">
                    {(['usdc', 'xlm'] as NairaCoin[]).map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCoin(c)}
                        className={`flex-1 py-2.5 rounded-[12px] text-[13px] font-semibold border transition-colors uppercase ${
                          coin === c
                            ? 'bg-gold text-near-black border-gold'
                            : 'border-border-dim bg-[rgba(255,255,255,0.03)] text-white/65 hover:text-white'
                        }`}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="bg-[rgba(255,255,255,0.03)] border border-border-dim rounded-[14px] p-4 flex justify-between items-center">
                  <span className="text-[13px] text-white/60">Costs</span>
                  <div className="text-right">
                    <span className="text-[15px] font-semibold text-off-white font-mono">
                      {rateState === 'ready' && cost > 0
                        ? `${cost.toFixed(coin === 'xlm' ? 4 : 2)} ${code}`
                        : rateState === 'loading'
                          ? 'Checking…'
                          : '—'}
                    </span>
                    {rate && (
                      <div className="text-[11px] text-white/40 mt-0.5">
                        @ ₦{rate.toLocaleString('en-NG', { maximumFractionDigits: 2 })} / {code}
                      </div>
                    )}
                    {rateState === 'failed' && (
                      <button
                        type="button"
                        onClick={() => void loadRate()}
                        className="text-[12px] text-gold hover:underline block mt-1"
                      >
                        Rate unavailable — try again
                      </button>
                    )}
                  </div>
                </div>

                <PrimaryAction
                  data-testid="airtime-continue-btn"
                  disabled={!phoneValid || ngn <= 0 || rateState !== 'ready'}
                  onClick={continueFromForm}
                >
                  Continue
                </PrimaryAction>
              </div>
            </Card>
          )}

          {/* ── b2 · confirm ──────────────────────────────────────────────── */}
          {step === 'confirm' && (
            <div className="flex flex-col gap-5">
              <Card>
                <p className="text-[14px] text-white/60">
                  {naira(ngn)} airtime to {phoneDigits} costs
                </p>
                <p className="font-lora italic font-semibold text-[32px] text-off-white mt-1">
                  {cost.toFixed(coin === 'xlm' ? 4 : 2)} {code}
                </p>
              </Card>

              <Card>
                <div className="flex flex-col divide-y divide-border-dim">
                  <DetailRow label="Network" value={provider} />
                  <DetailRow label="Phone" value={phoneDigits} mono />
                  <DetailRow label="Paid from" value={`${code} balance`} />
                  <DetailRow label="Network fee" value="Sponsored" />
                  {veilFee && (
                    <DetailRow
                      label="Veil fee"
                      value={`${veilFee.amount} ${veilFee.assetCode}`}
                      mono
                    />
                  )}
                </div>
              </Card>

              <div className="bg-[rgba(255,255,255,0.03)] border border-border-dim rounded-[18px] p-4">
                <p className="text-[13px] leading-relaxed text-white/60 m-0">
                  If {provider} can&apos;t complete the top-up, the full amount comes straight
                  back to this wallet.
                </p>
              </div>

              <div className="flex flex-col gap-3">
                <PrimaryAction
                  data-testid="airtime-pay-btn"
                  onClick={() => void pay()}
                >
                  Pay {cost.toFixed(coin === 'xlm' ? 4 : 2)} {code}
                </PrimaryAction>
                <button
                  type="button"
                  onClick={() => setStep('form')}
                  className="w-full text-center text-[13px] text-white/50 hover:text-white/80 py-2 transition-colors"
                >
                  Back to edit
                </button>
              </div>
            </div>
          )}

          {/* ── b3 · paying / passkey / status polling ─────────────────────── */}
          {step === 'paying' && (
            <Card>
              <div className="flex flex-col gap-6 py-4 items-center text-center">
                <div className="w-12 h-12 rounded-full border-2 border-gold border-t-transparent animate-spin mb-2" />
                <div>
                  <h2 className="text-[20px] font-semibold text-off-white mb-2">
                    {waitingForPasskey ? 'Confirm with your passkey' : 'Sending your top-up'}
                  </h2>
                  <p
                    data-testid="airtime-wait-text"
                    className="text-[14px] leading-relaxed text-white/60 max-w-[420px]"
                  >
                    {waitingForPasskey
                      ? 'Approve the spend using Face ID, fingerprint, or device PIN.'
                      : pollErrorCount > 0
                        ? `Checking status failed — retrying (${pollErrorCount}/${MAX_CONSECUTIVE_POLL_ERRORS})…`
                        : `${provider} is vending ${naira(ngn)} to ${phoneDigits}.`}
                  </p>
                </div>

                <div className="w-full bg-[rgba(255,255,255,0.03)] border border-border-dim rounded-[14px] p-4 flex justify-between text-left">
                  <div>
                    <div className="text-[11px] uppercase tracking-wider text-white/40">Airtime</div>
                    <div className="text-[14px] font-medium text-off-white mt-0.5">
                      {naira(ngn)} · {provider}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] uppercase tracking-wider text-white/40">You spend</div>
                    <div className="text-[14px] font-mono font-semibold text-gold mt-0.5">
                      {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code}
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* ── b4 · done ─────────────────────────────────────────────────── */}
          {step === 'done' && (
            <div data-testid="airtime-done-screen" className="flex flex-col gap-5">
              <Card>
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-8 h-8 rounded-full bg-[rgba(0,208,146,0.15)] text-[#00D092] flex items-center justify-center font-bold">
                    ✓
                  </div>
                  <h2 className="text-[22px] font-semibold text-off-white">Airtime sent</h2>
                </div>
                <p className="text-[14px] leading-relaxed text-white/60">
                  {naira(ngn)} is on {phoneDigits}. It usually shows on the phone within a minute.
                </p>
              </Card>

              <Card>
                <div className="flex flex-col divide-y divide-border-dim">
                  <DetailRow label="Network" value={provider} />
                  <DetailRow label="Recipient" value={phoneDigits} mono />
                  <DetailRow
                    label="You spent"
                    value={`${(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} ${code}`}
                    mono
                  />
                  {orderId && (
                    <DetailRow
                      label="Reference"
                      value={orderId.slice(0, 8).toUpperCase()}
                      mono
                    />
                  )}
                </div>
              </Card>

              <div className="flex flex-col gap-3">
                <PrimaryAction
                  onClick={() => {
                    setStep('form')
                    setAmountNGN('')
                    setOrderId(null)
                    setPayHash(null)
                    setSpent(null)
                    void loadRate()
                  }}
                >
                  Buy again
                </PrimaryAction>
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="w-full text-center text-[13px] text-white/50 hover:text-white/80 py-2 transition-colors"
                >
                  Back to dashboard
                </button>
              </div>
            </div>
          )}

          {/* ── b5 · failed, refunding ────────────────────────────────────── */}
          {step === 'failed' && (
            <div data-testid="airtime-failed-screen" className="flex flex-col gap-5">
              <Card className="border-[rgba(255,77,77,0.35)]">
                <h2 className="text-[22px] font-semibold text-[#FF4D4D] mb-2">Payment failed</h2>
                <p className="text-[14px] leading-relaxed text-white/65">
                  Your {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} is being returned
                  to this wallet. No airtime was added to {phoneDigits}.
                </p>
              </Card>

              <Card>
                <div className="flex flex-col divide-y divide-border-dim">
                  <DetailRow label={`${provider} didn't complete the top-up`} value="—" />
                  <DetailRow label="Refund on its way back" value="Usually a few minutes" />
                  {orderId && (
                    <DetailRow
                      label="Reference"
                      value={orderId.slice(0, 8).toUpperCase()}
                      mono
                    />
                  )}
                </div>
              </Card>

              <p className="text-[13px] text-white/50 leading-relaxed">
                Nothing for you to do. It returns to this wallet and will show in your activity.
              </p>

              <div className="flex flex-col gap-3">
                <PrimaryAction
                  onClick={() => {
                    setStep('form')
                    setOrderId(null)
                    setPayHash(null)
                    setError(null)
                    void loadRate()
                  }}
                >
                  Try again
                </PrimaryAction>
                <button
                  type="button"
                  onClick={() => router.push('/dashboard')}
                  className="w-full text-center text-[13px] text-white/50 hover:text-white/80 py-2 transition-colors"
                >
                  Back to dashboard
                </button>
              </div>
            </div>
          )}

          {/* ── b6 · unconfirmed (bounded wait ended or consecutive poll errors) */}
          {step === 'unconfirmed' && (
            <div data-testid="airtime-unconfirmed-screen" className="flex flex-col gap-5">
              <Card>
                <h2 className="text-[22px] font-semibold text-off-white mb-2">
                  {unconfirmedReason === 'error'
                    ? "Couldn't confirm status"
                    : 'Delivery taking longer than usual'}
                </h2>
                <p className="text-[14px] leading-relaxed text-white/60">
                  {unconfirmedReason === 'error'
                    ? `Checking status failed after ${MAX_CONSECUTIVE_POLL_ERRORS} attempts. The network service could not be reached, but your top-up may already have arrived.`
                    : `Confirmation from ${provider} is taking longer than usual. Your top-up may already have arrived.`}
                </p>
              </Card>

              <Card>
                <div className="flex flex-col divide-y divide-border-dim">
                  <DetailRow label="Network" value={provider} />
                  <DetailRow label="Recipient" value={phoneDigits} mono />
                  <DetailRow
                    label="Payment"
                    value={`${(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} ${code} sent`}
                    mono
                  />
                  {orderId && (
                    <DetailRow
                      label="Reference"
                      value={orderId.slice(0, 8).toUpperCase()}
                      mono
                    />
                  )}
                </div>
              </Card>

              <div className="bg-[rgba(255,255,255,0.03)] border border-border-dim rounded-[18px] p-5">
                <div className="text-[11px] font-bold uppercase tracking-wider text-gold mb-3">
                  WHAT IS KNOWN
                </div>
                <div className="flex flex-col gap-2 text-[13px] text-white/70 leading-relaxed">
                  <div>• Your {(spent ?? cost).toFixed(coin === 'xlm' ? 4 : 2)} {code} left this wallet.</div>
                  <div>• The {naira(ngn)} airtime may already have arrived on {phoneDigits}.</div>
                  <div>• Check the recipient&apos;s phone balance (dial your network&apos;s balance code) or ask them directly.</div>
                  <div>
                    • If the airtime has not arrived, contact support with reference{' '}
                    <span className="font-mono text-gold">
                      {orderId ? orderId.slice(0, 8).toUpperCase() : 'above'}
                    </span>.
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3">
                <PrimaryAction
                  data-testid="airtime-check-again-btn"
                  disabled={isRechecking}
                  onClick={() => void manualCheckStatus()}
                >
                  {isRechecking ? 'Checking status…' : 'Check status again'}
                </PrimaryAction>
                <button
                  type="button"
                  data-testid="airtime-done-btn"
                  onClick={() => router.push('/dashboard')}
                  className="w-full text-center text-[13px] text-white/50 hover:text-white/80 py-2 transition-colors"
                >
                  Back to dashboard
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right side information */}
        <div className="w-[400px] max-xl:w-full shrink-0 flex flex-col gap-5">
          <AccentCard tone="gold">
            <SectionLabel>Live on mainnet</SectionLabel>
            <p className="font-lora italic font-semibold text-[21px] leading-[1.45] mt-3 text-off-white">
              Pay Nigerian bills straight from your crypto.
            </p>
            <p className="text-[13px] text-[rgba(246,247,248,0.65)] leading-[1.75] mt-3">
              Airtime is vended instantly through licensed Nigerian rails. Your payment is converted
              at the locked rate and delivered to the recipient phone within minutes.
            </p>
            <div className="flex flex-col gap-2 mt-4 pt-4 border-t border-[rgba(253,218,36,0.15)] text-[12px] text-[rgba(246,247,248,0.7)]">
              <div className="flex items-center gap-2">
                <span className="text-gold font-bold">✓</span>
                <span>All major networks: MTN, Airtel, Glo, 9mobile</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gold font-bold">✓</span>
                <span>Automatic refund to this wallet if a vend cannot complete</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gold font-bold">✓</span>
                <span>Pay with USDC or XLM at transparent rates</span>
              </div>
            </div>
          </AccentCard>

          <Card>
            <SectionLabel tone="dim">Scheduled</SectionLabel>
            <p className="text-[13px] text-[rgba(246,247,248,0.55)] leading-[1.7] mt-3">
              Recurring bills will appear here once configured. Each run builds an unsigned
              transaction and waits for your passkey — nothing will ever be charged
              automatically.
            </p>
          </Card>
        </div>
      </div>
    </>
  )
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex justify-between items-center py-3">
      <span className="text-[13px] text-white/50">{label}</span>
      <span className={`text-[14px] text-off-white ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

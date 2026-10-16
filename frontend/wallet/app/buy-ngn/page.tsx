'use client'

/**
 * Buy crypto with naira — the port of `frontend/mobile/app/buy-ngn.tsx`.
 *
 * Nothing here signs anything. Linq gives us a Nigerian account number, the
 * user transfers naira from their own bank app, and Linq delivers the crypto to
 * their classic address. That is why this works on a wallet that has never been
 * deployed and on a browser that cannot run a passkey ceremony: receiving needs
 * no contract and no signature.
 *
 * Three rules carried over from mobile, each of which cost something to learn:
 *
 *   - **Mainnet only.** A `G…` address is valid on both networks, so a testnet
 *     order would take real naira and deliver real crypto to an address this
 *     session never shows.
 *   - **The rate is per coin and fetched immediately before the order.** It
 *     used to be naira per *dollar* for every asset, which priced XLM at about
 *     five times its worth — ₦1,000 bought 0.6 XLM instead of 3.6.
 *   - **Delivery goes to the classic `G…` fee payer, never the `C…` wallet.**
 *     Linq pays by classic operation, which cannot name a contract.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

import { Card, PageHeader, PrimaryAction, SectionLabel } from '@/components/ui/primitives'
import { ensureFeePayer } from '@/lib/feePayer'
import {
  createOnrampOrder,
  getCustomerRef,
  getCustomerStatus,
  getOnrampRate,
  getOnrampStatus,
  isNairaKycMismatch,
  isNairaNetwork,
  forgetOnrampOrder,
  isNairaVerified,
  loadOnrampOrder,
  rememberOnrampOrder,
  secondsUntil,
  setNairaVerified,
  type NairaCoin,
  type OnrampOrder,
} from '@/lib/ngn'

type Step = 'amount' | 'pay' | 'done'

const COINS: { id: NairaCoin; label: string }[] = [
  { id: 'usdc', label: 'USDC' },
  { id: 'xlm', label: 'XLM' },
]

export default function BuyWithNairaPage() {
  const router = useRouter()

  const mainnetOnly = !isNairaNetwork()
  const [verified, setVerified] = useState<boolean | null>(null)
  const [mismatch, setMismatch] = useState(false)
  const [customerRef, setCustomerRef] = useState<string | null>(null)
  const [deliveryAddress, setDeliveryAddress] = useState<string | null>(null)

  const [coin, setCoin] = useState<NairaCoin>('usdc')
  const [ngn, setNgn] = useState('')
  const [rate, setRate] = useState<number | null>(null)
  const [step, setStep] = useState<Step>('amount')
  const [order, setOrder] = useState<OnrampOrder | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [secondsLeft, setSecondsLeft] = useState(0)

  useEffect(() => {
    const local = isNairaVerified()
    setVerified(local)
    setMismatch(isNairaKycMismatch())
    const ref = getCustomerRef()
    setCustomerRef(ref)

    // A live order outlives this component. Someone who left for their banking
    // app and came back has an account number to pay and a clock running on it.
    const pending = loadOnrampOrder()
    if (pending) {
      setOrder(pending)
      setStep('pay')
    }

    // The local flag is per browser, so someone who verified in the app looks
    // unverified here. Linq is the authority and this read costs no
    // verification attempt, so ask rather than send them back through a
    // one-time check they have already passed.
    if (!local && ref) {
      void getCustomerStatus(ref)
        .then((status) => {
          if (status.verified) {
            setNairaVerified(true)
            setVerified(true)
          }
        })
        // Unreachable or rate-limited: fall back to the local answer, which is
        // the cautious one — it offers verification rather than hiding it.
        .catch(() => undefined)
    }
    // The classic G-account Linq can actually pay. `ensureFeePayer` is
    // idempotent and already runs on the dashboard, so this is usually a
    // cache read rather than a fresh ceremony.
    void ensureFeePayer()
      .then((kp) => setDeliveryAddress(kp?.publicKey() ?? null))
      .catch(() => setDeliveryAddress(null))
  }, [])

  // The rate is indicative until the order locks it, and it is per coin.
  useEffect(() => {
    if (mainnetOnly) return
    let cancelled = false
    setRate(null)
    getOnrampRate(coin)
      .then((r) => !cancelled && setRate(r))
      .catch(() => !cancelled && setRate(null))
    return () => {
      cancelled = true
    }
  }, [coin, mainnetOnly])

  useEffect(() => {
    if (!order) return
    const tick = () => {
      const left = secondsUntil(order.expiresAt)
      setSecondsLeft(left)
      // Past the window the account stops accepting the payment, so the stored
      // copy has to go with it — a refresh must not restore a dead order.
      if (left <= 0) forgetOnrampOrder()
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [order])

  // Poll until Linq says the naira landed and the crypto went out.
  useEffect(() => {
    if (!order || !customerRef || step !== 'pay') return
    const id = setInterval(() => {
      void getOnrampStatus(customerRef, order.orderId)
        .then((s) => {
          if (/complete|success|settled|paid/i.test(s.status)) {
            // Settled: the account must not be offered again.
            forgetOnrampOrder()
            setStep('done')
          }
        })
        // A failed poll is not a failed order — say nothing and poll again.
        .catch(() => undefined)
    }, 10_000)
    return () => clearInterval(id)
  }, [order, customerRef, step])

  const amountNgn = Number(ngn.replace(/[^\d.]/g, ''))
  const estimated = rate && amountNgn > 0 ? amountNgn / rate : null

  const createOrder = useCallback(async () => {
    if (!customerRef || !deliveryAddress || !(amountNgn > 0)) return
    setBusy(true)
    setError(null)
    try {
      // Fetched again here, deliberately: the number locked into the order must
      // be the one quoted seconds ago, not one held while the user typed.
      const fresh = await getOnrampRate(coin)
      setRate(fresh)
      const created = await createOnrampOrder({
        customerRef,
        amountStableCoin: Number((amountNgn / fresh).toFixed(7)),
        walletAddress: deliveryAddress,
        rate: fresh,
        coin,
      })
      rememberOnrampOrder(created)
      setOrder(created)
      setStep('pay')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the order.')
    } finally {
      setBusy(false)
    }
  }, [customerRef, deliveryAddress, amountNgn, coin])

  if (mainnetOnly) {
    return (
      <>
        <PageHeader eyebrow="Add money" title="Buy with naira" />
        <Card className="mt-[26px] max-w-[560px]">
          <p className="text-[15px] font-semibold text-off-white mb-2">Switch to mainnet to buy</p>
          <p className="text-[13px] leading-relaxed text-white/55">
            Buying converts real naira into real crypto, so this only works on mainnet — there
            is no test mode. Switch network in Settings, then come back.
          </p>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader eyebrow="Add money" title="Buy with naira" />

      <div className="mt-[26px] max-w-[560px] flex flex-col gap-5">
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

        {verified === false && !mismatch && (
          <Card>
            <p className="text-[15px] font-semibold text-off-white mb-2">Verify once first</p>
            <p className="text-[13px] leading-relaxed text-white/55 mb-5">
              Nigerian rules require a one-time identity check before you can buy. It takes a
              minute and you will not be asked again.
            </p>
            <PrimaryAction onClick={() => router.push('/verify?returnTo=/buy-ngn')}>
              Verify my identity
            </PrimaryAction>
          </Card>
        )}

        {verified && !mismatch && step === 'amount' && (
          <Card>
            <SectionLabel>You pay</SectionLabel>
            <div className="flex gap-2 mt-4 mb-4">
              {COINS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setCoin(c.id)}
                  className={`px-4 py-2 rounded-pill text-[13px] border transition-colors ${
                    coin === c.id
                      ? 'bg-gold text-near-black border-gold font-semibold'
                      : 'border-border-dim text-white/60 hover:text-white/80'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <input
              inputMode="decimal"
              value={ngn}
              onChange={(e) => setNgn(e.target.value.replace(/[^\d.]/g, ''))}
              placeholder="₦ amount"
              className="w-full bg-surface-md border border-border-strong rounded-[14px] px-4 py-3 text-off-white text-[20px] outline-none focus:border-gold"
            />
            <p className="text-[13px] text-white/50 mt-3">
              {rate === null
                ? 'Fetching the current rate…'
                : `You get ≈ ${estimated ? estimated.toFixed(coin === 'xlm' ? 4 : 2) : '0.00'} ${coin.toUpperCase()} @ ₦${rate.toLocaleString('en-NG')} / ${coin.toUpperCase()}`}
            </p>
            {!deliveryAddress && (
              <p className="text-[12px] text-white/40 mt-2">
                Setting up the account that receives your crypto…
              </p>
            )}
            {error && <p className="text-[13px] text-[rgba(220,38,38,0.9)] mt-3">{error}</p>}
            <div className="mt-6">
              <PrimaryAction
                disabled={busy || !(amountNgn > 0) || rate === null || !deliveryAddress}
                onClick={() => void createOrder()}
              >
                {busy ? 'Creating order…' : 'Continue'}
              </PrimaryAction>
            </div>
          </Card>
        )}

        {step === 'pay' && order && (
          <Card>
            <SectionLabel>Transfer from your bank</SectionLabel>
            <p className="text-[13px] leading-relaxed text-white/55 mt-3 mb-5">
              Send exactly ₦{order.amountNgn.toLocaleString('en-NG')} to the account below from
              your own bank app. Your crypto arrives once it lands.
            </p>
            <Detail label="Bank" value={order.bankName} />
            <Detail label="Account number" value={order.accountNumber} mono />
            <Detail label="Account name" value={order.accountName} />
            <Detail label="Amount" value={`₦${order.amountNgn.toLocaleString('en-NG')}`} />
            <Detail
              label="You receive"
              value={`${order.amountStableCoin} ${coin.toUpperCase()}`}
            />
            <p className="text-[12px] text-white/40 mt-4">
              {secondsLeft > 0
                ? `This account stops accepting the payment in ${Math.floor(secondsLeft / 60)}m ${secondsLeft % 60}s.`
                : 'This order has expired. Do not send money to it — start a new one.'}
            </p>
          </Card>
        )}

        {step === 'done' && (
          <Card>
            <p className="text-[15px] font-semibold text-off-white mb-2">Crypto on its way</p>
            <p className="text-[13px] leading-relaxed text-white/55 mb-5">
              Your naira landed and the payout has been sent to your wallet.
            </p>
            <PrimaryAction onClick={() => router.push('/dashboard')}>Back to wallet</PrimaryAction>
          </Card>
        )}
      </div>
    </>
  )
}

function Detail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between items-center gap-4 py-[10px] border-b border-border-dim last:border-b-0">
      <span className="text-[13px] text-white/45">{label}</span>
      <span
        className={`text-[14px] text-off-white text-right break-all ${mono ? 'font-mono tracking-wide' : ''}`}
      >
        {value}
      </span>
    </div>
  )
}

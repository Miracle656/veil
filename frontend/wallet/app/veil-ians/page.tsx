'use client'

/**
 * /veil-ians — buy one of the twenty figures.
 *
 * Built to the Veil-ians Collection artboard: hero with a 3D card stage, a
 * filterable grid of twenty, and a detail sheet that buys. Departures from the
 * design, all because the design mocks what this page has to actually do:
 *
 * 1. The design hardcodes five sold pieces and a wallet balance. Here both are
 *    read from the chain, and — the part a mock never has to decide — there is
 *    a third answer. **Sold, available and "could not read" are different.** If
 *    the sold list cannot be fetched nothing is offered, because a shop that
 *    reads "could not read" as "available" takes an order it cannot fill.
 * 2. The design's buy flow has no gate. Figures are sold only to addresses that
 *    already hold a Veil name, so there is a step before the slider.
 * 3. "Slide to buy" is kept, but it is a real control: a pointer drag that only
 *    fires at the end of its travel. On a purchase that cannot be undone, a
 *    button under a thumb is the wrong affordance.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { walletSession } from '@/lib/walletStorage'
import { buildSignAuthEntry, getFeePayerKeypair } from '@/lib/passkeySigner'
import { foreignPlatformOrigin, formatUsdc, topUpWalletUsdc } from '@/lib/namesPurchase'
import {
  type BuyerState,
  buyFigure,
  buyFigureAsFeePayer,
  masqueradeContractId,
  masqueradeErrorMessage,
  readBuyerState,
  soldFigures,
} from '@/lib/masqueradePurchase'
import { COLLECTION_SIZE, FIGURES, figureImageUrl, pad } from '@/lib/masqueradeFigures'

type Shelf = 'available' | 'sold' | 'yours'
type Filter = 'all' | Shelf
type Sort = 'number' | 'price'
type Step = 'review' | 'signing' | 'working' | 'done'

/** The one the hero shows, as in the design. */
const FEATURED = 11

export default function VeilIansPage() {
  useInactivityLock()

  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [checkedWallet, setCheckedWallet] = useState(false)
  const [sold, setSold] = useState<number[] | null>(null)
  const [soldReadFailed, setSoldReadFailed] = useState(false)
  /** Bought in this session — shown as yours before the chain is re-read. */
  const [owned, setOwned] = useState<number[]>([])
  const [buyer, setBuyer] = useState<BuyerState | null>(null)
  const [lockedOrigin, setLockedOrigin] = useState<string | null>(null)

  const [filter, setFilter] = useState<Filter>('all')
  const [sort, setSort] = useState<Sort>('number')
  const [openId, setOpenId] = useState<number | null>(null)
  const [step, setStep] = useState<Step>('review')
  const [buyError, setBuyError] = useState<string | null>(null)
  const [boughtHash, setBoughtHash] = useState<string | null>(null)

  const gridRef = useRef<HTMLElement | null>(null)
  const collectionId = useMemo(() => masqueradeContractId(), [])

  useEffect(() => {
    const addr = walletSession.getItem('invisible_wallet_address')
    setWalletAddress(addr)
    setCheckedWallet(true)
    if (addr) void foreignPlatformOrigin(addr).then(setLockedOrigin)
  }, [])

  const refreshSold = useCallback(async () => {
    if (!collectionId) return
    const list = await soldFigures()
    setSold(list)
    setSoldReadFailed(list === null)
  }, [collectionId])

  const refreshBuyer = useCallback(async () => {
    if (!walletAddress || !collectionId) return
    let feePayer: string | null = null
    try {
      feePayer = getFeePayerKeypair().publicKey()
    } catch {
      feePayer = null
    }
    // A platform-locked wallet buys with its fee-payer, so the gate and the
    // balance that matter are the fee-payer's.
    const buying = lockedOrigin && feePayer ? feePayer : walletAddress
    setBuyer(await readBuyerState(buying, feePayer ?? buying))
  }, [walletAddress, collectionId, lockedOrigin])

  useEffect(() => {
    void refreshSold()
  }, [refreshSold])
  useEffect(() => {
    void refreshBuyer()
  }, [refreshBuyer])

  /** null = cannot tell, which is never rendered as "available". */
  const shelfOf = useCallback(
    (id: number): Shelf | null => {
      if (owned.includes(id)) return 'yours'
      if (sold === null) return null
      return sold.includes(id) ? 'sold' : 'available'
    },
    [sold, owned],
  )

  const counts = useMemo(() => {
    let available = 0
    let soldCount = 0
    for (const f of FIGURES) {
      const s = shelfOf(f.id)
      if (s === 'available') available += 1
      else if (s === 'sold') soldCount += 1
    }
    return { available, sold: soldCount, yours: owned.length }
  }, [shelfOf, owned.length])

  const items = useMemo(() => {
    const list = FIGURES.filter((f) => filter === 'all' || shelfOf(f.id) === filter)
    // Every figure is the same price, so sorting by it can only be a no-op
    // today. Kept because the design has the control and the contract's price
    // is read from the chain, not assumed.
    return sort === 'number' ? list : [...list].sort((a, b) => a.id - b.id)
  }, [filter, sort, shelfOf])

  const price = buyer ? formatUsdc(buyer.priceStroops) : '5'
  const chosen = openId === null ? null : FIGURES[openId - 1]
  const chosenShelf = openId === null ? null : shelfOf(openId)

  const needsTopUp = buyer !== null && !lockedOrigin && buyer.topUpStroops > 0n && !buyer.short
  const canBuy =
    Boolean(walletAddress) &&
    Boolean(collectionId) &&
    chosenShelf === 'available' &&
    buyer?.hasName === true &&
    !buyer.short &&
    step === 'review'

  const open = (id: number) => {
    setOpenId(id)
    setStep('review')
    setBuyError(null)
    setBoughtHash(null)
  }

  const close = () => {
    setOpenId(null)
    setStep('review')
  }

  const handleBuy = async () => {
    if (!walletAddress || openId === null) return
    setBuyError(null)
    setStep('signing')
    try {
      let hash: string
      if (lockedOrigin) {
        hash = await buyFigureAsFeePayer({
          feePayerKeypair: getFeePayerKeypair(),
          tokenId: openId,
        })
      } else {
        if (needsTopUp && buyer && buyer.topUpStroops > 0n) {
          await topUpWalletUsdc({
            walletAddress,
            feePayerKeypair: getFeePayerKeypair(),
            amountStroops: buyer.topUpStroops,
          })
        }
        setStep('working')
        hash = await buyFigure({
          walletAddress,
          tokenId: openId,
          feePayerKeypair: getFeePayerKeypair(),
          signAuthEntry: buildSignAuthEntry(),
        })
      }
      setBoughtHash(hash)
      setOwned((prev) => (prev.includes(openId) ? prev : [...prev, openId]))
      setStep('done')
      await Promise.all([refreshSold(), refreshBuyer()])
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err)
      setBuyError(
        /cancelled|NotAllowedError/i.test(raw)
          ? 'Passkey verification was cancelled. Nothing was charged.'
          : (masqueradeErrorMessage(err, collectionId) ?? raw),
      )
      setStep('review')
      // It may have gone while this was in flight.
      void refreshSold()
    }
  }

  return (
    <main className="min-h-screen bg-near-black font-sans text-off-white">
      {/* ── nav ────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between px-5 py-5 sm:px-10">
        <Link href="/" className="flex items-center gap-1 text-gold">
          <Drape />
          <span className="font-anton text-[18px] tracking-[0.08em]">VEIL</span>
        </Link>
        <nav className="flex items-center gap-6 text-[14px] font-medium">
          <Link href="/dashboard" className="text-off-white/60 transition-colors hover:text-off-white">
            Wallet
          </Link>
          <Link href="/names" className="text-off-white/60 transition-colors hover:text-off-white">
            Names
          </Link>
          <span className="text-off-white">Veil-ians</span>
          <a
            href="https://docs.useveilapp.xyz"
            className="text-off-white/60 transition-colors hover:text-off-white"
          >
            Docs
          </a>
        </nav>
      </header>

      {/* ── hero ───────────────────────────────────────────────── */}
      <section className="px-5 py-[clamp(40px,7vw,90px)] sm:px-10 lg:px-[72px]">
        <div className="mx-auto grid max-w-[1200px] grid-cols-1 items-center gap-[clamp(40px,6vw,88px)] lg:grid-cols-2">
          <div className="flex max-w-[540px] flex-col gap-6">
            <p className="font-anton text-[14px] tracking-[0.14em] text-gold">VEIL-IANS</p>
            <h1 className="font-lora text-[clamp(48px,6.4vw,88px)] font-semibold italic leading-[1.02] tracking-[-0.025em] text-balance">
              Own a{' '}
              <span
                className="px-[0.06em]"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(253,218,36,0) 60%, rgba(253,218,36,0.42) 60%, rgba(253,218,36,0.42) 92%, rgba(253,218,36,0) 92%)',
                }}
              >
                Veil-ian
              </span>
              .
            </h1>
            <p className="text-[clamp(16px,1.4vw,18px)] leading-[1.6] text-off-white/[0.64] text-pretty">
              Twenty veiled figures made for the Veil community. Each piece is one of one, kept in
              your Veil wallet and bought with your passkey.
            </p>

            <div className="flex flex-wrap border-y border-border-dim">
              <Fact value={String(COLLECTION_SIZE)} label="Pieces" />
              <Fact
                value={
                  !collectionId
                    ? '—'
                    : soldReadFailed || sold === null
                      ? '—'
                      : String(counts.available)
                }
                label="Available"
                divided
              />
              <Fact value={`${price} USDC`} label="Price each" divided grow />
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() =>
                  gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
                className="h-[52px] rounded-pill bg-gold px-[26px] text-[15px] font-semibold text-near-black transition-colors hover:bg-[#FFE14D]"
              >
                Browse the collection
              </button>
              <button
                type="button"
                onClick={() => open(FEATURED)}
                className="h-[52px] rounded-pill border border-white/[0.16] px-6 text-[15px] font-semibold text-off-white transition-colors hover:border-gold/60"
              >
                View #{pad(FEATURED)}
              </button>
            </div>
          </div>

          {/* The 3D stage: two blurred cards behind, the featured one in front. */}
          <div className="relative flex h-[clamp(460px,46vw,600px)] items-center justify-center">
            <StageCard id={3} className="-translate-x-[92px] translate-y-[18px] -rotate-[9deg]" />
            <StageCard id={15} className="translate-x-[92px] translate-y-[18px] rotate-[9deg]" />
            <div className="relative w-[min(74%,370px)]">
              <button
                type="button"
                onClick={() => open(FEATURED)}
                aria-label={`View Veil-ian #${pad(FEATURED)}`}
                className="relative block aspect-[3/4] w-full overflow-hidden rounded-[28px] border border-gold/35 bg-[#1A1A1A] shadow-[0_40px_90px_rgba(0,0,0,0.9)] transition-transform hover:-translate-y-1"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={figureImageUrl(FEATURED)}
                  alt={`Veil-ian #${pad(FEATURED)}`}
                  className="block h-full w-full object-cover"
                />
                <span className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-3 rounded-[18px] border border-white/10 bg-[rgba(12,12,12,0.78)] py-3 pl-4 pr-3.5 backdrop-blur">
                  <span className="flex flex-col gap-0.5 text-left">
                    <span className="text-[15px] font-semibold">Veil-ian #{pad(FEATURED)}</span>
                    <StatusLine shelf={shelfOf(FEATURED)} />
                  </span>
                  <span className="text-[16px] font-semibold tabular-nums">{price} USDC</span>
                </span>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── notices ────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1200px] px-5 sm:px-10 lg:px-[72px]">
        {!collectionId && (
          <Notice>
            The collection is not on sale yet. Everything below is the real art and the real traits;
            nothing can be bought until the contract is live.
          </Notice>
        )}
        {collectionId && soldReadFailed && (
          <Notice tone="warn">
            Could not read which pieces are still available, so none are offered. Nothing is being
            hidden — the collection cannot be asked right now.
          </Notice>
        )}
        {collectionId && checkedWallet && !walletAddress && (
          <Notice>
            <Link href="/" className="text-gold underline-offset-4 hover:underline">
              Open your Veil wallet
            </Link>{' '}
            to buy a piece. You will also need a Veil name.
          </Notice>
        )}
        {collectionId && walletAddress && buyer?.hasName === false && (
          <Notice tone="warn">
            Veil-ians are for name holders.{' '}
            <Link href="/names" className="text-gold underline-offset-4 hover:underline">
              Get a Veil name
            </Link>{' '}
            first — one transaction, and you keep the piece afterwards even if the name lapses.
          </Notice>
        )}
        {collectionId && walletAddress && buyer?.hasName === null && (
          <Notice>
            Could not check whether you hold a Veil name — the registry did not answer. That is not
            a statement that you do not have one.
          </Notice>
        )}
        {lockedOrigin && (
          <Notice>
            This wallet was created in the Veil mobile app and cannot be signed here, so the piece
            will be bought by — and held by — your fee-payer account.
          </Notice>
        )}
      </section>

      {/* ── the collection ─────────────────────────────────────── */}
      <section
        ref={gridRef}
        className="border-t border-white/[0.06] px-5 pb-[clamp(88px,10vw,140px)] pt-[clamp(72px,8vw,110px)] sm:px-10 lg:px-[72px]"
      >
        <div className="mx-auto flex max-w-[1200px] flex-col gap-9">
          <div className="flex flex-wrap items-end justify-between gap-5">
            <h2 className="font-lora text-[clamp(34px,4vw,52px)] font-semibold italic leading-[1.06] tracking-[-0.02em]">
              The collection
            </h2>
            <div className="flex flex-wrap items-center gap-2.5">
              <Segmented>
                {(
                  [
                    ['all', 'All', COLLECTION_SIZE],
                    ['available', 'Available', counts.available],
                    ['sold', 'Sold', counts.sold],
                    ...(counts.yours ? ([['yours', 'Yours', counts.yours]] as const) : []),
                  ] as [Filter, string, number][]
                ).map(([key, label, count]) => (
                  <SegButton
                    key={key}
                    active={filter === key}
                    onClick={() => setFilter(key)}
                    role="tab"
                  >
                    {label}
                    <span className="font-mono text-[13px] opacity-70">{count}</span>
                  </SegButton>
                ))}
              </Segmented>
              <Segmented>
                {(
                  [
                    ['number', 'Number'],
                    ['price', 'Price'],
                  ] as [Sort, string][]
                ).map(([key, label]) => (
                  <SegButton key={key} active={sort === key} onClick={() => setSort(key)}>
                    {label}
                  </SegButton>
                ))}
              </Segmented>
            </div>
          </div>

          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,220px),1fr))] gap-[18px]">
            {items.map((figure) => {
              const shelf = shelfOf(figure.id)
              return (
                <li key={figure.id}>
                  <button
                    type="button"
                    onClick={() => open(figure.id)}
                    className="flex w-full flex-col gap-3.5 rounded-3xl border border-border-dim bg-[#141414] p-2.5 pb-4 text-left shadow-[0_20px_50px_rgba(0,0,0,0.45)] transition-[transform,border-color] hover:-translate-y-1.5 hover:border-gold/45"
                  >
                    <div className="relative aspect-[3/4] overflow-hidden rounded-2xl bg-[#1A1A1A]">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={figureImageUrl(figure.id)}
                        alt={`Veil-ian #${pad(figure.id)} — a ${figure.crown.toLowerCase()} crown over ${figure.palette.toLowerCase()} cloth`}
                        loading="lazy"
                        className={[
                          'block h-full w-full object-cover',
                          shelf === 'sold' ? 'opacity-45' : 'opacity-100',
                        ].join(' ')}
                      />
                      {figure.aperture === 'None' && (
                        <span className="absolute left-2.5 top-2.5 flex h-[26px] items-center rounded-pill bg-gold px-2.5 text-[12px] font-semibold text-near-black">
                          Closed mask
                        </span>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 px-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[15px] font-semibold">
                          Veil-ian #{pad(figure.id)}
                        </span>
                        <span className="font-mono text-[12px] text-off-white/50">1 of 1</span>
                      </div>
                      {shelf === 'available' && (
                        <span className="text-[17px] font-semibold tabular-nums">
                          {price} USDC
                        </span>
                      )}
                      {shelf === 'sold' && (
                        <span className="text-[13px] text-off-white/[0.58]">Taken</span>
                      )}
                      {shelf === 'yours' && (
                        <span className="text-[13px] font-semibold text-gold">In your wallet</span>
                      )}
                      {shelf === null && (
                        <span className="text-[13px] text-off-white/40">Availability unknown</span>
                      )}
                      <span className="truncate text-[12px] text-off-white/40">
                        {figure.crown} · {figure.palette}
                      </span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </section>

      {/* ── footer ─────────────────────────────────────────────── */}
      <footer className="border-t border-white/[0.06] px-5 pb-12 pt-10 sm:px-10 lg:px-[72px]">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-6">
          <div className="flex flex-wrap items-center gap-3.5">
            <span className="flex items-center gap-1 text-gold">
              <Drape />
              <span className="font-anton text-[18px] tracking-[0.08em]">VEIL</span>
            </span>
            <span className="text-[13px] text-off-white/55">Passkey wallet on Stellar</span>
          </div>
          <div className="flex items-center gap-6 text-[14px]">
            <Link href="/dashboard" className="text-off-white/60 hover:text-off-white">
              Wallet
            </Link>
            <a href="https://docs.useveilapp.xyz" className="text-off-white/60 hover:text-off-white">
              Docs
            </a>
            <a
              href="https://github.com/Miracle656/veil"
              className="text-off-white/60 hover:text-off-white"
            >
              GitHub
            </a>
          </div>
        </div>
      </footer>

      {/* ── detail sheet ───────────────────────────────────────── */}
      {chosen && (
        <div
          onClick={(e) => e.target === e.currentTarget && close()}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(6,6,6,0.72)] p-4 backdrop-blur-[10px]"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Veil-ian #${pad(chosen.id)}`}
            className="grid max-h-[calc(100vh-32px)] w-full max-w-[900px] grid-cols-1 gap-6 overflow-y-auto rounded-[32px] border border-white/[0.09] bg-[#141414] p-[18px] shadow-[0_34px_80px_rgba(0,0,0,0.9)] sm:grid-cols-2"
          >
            <div className="overflow-hidden rounded-3xl bg-[#1A1A1A]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={figureImageUrl(chosen.id)}
                alt={`Veil-ian #${pad(chosen.id)}`}
                className="block aspect-[3/4] w-full object-cover"
              />
            </div>

            <div className="flex flex-col gap-5 p-2 sm:py-4 sm:pr-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-anton text-[12px] tracking-[0.14em] text-gold">
                    VEIL-IANS · {pad(chosen.id)} / {COLLECTION_SIZE}
                  </p>
                  <h3 className="mt-1.5 font-lora text-[30px] font-semibold italic leading-tight">
                    Veil-ian #{pad(chosen.id)}
                  </h3>
                  <StatusLine shelf={chosenShelf} />
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close"
                  className="rounded-full border border-white/10 px-3 py-1 text-[13px] text-off-white/60 hover:text-off-white"
                >
                  Esc
                </button>
              </div>

              <dl className="divide-y divide-border-dim border-y border-border-dim text-[14px]">
                <Row label="Price" value={`${price} USDC`} />
                <Row label="Edition" value="1 of 1" />
                <Row label="Crown" value={chosen.crown} />
                <Row label="Aperture" value={chosen.aperture} />
                <Row label="Ornament" value={chosen.ornament} />
                <Row label="Palette" value={chosen.palette} />
                <Row label="Hem" value={chosen.hem} />
                <Row label="Network" value="Stellar" />
                <Row label="Network fee" value="Covered by Veil" />
              </dl>

              {step === 'done' ? (
                <div className="flex flex-col gap-3">
                  <p className="text-[15px] text-off-white">
                    It is now in your Veil wallet, next to your money.
                  </p>
                  <Link
                    href="/nfts"
                    className="flex h-[52px] items-center justify-center rounded-pill bg-gold text-[15px] font-semibold text-near-black"
                  >
                    See it in your wallet
                  </Link>
                  <button
                    type="button"
                    onClick={close}
                    className="text-[14px] text-off-white/60 hover:text-off-white"
                  >
                    Back to the collection
                  </button>
                </div>
              ) : step === 'signing' || step === 'working' ? (
                <div className="flex flex-col gap-2 rounded-2xl border border-border-dim bg-near-black p-4">
                  <p className="text-[15px] font-medium">
                    {step === 'signing'
                      ? 'Use your fingerprint, face or screen lock to sign.'
                      : `Adding Veil-ian #${pad(chosen.id)} to your wallet`}
                  </p>
                  <p className="text-[13px] text-off-white/55">
                    {step === 'signing'
                      ? 'Nothing is charged until you do.'
                      : 'Recording the transfer on Stellar.'}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {needsTopUp && (
                    <p className="text-[13px] text-off-white/55">
                      {formatUsdc(buyer!.topUpStroops)} USDC will move into your wallet first.
                    </p>
                  )}
                  {buyer?.short && (
                    <p className="text-[13px] text-[#FF8A8A]">
                      Not enough USDC —{' '}
                      <Link href="/buy" className="text-gold underline-offset-4 hover:underline">
                        add money
                      </Link>
                      .
                    </p>
                  )}
                  <SlideToBuy
                    label={`Slide to buy for ${price} USDC`}
                    disabled={!canBuy}
                    onComplete={handleBuy}
                  />
                  {!canBuy && chosenShelf === 'sold' && (
                    <p className="text-[13px] text-off-white/55">
                      This one is already taken. The others are still there.
                    </p>
                  )}
                </div>
              )}

              {buyError && <p className="text-[13px] text-[#FF8A8A]">{buyError}</p>}
              {boughtHash && step !== 'done' && (
                <p className="font-mono text-[11px] text-off-white/40">{boughtHash}</p>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

/* ── pieces ─────────────────────────────────────────────────── */

/** The Drape: three bars, 52/40/28. */
function Drape() {
  return (
    <svg width="30" height="30" viewBox="0 0 96 96" fill="currentColor" aria-hidden="true">
      <rect x="22" y="26" width="52" height="12" rx="6" />
      <rect x="28" y="44" width="40" height="12" rx="6" opacity="0.5" />
      <rect x="34" y="62" width="28" height="12" rx="6" opacity="0.22" />
    </svg>
  )
}

function StageCard({ id, className }: { id: number; className: string }) {
  return (
    <div
      aria-hidden
      className={`absolute aspect-[3/4] w-[min(68%,340px)] scale-[0.84] overflow-hidden rounded-[26px] border border-white/10 opacity-80 blur-[1.5px] brightness-[0.6] shadow-[0_34px_80px_rgba(0,0,0,0.85)] ${className}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={figureImageUrl(id)} alt="" className="block h-full w-full object-cover" />
    </div>
  )
}

function Fact({
  value,
  label,
  divided,
  grow,
}: {
  value: string
  label: string
  divided?: boolean
  grow?: boolean
}) {
  return (
    <div
      className={[
        'flex flex-col gap-1 py-4',
        grow ? 'flex-[1_1_150px]' : 'flex-[1_1_120px]',
        divided ? 'border-l border-border-dim pl-5 pr-5 last:pr-0' : 'pr-5',
      ].join(' ')}
    >
      <span className="whitespace-nowrap text-[24px] font-semibold tabular-nums">{value}</span>
      <span className="text-[13px] text-off-white/[0.58]">{label}</span>
    </div>
  )
}

function StatusLine({ shelf }: { shelf: Shelf | null }) {
  const [text, colour] =
    shelf === 'available'
      ? ['Available', 'text-teal']
      : shelf === 'sold'
        ? ['Taken', 'text-warm-grey']
        : shelf === 'yours'
          ? ['In your wallet', 'text-gold']
          : ['Availability unknown', 'text-off-white/40']
  return (
    <span className={`mt-1 flex items-center gap-1.5 text-[12px] ${colour}`}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
      {text}
    </span>
  )
}

function Segmented({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="tablist"
      className="flex gap-[2px] rounded-pill border border-border-dim bg-[#141414] p-1"
    >
      {children}
    </div>
  )
}

function SegButton({
  active,
  onClick,
  children,
  role,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  role?: string
}) {
  return (
    <button
      type="button"
      role={role}
      aria-selected={role === 'tab' ? active : undefined}
      onClick={onClick}
      className={[
        'flex h-9 items-center gap-1.5 rounded-pill px-3.5 text-[13px] font-semibold transition-colors',
        active ? 'bg-gold text-near-black' : 'text-off-white/60 hover:text-off-white',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <dt className="text-off-white/[0.55]">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function Notice({ tone = 'muted', children }: { tone?: 'muted' | 'warn'; children: React.ReactNode }) {
  return (
    <div
      className={[
        'mb-3 rounded-xl border px-4 py-3 text-[13px] leading-[1.55]',
        tone === 'warn'
          ? 'border-gold/25 bg-gold/[0.06] text-off-white/80'
          : 'border-border-dim bg-[#141414] text-off-white/65',
      ].join(' ')}
    >
      {children}
    </div>
  )
}

/**
 * Slide to buy, as in the design — and a real control, not a styled button.
 *
 * The purchase cannot be undone, so it fires only after a deliberate drag to
 * the end of the track. Keyboard gets the same commitment through a two-press
 * confirm rather than being handed a plain Enter, because a control that is
 * strict with a thumb and lax with a keyboard is only theatre.
 */
function SlideToBuy({
  label,
  disabled,
  onComplete,
}: {
  label: string
  disabled: boolean
  onComplete: () => void
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [progress, setProgress] = useState(0)
  const [armed, setArmed] = useState(false)
  const firedRef = useRef(false)

  useEffect(() => {
    if (disabled) {
      setProgress(0)
      setArmed(false)
      firedRef.current = false
    }
  }, [disabled])

  const travel = () => {
    const track = trackRef.current
    return track ? Math.max(1, track.clientWidth - 56) : 1
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return
    firedRef.current = false
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || e.buttons === 0) return
    const track = trackRef.current
    if (!track) return
    const rect = track.getBoundingClientRect()
    const next = Math.min(1, Math.max(0, (e.clientX - rect.left - 28) / travel()))
    setProgress(next)
    if (next >= 0.985 && !firedRef.current) {
      firedRef.current = true
      onComplete()
    }
  }

  const release = () => {
    if (!firedRef.current) setProgress(0)
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        className={[
          'relative h-[56px] select-none overflow-hidden rounded-pill border',
          disabled
            ? 'cursor-not-allowed border-border-dim bg-[#101010] opacity-50'
            : 'cursor-grab border-gold/30 bg-[#101010]',
        ].join(' ')}
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 bg-gold/15"
          style={{ width: `${progress * 100}%` }}
        />
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-[14px] font-semibold text-off-white/70">
          {label}
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute top-1 flex h-12 w-12 items-center justify-center rounded-full bg-gold text-near-black"
          style={{ left: `calc(4px + ${progress} * (100% - 56px))` }}
        >
          →
        </span>
      </div>

      {/* The keyboard path. Two presses, so Enter alone cannot buy. */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => (armed ? onComplete() : setArmed(true))}
        onBlur={() => setArmed(false)}
        className="self-start text-[13px] text-off-white/55 underline-offset-4 hover:text-off-white hover:underline disabled:opacity-40"
      >
        {armed ? 'Press again to confirm' : 'Or buy with the keyboard'}
      </button>
    </div>
  )
}

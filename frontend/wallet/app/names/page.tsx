'use client'

/**
 * /names — buy a Veil name.
 *
 * Ported from the Veil Names design. Two departures from it, both deliberate:
 *
 * 1. The design mocks availability against a hardcoded `TAKEN` list. There is
 *    no registry yet, so this page cannot know whether a name is free, and it
 *    says so rather than guessing. `lookupAvailability` returns `unknown` when
 *    the lookup cannot be made and the claim button stays disabled. A page
 *    that tells somebody a name is available when nothing can grant it to them
 *    is a page that takes money for nothing.
 * 2. The design assumes a wallet already exists and goes straight to "pay from
 *    Veil wallet". Someone arriving here without one is offered onboarding
 *    instead of being bounced to /lock.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useInactivityLock } from '@/hooks/useInactivityLock'
import { walletSession } from '@/lib/walletStorage'
import { buildSignAuthEntry, getFeePayerKeypair } from '@/lib/passkeySigner'
import {
  type ChainAvailability,
  checkNameAvailability,
  nameErrorMessage,
  registerName,
} from '@/lib/namesPurchase'
import {
  MAX_NAME_LENGTH,
  MAX_TERM_YEARS,
  MIN_NAME_LENGTH,
  MIN_TERM_YEARS,
  SUFFIX,
  VALIDATION_MESSAGES,
  type Availability,
  clampTerm,
  describeAvailability,
  expiryDate,
  lookupAvailability,
  normalizeName,
  priceTable,
  pricePerYear,
  totalUsdc,
  validateName,
} from '@/lib/names'

/** Decoration for the hero. Three depth layers, furthest first. */
const CLOUD: { name: string; top: string; left: string; layer: 0 | 1 | 2 }[] = [
  { name: 'machala', top: '14%', left: '2%', layer: 0 },
  { name: 'jackofweb3', top: '10%', left: '30%', layer: 0 },
  { name: 'kemi', top: '8%', left: '82%', layer: 0 },
  { name: 'chidi', top: '62%', left: '4%', layer: 0 },
  { name: 'tee', top: '20%', left: '63%', layer: 1 },
  { name: 'ifrenzy', top: '70%', left: '84%', layer: 1 },
  { name: 'miracle', top: '34%', left: '9%', layer: 2 },
  { name: 'dxfareed', top: '40%', left: '76%', layer: 2 },
  { name: 'that_guy', top: '76%', left: '6%', layer: 2 },
]

const DEPTH = [
  { scale: 0.74, blur: 4.5, opacity: 0.34 },
  { scale: 0.88, blur: 1.6, opacity: 0.62 },
  { scale: 1, blur: 0, opacity: 1 },
]

const TRY_NAMES = ['chioma', 'ada', 'tunde_ng']

/** Pill colours per availability state, from the design's own table. */
const PILL_STYLE: Record<Availability, { bg: string; fg: string }> = {
  checking: { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(246,247,248,0.5)' },
  available: { bg: '#FDDA24', fg: '#0F0F0F' },
  taken: { bg: '#262626', fg: '#D6D2C4' },
  yours: { bg: '#FDDA24', fg: '#0F0F0F' },
  reserved: { bg: 'rgba(183,172,232,0.16)', fg: '#B7ACE8' },
  unknown: { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(246,247,248,0.5)' },
}

function NamePill({ name, layer }: { name: string; layer: 0 | 1 | 2 }) {
  const d = DEPTH[layer]
  return (
    <div
      aria-hidden
      className="absolute flex items-center gap-2 rounded-pill border border-border-dim bg-[#141414] px-3 py-2 whitespace-nowrap"
      style={{
        transform: `scale(${d.scale})`,
        filter: d.blur ? `blur(${d.blur}px)` : undefined,
        opacity: d.opacity,
      }}
    >
      <span className="grid h-6 w-6 place-items-center rounded-full bg-gold/20 text-[11px] font-semibold text-gold">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="text-sm font-semibold text-off-white">{name}</span>
      <span className="font-mono text-xs text-off-white/40">{SUFFIX}</span>
    </div>
  )
}

export default function NamesPage() {
  useInactivityLock()

  const [walletAddress, setWalletAddress] = useState<string | null>(null)
  const [checkedWallet, setCheckedWallet] = useState(false)
  const [query, setQuery] = useState('')
  const [availability, setAvailability] = useState<Availability | null>(null)
  const [years, setYears] = useState(MIN_TERM_YEARS)
  const latestLookup = useRef(0)
  const [chainState, setChainState] = useState<ChainAvailability | null>(null)
  const [isBuying, setIsBuying] = useState(false)
  const [buyError, setBuyError] = useState<string | null>(null)
  const [boughtHash, setBoughtHash] = useState<string | null>(null)

  useEffect(() => {
    setWalletAddress(walletSession.getItem('invisible_wallet_address'))
    setCheckedWallet(true)
  }, [])

  const name = useMemo(() => normalizeName(query), [query])
  const problem = useMemo(() => validateName(query), [query])
  const shapeOk = name.length >= MIN_NAME_LENGTH && problem === null

  // Debounced, and guarded by a sequence number: a slow lookup for an earlier
  // keystroke must never overwrite the answer for what is on screen now.
  useEffect(() => {
    if (!shapeOk) {
      setAvailability(null)
      return
    }
    setAvailability('checking')
    setChainState(null)
    const seq = ++latestLookup.current
    const timer = setTimeout(() => {
      // With a wallet, ask the registry by simulating the real `register`
      // call: it is the only answer that accounts for the reserved list and
      // the buyer's USDC at once, and simulation never prompts for a passkey.
      // Without one, fall back to the indexer — there is no buyer to simulate.
      const lookup = walletAddress
        ? checkNameAvailability(walletAddress, name, years).then((chain) => {
            if (seq === latestLookup.current) setChainState(chain)
            switch (chain) {
              case 'available':
              case 'insufficient_funds':
                return 'available' as Availability
              case 'yours':
                return 'yours' as Availability
              case 'taken':
              case 'in_recovery':
                return 'taken' as Availability
              case 'reserved':
                return 'reserved' as Availability
              default:
                return 'unknown' as Availability
            }
          })
        : lookupAvailability(name)

      void lookup.then((state) => {
        if (seq === latestLookup.current) setAvailability(state)
      })
    }, 350)
    return () => clearTimeout(timer)
  }, [name, shapeOk, walletAddress, years])

  const canBuy = chainState === 'available' && !isBuying && Boolean(walletAddress)

  const handleBuy = async () => {
    if (!walletAddress) return
    setIsBuying(true)
    setBuyError(null)
    try {
      const hash = await registerName({
        walletAddress,
        name,
        years,
        feePayerKeypair: getFeePayerKeypair(),
        signAuthEntry: buildSignAuthEntry(),
      })
      setBoughtHash(hash)
      setChainState('taken')
      setAvailability('yours')
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err)
      // A dismissed passkey prompt is not a failure worth a red error about a
      // broken purchase — nothing was charged and nothing was signed.
      if (/cancelled|NotAllowedError/i.test(raw)) {
        setBuyError('Passkey verification was cancelled. Nothing was charged.')
      } else {
        setBuyError(nameErrorMessage(err) ?? raw)
      }
    } finally {
      setIsBuying(false)
    }
  }

  const result = availability ? describeAvailability(availability, name) : null
  const perYear = shapeOk ? pricePerYear(name.length) : 0
  const total = shapeOk ? totalUsdc(name.length, years) : 0
  const until = useMemo(
    () => expiryDate(years).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
    [years],
  )

  const pickTry = useCallback((n: string) => setQuery(n), [])

  return (
    <main className="min-h-screen bg-near-black text-off-white">
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-4 pb-16 pt-14 sm:pt-20">
        <div className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden>
          {CLOUD.map((p) => (
            <div key={p.name} className="absolute" style={{ top: p.top, left: p.left }}>
              <NamePill name={p.name} layer={p.layer} />
            </div>
          ))}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-near-black/60 to-near-black" />
        </div>

        <div className="relative mx-auto max-w-2xl text-center">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-gold">
            Veil Names
          </p>
          <h1 className="mt-5 text-display-sm font-bold sm:text-display">
            Get paid by{' '}
            {/* The gold rule sits behind the word, so the word carries its own
                stacking context rather than a negative z-index — `-z-10` drops
                it behind the section background and it disappears. */}
            <span className="relative isolate whitespace-nowrap font-lora italic">
              <span
                aria-hidden
                className="absolute inset-x-0 bottom-[0.1em] z-0 h-[0.3em] bg-gold/70"
              />
              <span className="relative z-10">name</span>
            </span>
            .
          </h1>
          <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-off-white/70">
            A Veil name points to your wallet, so anyone on Veil can pay you without copying a
            56-character address.
          </p>

          <div className="mt-9">
            <label htmlFor="name-search" className="sr-only">
              Search for a Veil name
            </label>
            <div className="flex items-center gap-3 rounded-pill border border-border-dim bg-surface px-5 py-4 transition-colors focus-within:border-gold/50">
              <svg
                className="h-5 w-5 shrink-0 text-off-white/40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
              </svg>
              <input
                id="name-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`yourname${SUFFIX}`}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={MAX_NAME_LENGTH + SUFFIX.length}
                className="w-full bg-transparent font-mono text-lg text-off-white outline-none placeholder:text-off-white/30"
              />
            </div>

            <p className="mt-3 text-sm text-off-white/50" aria-live="polite">
              {problem
                ? VALIDATION_MESSAGES[problem]
                : `${MIN_NAME_LENGTH} to ${MAX_NAME_LENGTH} characters: lowercase letters, numbers and underscores.`}
            </p>

            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <span className="text-sm text-off-white/40">Try</span>
              {TRY_NAMES.map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => pickTry(n)}
                  className="rounded-pill border border-border-dim bg-surface px-3 py-1.5 font-mono text-sm text-off-white/80 transition-colors hover:border-gold/40 hover:text-gold"
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── Result ────────────────────────────────────────────────────── */}
      {result && availability && (
        <section className="px-4 pb-16">
          <div className="mx-auto max-w-2xl rounded-3xl border border-border-dim bg-surface p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex min-w-0 items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gold/20 font-semibold text-gold">
                  {name.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <p className="truncate font-mono text-lg font-semibold">
                    {name}
                    <span className="text-off-white/40">{SUFFIX}</span>
                  </p>
                  <p className="mt-0.5 text-sm text-off-white/60">{result.meta}</p>
                </div>
              </div>
              <span
                className="rounded-pill px-3 py-1.5 text-xs font-semibold uppercase tracking-wider"
                style={{ background: PILL_STYLE[availability].bg, color: PILL_STYLE[availability].fg }}
              >
                {result.pill}
              </span>
            </div>

            {result.claimable && (
              <div className="mt-6 border-t border-border-dim pt-6">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <p className="text-sm text-off-white/60">Register for</p>
                    <div className="mt-2 flex items-center gap-3">
                      <button
                        type="button"
                        aria-label="Fewer years"
                        disabled={years <= MIN_TERM_YEARS}
                        onClick={() => setYears((y) => clampTerm(y - 1))}
                        className="h-9 w-9 rounded-full border border-border-dim text-lg leading-none text-off-white disabled:opacity-30"
                      >
                        −
                      </button>
                      <span className="w-20 text-center font-mono tabular-nums">
                        {years} {years === 1 ? 'year' : 'years'}
                      </span>
                      <button
                        type="button"
                        aria-label="More years"
                        disabled={years >= MAX_TERM_YEARS}
                        onClick={() => setYears((y) => clampTerm(y + 1))}
                        className="h-9 w-9 rounded-full border border-border-dim text-lg leading-none text-off-white disabled:opacity-30"
                      >
                        +
                      </button>
                    </div>
                    <p className="mt-2 text-sm text-off-white/50">Until {until}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-2xl font-semibold text-gold">{total} USDC</p>
                    <p className="text-sm text-off-white/50">{perYear} USDC per year</p>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-6">
              {checkedWallet && !walletAddress ? (
                <Link
                  href="/"
                  className="block rounded-pill bg-gold px-6 py-3 text-center font-semibold text-near-black transition-opacity hover:opacity-90"
                >
                  Create a wallet to claim a name
                </Link>
              ) : (
                <button
                  type="button"
                  disabled={!canBuy}
                  onClick={() => void handleBuy()}
                  className="w-full rounded-pill bg-gold px-6 py-3 font-semibold text-near-black transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-surface-md disabled:text-off-white/40"
                >
                  {isBuying
                    ? 'Confirm with your passkey…'
                    : chainState === 'insufficient_funds'
                      ? `Not enough USDC — ${total} needed`
                      : availability === 'unknown'
                        ? 'Not available yet'
                        : `Claim for ${total} USDC`}
                </button>
              )}
              {boughtHash && (
                <p className="mt-3 text-center text-sm text-gold">
                  {name}{SUFFIX} is yours until {until}.
                </p>
              )}
              {buyError && (
                <p className="mt-3 text-center text-sm text-red-400">{buyError}</p>
              )}
              {chainState === 'insufficient_funds' && !buyError && (
                <p className="mt-3 text-center text-sm text-off-white/50">
                  This wallet needs {total} USDC to claim {name}{SUFFIX} for {years}{' '}
                  {years === 1 ? 'year' : 'years'}.
                </p>
              )}
              {chainState === 'in_recovery' && (
                <p className="mt-3 text-center text-sm text-off-white/50">
                  That name lapsed recently. For 90 days only its previous holder can take it
                  back.
                </p>
              )}
              {availability === 'unknown' && !walletAddress && (
                <p className="mt-3 text-center text-sm text-off-white/50">
                  Sign in to check whether a name is free and claim it.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── What a name does ──────────────────────────────────────────── */}
      <section className="border-t border-border-dim px-4 py-16">
        <div className="mx-auto max-w-2xl">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-off-white/40">
            What a name does
          </p>
          <h2 className="mt-4 text-display-sm font-bold">Send to a name instead of an address.</h2>
          <p className="mt-4 text-base leading-relaxed text-off-white/70">
            Every Veil wallet has a 56-character address. A name points to the same wallet, so you
            can type it from memory or read it out over the phone.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-border-dim bg-surface p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-off-white/40">
                Address
              </p>
              <p className="mt-3 break-all font-mono text-sm text-off-white/60">
                CDUS5S3AENE5QREEHCIEHGKMP6LMBDELUYB35ZSFYETXETN2674MXQHK
              </p>
            </div>
            <div className="rounded-2xl border border-gold/30 bg-gold/5 p-5">
              <p className="text-xs font-semibold uppercase tracking-wider text-gold">Name</p>
              <p className="mt-3 font-mono text-sm">
                ada<span className="text-off-white/40">{SUFFIX}</span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing ───────────────────────────────────────────────────── */}
      <section className="border-t border-border-dim px-4 py-16">
        <div className="mx-auto max-w-2xl">
          <p className="font-mono text-xs font-semibold uppercase tracking-[0.22em] text-off-white/40">
            Pricing
          </p>
          <h2 className="mt-4 text-display-sm font-bold">A name is rented by the year.</h2>
          <p className="mt-4 text-base leading-relaxed text-off-white/70">
            Prices are set in USDC. You pay from your Veil wallet with your passkey, and Veil covers
            the network fee. A name can be registered for up to {MAX_TERM_YEARS} years at a time and
            renewed before it runs out.
          </p>

          <ul className="mt-8 divide-y divide-border-dim overflow-hidden rounded-2xl border border-border-dim">
            {priceTable().map((row) => (
              <li key={row.label} className="flex items-center justify-between gap-4 bg-surface p-5">
                <div className="min-w-0">
                  <p className="font-semibold">{row.label}</p>
                  <p className="mt-1 truncate font-mono text-sm text-off-white/50">
                    {row.example}
                    {SUFFIX}
                  </p>
                </div>
                <p className="shrink-0 font-mono text-lg font-semibold text-gold">
                  {row.perYearUsdc} USDC
                  <span className="ml-1 text-sm font-normal text-off-white/50">/ yr</span>
                </p>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-sm leading-relaxed text-off-white/50">
            Names are {MIN_NAME_LENGTH} to {MAX_NAME_LENGTH} characters: lowercase letters, numbers
            and underscores. Names that could be used to pose as Veil or its team are reserved. If a
            name expires it stops working immediately, and only its previous holder can take it back
            for 90 days afterwards.
          </p>
        </div>
      </section>
    </main>
  )
}

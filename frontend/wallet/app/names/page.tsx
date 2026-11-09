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
  type FundingPlan,
  checkNameAvailability,
  formatUsdc,
  nameErrorMessage,
  planFunding,
  registerName,
  topUpWalletUsdc,
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
  const [demoMode, setDemoMode] = useState<'address' | 'name'>('address')
  const [funding, setFunding] = useState<FundingPlan | null>(null)
  const [topUpStage, setTopUpStage] = useState(false)

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
        ? checkNameAvailability(walletAddress, name, years).then(async (chain) => {
            if (seq === latestLookup.current) setChainState(chain)
            if (chain === 'insufficient_funds') {
              // The contract cannot pay. That does not mean the user cannot:
              // USDC bought or swapped lands on the fee-payer, and the
              // dashboard has been showing them that balance all along. Look
              // at both before telling anybody they are short.
              let feePayer: string | null = null
              try {
                feePayer = getFeePayerKeypair().publicKey()
              } catch {
                feePayer = null
              }
              const plan = feePayer
                ? await planFunding(walletAddress, feePayer, name, years)
                : null
              if (seq === latestLookup.current) setFunding(plan)
            } else if (seq === latestLookup.current) {
              setFunding(null)
            }
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

  // A purchase is possible when the contract can pay, or when the fee-payer
  // can cover the difference. The second case is the common one: USDC lands on
  // the fee-payer and the contract starts empty.
  const needsTopUp = chainState === 'insufficient_funds' && funding !== null && !funding.short
  const canBuy = (chainState === 'available' || needsTopUp) && !isBuying && Boolean(walletAddress)

  const handleBuy = async () => {
    if (!walletAddress) return
    setIsBuying(true)
    setBuyError(null)
    try {
      // Move the shortfall into the contract first. Two transactions, one
      // button: nobody should have to learn that their wallet keeps money in
      // two places before they can buy a name.
      if (needsTopUp && funding && funding.topUpStroops > 0n) {
        setTopUpStage(true)
        await topUpWalletUsdc({
          walletAddress,
          feePayerKeypair: getFeePayerKeypair(),
          amountStroops: funding.topUpStroops,
        })
        setTopUpStage(false)
      }

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
      setTopUpStage(false)
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

        <div className="relative mx-auto max-w-[760px] text-center">
          <p className="font-anton text-[14px] uppercase tracking-[0.14em] text-gold">
            Veil Names
          </p>
          {/* Lora italic 600 for the whole line, not just the highlighted word:
              the display face *is* the design here, and setting only "name" in
              it left the headline reading as ordinary bold sans. */}
          <h1 className="mt-5 font-lora text-[clamp(48px,7.2vw,86px)] font-semibold italic leading-[1.02] tracking-[-0.025em] text-balance">
            Get paid by{' '}
            {/* A highlighter band across the lower half of the word rather than
                a rule under it. As a background gradient it needs no stacking
                context, so the word cannot be painted behind the section. */}
            <span
              className="whitespace-nowrap px-[0.06em]"
              style={{
                background:
                  'linear-gradient(180deg, rgba(253,218,36,0) 60%, rgba(253,218,36,0.42) 60%, rgba(253,218,36,0.42) 92%, rgba(253,218,36,0) 92%)',
              }}
            >
              name
            </span>
            .
          </h1>
          <p className="mx-auto mt-[22px] max-w-[520px] text-[clamp(16px,1.4vw,18px)] leading-[1.6] text-off-white/[0.64] text-pretty">
            A Veil name points to your wallet, so anyone on Veil can pay you without copying a
            56-character address.
          </p>

          <div className="mt-9">
            {/* 76px tall, and the suffix is fixed text rather than part of the
                placeholder, so `*useveilapp.xyz` stays put and the caret sits
                against the name being typed. Inconsolata is monospaced, which
                makes `ch` an exact measure — the input can be sized to its own
                content without measuring anything in JavaScript. */}
            {/* A <label>, not a <div>. The input is only as wide as its own
                content — about 120px of a 760px bar — so with a div the other
                85% of the bar swallowed the click and nothing focused. The
                `cursor-text` was telling the truth about the intent and
                lying about the behaviour. */}
            <label
              htmlFor="name-search"
              className="flex h-[76px] cursor-text items-center gap-[14px] rounded-pill border border-border-dim bg-[#161616] pl-6 pr-[14px] transition-colors focus-within:border-gold/50"
            >
              <svg
                className="h-[22px] w-[22px] shrink-0 text-off-white/50"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <span className="flex min-w-0 flex-1 items-baseline overflow-hidden font-mono text-[clamp(20px,2.4vw,30px)] leading-[1.2]">
                <input
                  id="name-search"
                  value={query}
                  onChange={(e) =>
                    // The suffix is fixed text beside the field, so somebody
                    // pasting a whole address should not end up typing it
                    // twice and failing the charset rule.
                    setQuery(e.target.value.replace(SUFFIX, '').replace(/\*.*$/, ''))
                  }
                  placeholder="yourname"
                  aria-label="Search for a Veil name"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={MAX_NAME_LENGTH}
                  style={{ width: `${Math.max(query.length || 8, 1)}ch` }}
                  className="shrink-0 border-0 bg-transparent p-0 font-[inherit] text-off-white caret-gold outline-none placeholder:text-off-white/30"
                />
                <span aria-hidden className="whitespace-nowrap text-off-white/[0.38]">
                  {SUFFIX}
                </span>
              </span>
            </label>

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
                    ? topUpStage
                      ? 'Moving USDC into your wallet…'
                      : 'Confirm with your passkey…'
                    : needsTopUp
                      ? `Top up and claim for ${total} USDC`
                      : chainState === 'insufficient_funds'
                        ? `Not enough USDC — ${total} needed`
                        : availability === 'unknown'
                          ? 'Could not check'
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
              {needsTopUp && funding && !buyError && (
                <p className="mt-3 text-center text-sm text-off-white/50">
                  {formatUsdc(funding.topUpStroops)} USDC will move from your fee-payer into your
                  wallet first — your wallet holds {formatUsdc(funding.walletStroops)} of the{' '}
                  {total} needed.
                </p>
              )}
              {chainState === 'insufficient_funds' && !needsTopUp && !buyError && (
                /* Says what it read, not just what it wanted. "Not enough USDC"
                   on a wallet the owner knows is funded is unarguable and
                   undiagnosable; the balance beside it turns a dead end into
                   something checkable. */
                <p className="mt-3 text-center text-sm text-off-white/50">
                  This wallet needs {total} USDC to claim {name}{SUFFIX} for {years}{' '}
                  {years === 1 ? 'year' : 'years'}
                  {funding !== null
                    ? ` — it holds ${formatUsdc(funding.walletStroops)}, and your fee-payer ${formatUsdc(funding.feePayerStroops)}.`
                    : '.'}
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
              {/* Signed in and still unanswered. Saying "not available yet"
                  here claimed something about the name; this says what is
                  actually true, which is that we do not know. */}
              {availability === 'unknown' && walletAddress && (
                <p className="mt-3 text-center text-sm text-off-white/50">
                  Could not check this name just now. Try again in a moment — nothing has been
                  charged.
                </p>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ── What a name does ──────────────────────────────────────────── */}
      {/* Two columns with a working Send card, as the design has it: the point
          lands when you can see a name sitting in the field an address would
          otherwise fill, so the comparison is the control itself rather than
          two flat swatches of text beside each other. */}
      <section
        className="border-t border-border-dim px-[clamp(20px,5vw,72px)] py-[clamp(88px,10vw,140px)]"
        style={{
          background:
            'radial-gradient(900px 520px at 88% 50%, rgba(253,218,36,0.05), rgba(253,218,36,0) 70%), #0F0F0F',
        }}
      >
        <div className="mx-auto grid max-w-[1200px] items-center gap-[clamp(48px,6vw,96px)] [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
          <div className="flex max-w-[520px] flex-col gap-[22px]">
            <p className="font-anton text-[14px] uppercase tracking-[0.14em] text-gold">
              What a name does
            </p>
            <h2 className="font-lora text-[clamp(36px,4.2vw,56px)] font-semibold italic leading-[1.06] tracking-[-0.02em] text-balance">
              Send to a name instead of an address.
            </h2>
            <p className="text-[17px] leading-[1.65] text-off-white/[0.64] text-pretty">
              Every Veil wallet has a 56-character address. A name points to the same wallet, so
              you can type it from memory or read it out over the phone.
            </p>
          </div>

          <div
            className="flex flex-col gap-5 rounded-[28px] border border-white/[0.08] bg-[#141414] p-[clamp(20px,2.4vw,28px)]"
            style={{
              boxShadow: '0 34px 80px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.06)',
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-anton text-[13px] uppercase tracking-[0.14em] text-off-white/[0.58]">
                Send
              </p>
              <div role="tablist" aria-label="Send to an address or a name" className="flex gap-[2px] rounded-pill border border-white/[0.08] bg-[#0F0F0F] p-1">
                {(['address', 'name'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="tab"
                    aria-selected={demoMode === mode}
                    onClick={() => setDemoMode(mode)}
                    className={`h-8 rounded-pill px-[14px] text-[13px] font-semibold capitalize transition-colors ${
                      demoMode === mode
                        ? 'bg-off-white text-near-black'
                        : 'bg-transparent text-off-white/60 hover:text-off-white'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-[10px]">
              <p className="text-[13px] text-off-white/[0.58]">To</p>
              {/* Both states occupy the same grid cell so the card never
                  changes height when the toggle flips. */}
              <div
                className={`grid min-h-[118px] items-center rounded-[18px] border bg-[#0F0F0F] px-5 py-[18px] transition-colors duration-500 ${
                  demoMode === 'name' ? 'border-gold/40' : 'border-white/[0.08]'
                }`}
              >
                <p
                  aria-hidden={demoMode !== 'address'}
                  className={`[grid-area:1/1] break-all font-mono text-[clamp(17px,1.7vw,21px)] leading-[1.5] tracking-[0.03em] transition-[opacity,filter] duration-500 ${
                    demoMode === 'address' ? 'opacity-100 blur-0' : 'opacity-0 blur-[6px]'
                  }`}
                >
                  CDUS5S3AENE5QREEHCIEHGKMP6LMBDELUYB35ZSFYETXETN2674MXQHK
                </p>
                <div
                  aria-hidden={demoMode !== 'name'}
                  className={`pointer-events-none flex [grid-area:1/1] items-center gap-[14px] transition-[opacity,filter] duration-500 ${
                    demoMode === 'name' ? 'opacity-100 blur-0' : 'opacity-0 blur-[6px]'
                  }`}
                >
                  <span className="flex h-[46px] w-[46px] flex-none items-center justify-center rounded-full bg-gold/20 font-semibold text-gold">
                    A
                  </span>
                  <span className="flex flex-wrap items-baseline text-[clamp(24px,2.6vw,32px)]">
                    <span className="font-semibold tracking-[-0.01em]">ada</span>
                    <span className="font-mono text-[0.86em] text-off-white/50">{SUFFIX}</span>
                  </span>
                </div>
              </div>

              <div className="flex min-h-[22px] flex-wrap items-center justify-between gap-3 text-[13px]">
                <span className="text-off-white/[0.58]">
                  {demoMode === 'name'
                    ? 'Points to the same wallet.'
                    : 'Fifty-six characters, and every one of them matters.'}
                </span>
                <span
                  className={`flex items-center gap-[6px] text-[#00A7B5] transition-opacity duration-500 ${
                    demoMode === 'name' ? 'opacity-100' : 'opacity-0'
                  }`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  <span className="font-mono text-[14px]">CDUS5S…4MXQHK</span>
                </span>
              </div>
            </div>

            {/* USDC is what the registry actually charges and what the wallet
                actually sends, so it is the figure shown. A local-currency
                headline would be a conversion this page cannot make. */}
            <div className="flex flex-wrap items-end justify-between gap-3 border-t border-white/[0.07] pt-[18px]">
              <span className="flex flex-col gap-[6px]">
                <span className="text-[13px] text-off-white/[0.58]">Amount</span>
                <span className="text-[clamp(26px,2.6vw,32px)] font-semibold tracking-[-0.02em] tabular-nums">
                  13.77{' '}
                  <span className="font-mono text-[0.55em] font-normal text-off-white/[0.55]">
                    USDC
                  </span>
                </span>
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing ───────────────────────────────────────────────────── */}
      {/* The design's headline here is "Shorter names cost more." It is not
          true of the prices the contract charges: three characters cost 3
          USDC and seven cost 5, so short names are *cheaper* than mid-length
          ones. The curve is deliberately not monotonic — `price_per_year` in
          contracts/veil-names says so and warns against "correcting" it —
          because six to ten characters is where real first names sit and
          therefore where demand is. The headline states that instead, so the
          table below cannot read as a mistake. */}
      <section className="border-t border-border-dim px-[clamp(20px,5vw,72px)] py-[clamp(88px,10vw,140px)]">
        <div className="mx-auto flex max-w-[1200px] flex-col gap-12">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div className="flex flex-col gap-5">
              <p className="font-anton text-[14px] uppercase tracking-[0.14em] text-gold">Pricing</p>
              <h2 className="font-lora text-[clamp(36px,4.2vw,56px)] font-semibold italic leading-[1.06] tracking-[-0.02em]">
                Mid-length names cost the most.
              </h2>
            </div>
            <p className="max-w-[430px] text-[16px] leading-[1.6] text-off-white/[0.64] text-pretty">
              Length sets the price, but not in a straight line: six to ten characters cost
              the most, because that is where real first names sit. Prices are set in USDC. You
              pay from your Veil wallet with your passkey, and Veil covers the network fee.
            </p>
          </div>

          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))]">
            {priceTable().map((row) => (
              <div
                key={row.label}
                className="flex flex-col gap-[34px] rounded-[26px] border border-white/[0.08] bg-[#141414] p-7"
                style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05)' }}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="font-anton text-[13px] uppercase tracking-[0.12em] text-gold">
                    {row.label}
                  </span>
                  <span className="truncate font-mono text-[15px] text-off-white/[0.55]">
                    {row.example}
                    {SUFFIX}
                  </span>
                </div>
                <div className="flex flex-col gap-2">
                  <span className="text-[clamp(34px,3.4vw,44px)] font-semibold leading-[1.05] tracking-[-0.025em] tabular-nums">
                    {row.perYearUsdc} USDC
                  </span>
                  <span className="text-[14px] text-off-white/[0.58]">
                    per year · up to {MAX_TERM_YEARS} years at a time
                  </span>
                </div>
              </div>
            ))}
          </div>

          <p className="max-w-[760px] text-sm leading-relaxed text-off-white/50">
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

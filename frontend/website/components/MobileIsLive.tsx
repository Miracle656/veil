'use client'

/**
 * "Mobile is live" — the section announcing the Android build.
 *
 * Two things drive the composition. The phone is tilted and allowed to break
 * the section's top and bottom rules, so the hairlines read as a band the
 * device is passing through rather than a box it sits inside; that is the one
 * piece of depth on an otherwise flat page, which is why it can afford to be
 * the only one. And the copy earns its claims with numbers the wallet can
 * actually show — 0 XLM, under a minute, no phrase — because every one of them
 * is checkable by installing it.
 *
 * The screen inside the phone is drawn, not screenshotted, so it cannot go
 * stale the way a PNG of a wallet does. It is drawn from the real dashboard
 * though, not invented: the silver balance card with Send and Receive inside
 * it, the Pay-for grid with Cash out live and the rest marked soon, the assets
 * row, the three-item activity feed, and the app's four actual tabs. A mockup
 * that shows controls the app does not have is worse than no mockup.
 */

import { motion, useReducedMotion } from 'framer-motion'
import type { Messages } from '@/lib/i18n'

const GOLD = '#FDDA24'
const TEAL = '#00A7B5'

const vp = { once: true, margin: '-80px' as const }

const fadeUp = {
  hidden: { opacity: 0, y: 26 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  },
}

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.09 } } }

/** The three claims, each one a thing you can check by installing it. */
const POINTS = [
  'No seed phrase to restore on a new phone',
  'Cash out to a Nigerian bank in under a minute',
  '0 XLM needed for your first transaction',
]

/**
 * The app, drawn rather than screenshotted.
 *
 * It has to track the shipping build or it quietly becomes a lie: the Pay-for
 * row, the asset list and the tab bar are what a new install actually shows,
 * including the raised centre action. A real screenshot would be easier and is
 * deliberately not used - the only ones we have carry a real address and a real
 * balance, and neither belongs on a public page.
 */
/**
 * The home screen as designed ("home v2 - silver card + center").
 *
 * Drawn, not screenshotted: the only real captures we have carry a real
 * address and a real balance, and neither belongs on a public page.
 *
 * This follows the design rather than the current build. The Pay-for grid is
 * the full eight tiles, several of which are still "soon" in the shipping app,
 * so if this section is ever used to claim those flows are live, the claim is
 * the thing to fix - not this file.
 */
function PhoneScreen() {
  return (
    <div className="flex h-full flex-col bg-[#0F0F0F] text-off-white">
      {/* header: wordmark, and the account chip in a gold outline */}
      <div className="flex items-center justify-between px-[11px] pb-[9px] pt-[15px]">
        <span className="flex items-center gap-[5px]">
          <span className="flex flex-col gap-[2px]" aria-hidden="true">
            <span className="block h-[1.5px] w-[9px] rounded-full" style={{ background: GOLD }} />
            <span className="block h-[1.5px] w-[6px] rounded-full" style={{ background: GOLD }} />
          </span>
          <span className="font-anton text-[10px] tracking-[0.16em]" style={{ color: GOLD }}>
            VEIL
          </span>
        </span>
        <span
          className="rounded-full px-[8px] py-[3px] font-mono text-[6px] tracking-wide"
          style={{ border: `1px solid ${GOLD}55`, color: GOLD }}
        >
          GDKF&hellip;9QX3
        </span>
      </div>

      {/* the silver card */}
      <div className="relative mx-[11px] overflow-hidden rounded-[14px] px-[11px] pb-[11px] pt-[9px] text-[#0F0F0F]">
        <div className="absolute inset-0 bg-gradient-to-br from-[#d8dade] via-[#fbfbfc] to-[#b9bcc2]" />
        {/* the diagonal sheen that makes it brushed metal and not grey paint */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(104deg, transparent 16%, rgba(255,255,255,0.72) 33%, transparent 50%)',
          }}
        />
        <div className="relative">
          <div className="flex items-start justify-between">
            <p className="text-[5.5px] font-semibold tracking-[0.2em] opacity-55">TOTAL BALANCE</p>
            <span className="flex flex-col gap-[1.5px]" aria-hidden="true">
              <span className="block h-[1.2px] w-[7px] rounded-full bg-[#0F0F0F]/45" />
              <span className="block h-[1.2px] w-[4px] rounded-full bg-[#0F0F0F]/45" />
            </span>
          </div>
          <p className="mt-[2px] font-lora text-[25px] font-semibold leading-none tracking-tight">
            &#8358;642,384<span className="text-[13px] opacity-45">.10</span>
          </p>
          <div className="mt-[5px] flex items-center justify-between">
            <p className="font-mono text-[6px] opacity-55">412.98 USDC &middot; earning 6.2%</p>
            <span
              className="rounded-full px-[6px] py-[2px] text-[6px] font-semibold text-off-white"
              style={{ background: TEAL }}
            >
              +&#8358;109.32 today
            </span>
          </div>
          <div className="mt-[9px] grid grid-cols-2 gap-[6px]">
            <span className="rounded-full bg-[#0F0F0F] py-[6px] text-center text-[7px] font-semibold text-off-white">
              &#8599; Send
            </span>
            <span className="rounded-full border border-[#0F0F0F]/30 py-[6px] text-center text-[7px] font-semibold">
              &#8601; Receive
            </span>
          </div>
        </div>
      </div>

      {/* pay for - the full grid, two rows of four */}
      <div className="mx-[11px] mt-[9px] rounded-[12px] border border-white/[0.05] bg-white/[0.025] px-[8px] pb-[8px] pt-[7px]">
        <p className="text-[5.5px] font-semibold tracking-[0.2em]" style={{ color: GOLD }}>
          PAY FOR
        </p>
        <div className="mt-[6px] grid grid-cols-4 gap-x-[4px] gap-y-[7px]">
          {[
            ['Airtime', 'All networks', false],
            ['Data', 'Bundles', false],
            ['Power', 'Prepaid', false],
            ['TV', 'DStv · GOtv', false],
            ['Bills', 'Water · waste', false],
            ['Transfer', 'To any bank', false],
            ['Betting', 'Top up', false],
            ['More', 'All services', true],
          ].map(([label, hint, accent]) => (
            <div key={label as string} className="text-center">
              <div
                className="mx-auto h-[14px] w-[14px] rounded-[5px]"
                style={{
                  background: accent ? 'rgba(253,218,36,0.16)' : 'rgba(255,255,255,0.055)',
                  border: accent
                    ? '1px solid rgba(253,218,36,0.32)'
                    : '1px solid rgba(255,255,255,0.06)',
                }}
              />
              <span
                className="mt-[3px] block text-[6px] font-semibold leading-tight"
                style={{ color: accent ? GOLD : 'rgba(246,247,248,0.9)' }}
              >
                {label}
              </span>
              <span className="block text-[4.5px] leading-tight opacity-35">{hint}</span>
            </div>
          ))}
        </div>
      </div>

      {/* activity */}
      <div className="mx-[11px] mt-[9px] rounded-[12px] border border-white/[0.05] bg-white/[0.025] px-[9px] pb-[9px] pt-[7px]">
        <div className="flex items-baseline justify-between">
          <p className="text-[5.5px] font-semibold tracking-[0.2em]" style={{ color: GOLD }}>
            ACTIVITY
          </p>
          <span className="text-[5px] opacity-40">See all</span>
        </div>
        {[
          ['MTN Airtime', '0803 123 4567 · 2h', '−₦2,000', false],
          ['Yield earned', 'Blend USDC pool · today', '+₦109.32', true],
        ].map(([title, sub, amount, isIn]) => (
          <div key={title as string} className="mt-[7px] flex items-start justify-between">
            <span>
              <span className="block text-[7px] font-semibold leading-tight">{title}</span>
              <span className="mt-[1px] block font-mono text-[5px] opacity-35">{sub}</span>
            </span>
            <span
              className="font-mono text-[7px] font-semibold"
              style={{ color: isIn ? TEAL : 'rgba(246,247,248,0.92)' }}
            >
              {amount}
            </span>
          </div>
        ))}
      </div>

      <div className="flex-1" />

      {/* the tab bar, with the raised centre action */}
      <div className="mx-[11px] mb-[10px] mt-[9px] flex items-end justify-around rounded-full border border-white/[0.06] bg-white/[0.04] px-[6px] pb-[6px] pt-[7px]">
        {['Home', 'Earn'].map((tab, i) => (
          <span
            key={tab}
            className="text-[5px]"
            style={{ color: i === 0 ? GOLD : 'rgba(246,247,248,0.35)' }}
          >
            {tab}
          </span>
        ))}
        <span className="-mt-[15px] flex flex-col items-center">
          <span
            className="flex h-[24px] w-[24px] items-center justify-center rounded-full text-[14px] font-light leading-none text-[#0F0F0F]"
            style={{ background: GOLD, boxShadow: '0 5px 14px rgba(253,218,36,0.4)' }}
          >
            +
          </span>
        </span>
        {['Agent', 'Settings'].map((tab) => (
          <span key={tab} className="text-[5px]" style={{ color: 'rgba(246,247,248,0.35)' }}>
            {tab}
          </span>
        ))}
      </div>
    </div>
  )
}

export function MobileIsLive({ t }: { t: Messages }) {
  const reduced = useReducedMotion()
  const copy = (t as Messages & { mobileLive?: Record<string, string> }).mobileLive

  return (
    <section
      id="mobile"
      className="relative overflow-hidden border-y border-white/[0.07] bg-near-black"
      aria-labelledby="mobile-live-heading"
    >
      {/* One warm bloom behind the device, so the tilt reads as lit rather than
          pasted. Kept well under the text so nothing loses contrast. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute right-[-10%] top-1/2 hidden h-[620px] w-[620px] -translate-y-1/2 rounded-full lg:block"
        style={{ background: 'radial-gradient(circle, rgba(253,218,36,0.09) 0%, transparent 68%)' }}
      />

      <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-6 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:py-28">
        <motion.div
          variants={stagger}
          initial="hidden"
          whileInView="show"
          viewport={vp}
          className="relative z-10"
        >
          <motion.span
            variants={fadeUp}
            className="inline-flex items-center gap-2 rounded-full px-3 py-[6px] text-[11px] font-semibold tracking-[0.14em]"
            style={{ background: 'rgba(0,167,181,0.12)', border: '1px solid rgba(0,167,181,0.3)', color: TEAL }}
          >
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: TEAL }} />
            {copy?.badge ?? 'NOW SHIPPING'}
          </motion.span>

          <motion.h2
            id="mobile-live-heading"
            variants={fadeUp}
            className="mt-6 font-lora text-[clamp(2.5rem,6vw,4rem)] font-semibold leading-[1.02] tracking-[-0.02em]"
          >
            {copy?.titleLead ?? 'Mobile is'}{' '}
            <em className="italic" style={{ color: GOLD }}>
              {copy?.titleAccent ?? 'live'}
            </em>
            .
          </motion.h2>

          <motion.p
            variants={fadeUp}
            className="mt-5 max-w-[46ch] text-[16px] leading-[1.65] text-warm-grey/75"
          >
            {copy?.body ??
              'The whole wallet in your pocket. Open it with the same fingerprint that opens your bank app, spend in naira, and keep earning on the balance you have not spent yet.'}
          </motion.p>

          <motion.ol variants={stagger} className="mt-8 space-y-[14px]">
            {(copy?.points ? (copy.points as unknown as string[]) : POINTS).map((point, i) => (
              <motion.li key={point} variants={fadeUp} className="flex items-baseline gap-3">
                <span
                  className="font-mono text-[11px] font-semibold tabular-nums"
                  style={{ color: GOLD }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="text-[15px] leading-[1.5] text-off-white/85">{point}</span>
              </motion.li>
            ))}
          </motion.ol>

          <motion.div variants={fadeUp} className="mt-10 flex flex-wrap items-center gap-4">
            <a
              href="/app"
              className="inline-flex items-center gap-2 rounded-full px-6 py-[14px] text-[14px] font-semibold text-near-black transition-transform hover:scale-[1.02]"
              style={{ background: GOLD }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {copy?.ctaPrimary ?? 'Download for Android'}
            </a>

            {/* Stated, not implied. An App Store badge that opens nothing is a
                worse first impression than an honest line of text. */}
            <span className="text-[13px] text-warm-grey/45">
              {copy?.ctaSecondary ?? 'iPhone: join the TestFlight list'}
            </span>
          </motion.div>

          <motion.div variants={fadeUp} className="mt-8 flex items-center gap-4">
            <div className="rounded-lg bg-off-white p-[6px]">
              <QrGlyph />
            </div>
            <p className="text-[12.5px] leading-[1.5] text-warm-grey/55">
              {copy?.qrLabel ?? 'Scan to install'}
              <br />
              <span className="font-mono text-[11.5px] text-warm-grey/40">useveilapp.xyz/app</span>
            </p>
          </motion.div>
        </motion.div>

        {/* The device. Tilted, and deliberately taller than its grid cell so it
            crosses both hairlines — the section reads as a band it is passing
            through rather than a container it fits in. */}
        <motion.div
          initial={reduced ? undefined : { opacity: 0, y: 40, rotate: -4 }}
          whileInView={reduced ? undefined : { opacity: 1, y: 0, rotate: 0 }}
          viewport={vp}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          className="relative mx-auto w-[240px] sm:w-[268px] lg:mx-0 lg:ml-auto lg:w-[300px]"
          style={{ perspective: '1400px' }}
        >
          <div
            className="relative lg:-my-24"
            style={{
              // Head-on, as the design draws it. This used to carry an
              // 11-degree Y rotation, which threw the silver card's sheen off
              // its diagonal and squashed the right-hand column of the Pay-for
              // grid - the two things the design is actually about.
              transformStyle: 'preserve-3d',
              filter: 'drop-shadow(0 40px 70px rgba(0,0,0,0.6))',
            }}
          >
            {/* the buttons, so the slab reads as a device and not a card */}
            <div
              aria-hidden="true"
              className="absolute -left-[2px] top-[17%] h-[34px] w-[3px] rounded-l-sm bg-gradient-to-b from-[#3a3a3a] to-[#1d1d1d]"
            />
            <div
              aria-hidden="true"
              className="absolute -left-[2px] top-[26%] h-[52px] w-[3px] rounded-l-sm bg-gradient-to-b from-[#3a3a3a] to-[#1d1d1d]"
            />
            <div
              aria-hidden="true"
              className="absolute -right-[2px] top-[23%] h-[62px] w-[3px] rounded-r-sm bg-gradient-to-b from-[#3a3a3a] to-[#1d1d1d]"
            />

            {/* Two rings, not one: the outer is the polished rail and the inner
                the matte bezel under the glass. A single border reads flat at
                this size however dark you make it. */}
            <div className="rounded-[2.35rem] bg-gradient-to-b from-[#4a4a4d] via-[#232325] to-[#131314] p-[1.5px]">
              <div className="rounded-[2.28rem] bg-[#141415] p-[7px]">
                <div className="relative aspect-[9/17.2] overflow-hidden rounded-[1.85rem] bg-[#0F0F0F]">
                  {/* notch */}
                  <div className="absolute left-1/2 top-[7px] z-20 h-[13px] w-[62px] -translate-x-1/2 rounded-full bg-black" />
                  <PhoneScreen />
                  {/* glass: one soft diagonal wipe across the screen itself, so
                      the UI sits behind something rather than being printed on
                      the front of the case. */}
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 z-10"
                    style={{
                      background:
                        'linear-gradient(118deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 22%, transparent 46%)',
                    }}
                  />
                </div>
              </div>
            </div>
            {/* a single specular edge, so the slab has a direction of light */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-[2.2rem]"
              style={{
                background:
                  'linear-gradient(115deg, rgba(255,255,255,0.16) 0%, transparent 34%, transparent 100%)',
              }}
            />
          </div>
        </motion.div>
      </div>
    </section>
  )
}

/**
 * The QR beside "Scan to install", encoding https://useveilapp.xyz/app.
 *
 * This used to be a hand-written pattern with a comment saying the real code
 * was generated at `/app` - a route that did not exist. It looked like a QR
 * and decoded to nothing, which is worse than no QR at all: the label promises
 * an install and the camera just sits there.
 *
 * The content is a constant, so the matrix is generated once (qrcode.react,
 * version 2, error correction M) and inlined rather than pulling an encoder
 * into the bundle to re-derive the same 25x25 grid on every render. Regenerate
 * it if the URL ever changes - it is not editable by hand.
 */
function QrGlyph() {
  return (
    <svg
      width="62"
      height="62"
      viewBox="0 0 25 25"
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code to useveilapp.xyz/app"
    >
      <rect width="25" height="25" fill="#F6F7F8" />
      <path d="M0 0h7v1H0zM11 0h1v1H11zM13 0h1v1H13zM18,0 h7v1H18zM0 1h1v1H0zM6 1h1v1H6zM8 1h2v1H8zM11 1h2v1H11zM18 1h1v1H18zM24,1 h1v1H24zM0 2h1v1H0zM2 2h3v1H2zM6 2h1v1H6zM8 2h1v1H8zM12 2h1v1H12zM15 2h1v1H15zM18 2h1v1H18zM20 2h3v1H20zM24,2 h1v1H24zM0 3h1v1H0zM2 3h3v1H2zM6 3h1v1H6zM8 3h1v1H8zM11 3h1v1H11zM13 3h2v1H13zM18 3h1v1H18zM20 3h3v1H20zM24,3 h1v1H24zM0 4h1v1H0zM2 4h3v1H2zM6 4h1v1H6zM9 4h1v1H9zM12 4h2v1H12zM16 4h1v1H16zM18 4h1v1H18zM20 4h3v1H20zM24,4 h1v1H24zM0 5h1v1H0zM6 5h1v1H6zM9 5h3v1H9zM13 5h2v1H13zM16 5h1v1H16zM18 5h1v1H18zM24,5 h1v1H24zM0 6h7v1H0zM8 6h1v1H8zM10 6h1v1H10zM12 6h1v1H12zM14 6h1v1H14zM16 6h1v1H16zM18,6 h7v1H18zM8 7h4v1H8zM0 8h1v1H0zM6 8h1v1H6zM8 8h1v1H8zM10 8h6v1H10zM17 8h2v1H17zM21 8h3v1H21zM1 9h4v1H1zM7 9h1v1H7zM10 9h1v1H10zM12 9h2v1H12zM15 9h1v1H15zM17 9h1v1H17zM19 9h5v1H19zM1 10h8v1H1zM10 10h3v1H10zM15 10h1v1H15zM18 10h2v1H18zM21 10h1v1H21zM23,10 h2v1H23zM2 11h1v1H2zM4 11h2v1H4zM7 11h3v1H7zM12 11h1v1H12zM16 11h2v1H16zM19 11h1v1H19zM21 11h1v1H21zM24,11 h1v1H24zM0 12h3v1H0zM6 12h2v1H6zM9 12h4v1H9zM16 12h1v1H16zM18 12h1v1H18zM24,12 h1v1H24zM0 13h2v1H0zM3 13h3v1H3zM8 13h1v1H8zM12 13h5v1H12zM19 13h1v1H19zM23 13h1v1H23zM0 14h1v1H0zM2 14h2v1H2zM6 14h5v1H6zM12 14h1v1H12zM15 14h7v1H15zM23,14 h2v1H23zM0 15h1v1H0zM3 15h1v1H3zM5 15h1v1H5zM8 15h1v1H8zM10 15h1v1H10zM12 15h1v1H12zM16 15h4v1H16zM21 15h2v1H21zM24,15 h1v1H24zM0 16h1v1H0zM2 16h5v1H2zM9 16h2v1H9zM13 16h2v1H13zM16 16h5v1H16zM22 16h1v1H22zM8 17h1v1H8zM10 17h2v1H10zM13 17h2v1H13zM16 17h1v1H16zM20 17h1v1H20zM0 18h7v1H0zM10 18h3v1H10zM14 18h1v1H14zM16 18h1v1H16zM18 18h1v1H18zM20 18h1v1H20zM24,18 h1v1H24zM0 19h1v1H0zM6 19h1v1H6zM9 19h1v1H9zM12 19h1v1H12zM15 19h2v1H15zM20 19h1v1H20zM0 20h1v1H0zM2 20h3v1H2zM6 20h1v1H6zM9 20h2v1H9zM13 20h1v1H13zM15 20h6v1H15zM22 20h1v1H22zM0 21h1v1H0zM2 21h3v1H2zM6 21h1v1H6zM10 21h2v1H10zM13 21h6v1H13zM23,21 h2v1H23zM0 22h1v1H0zM2 22h3v1H2zM6 22h1v1H6zM9 22h1v1H9zM13 22h2v1H13zM17 22h1v1H17zM21 22h2v1H21zM24,22 h1v1H24zM0 23h1v1H0zM6 23h1v1H6zM12 23h1v1H12zM14 23h1v1H14zM16 23h5v1H16zM24,23 h1v1H24zM0 24h7v1H0zM8 24h5v1H8zM16 24h2v1H16zM21 24h1v1H21zM24,24 h1v1H24z" fill="#0F0F0F" />
    </svg>
  )
}

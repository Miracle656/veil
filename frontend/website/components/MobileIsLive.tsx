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

function PhoneScreen() {
  return (
    <div className="flex h-full flex-col bg-[#0F0F0F] text-off-white">
      {/* header: wordmark + the address chip the app actually shows */}
      <div className="flex items-center justify-between px-3 pt-4 pb-3">
        <span className="font-anton text-[10px] tracking-[0.16em]" style={{ color: GOLD }}>
          VEIL
        </span>
        <span
          className="rounded-full px-[7px] py-[3px] font-mono text-[6px] tracking-wide"
          style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(246,247,248,0.55)' }}
        >
          C4B3…9QX3
        </span>
      </div>

      {/* the silver balance card, Send and Receive inside it as in the app */}
      <div className="mx-3 rounded-[18px] bg-gradient-to-br from-[#e9eaec] via-[#fbfbfc] to-[#c2c5ca] px-3 pb-3 pt-[10px] text-[#0F0F0F]">
        <p className="text-[6px] font-semibold tracking-[0.18em] opacity-50">TOTAL BALANCE</p>
        <p className="mt-[3px] font-lora text-[23px] font-semibold leading-none tracking-tight">
          ₦642,268
        </p>
        <p className="mt-[3px] font-mono text-[6.5px] opacity-55">412.98 USDC · earning 6.2%</p>
        <div className="mt-[10px] grid grid-cols-2 gap-[6px]">
          <span className="rounded-full bg-[#0F0F0F] py-[5px] text-center text-[7px] font-semibold text-off-white">
            Send
          </span>
          <span className="rounded-full border border-[#0F0F0F]/25 py-[5px] text-center text-[7px] font-semibold">
            Receive
          </span>
        </div>
      </div>

      {/* pay for — Cash out is the live one, the rest are marked soon */}
      <p className="mt-4 px-3 text-[6px] font-semibold tracking-[0.18em] opacity-40">PAY FOR</p>
      <div className="mt-[6px] grid grid-cols-4 gap-[5px] px-3">
        {[
          ['Cash out', 'To any bank', true],
          ['Airtime', 'All networks', false],
          ['Data', 'Bundles', false],
          ['TV', 'DStv', false],
        ].map(([label, hint, live]) => (
          <div
            key={label as string}
            className="rounded-[10px] border px-[4px] py-[6px] text-center"
            style={{
              borderColor: live ? 'rgba(253,218,36,0.32)' : 'rgba(255,255,255,0.07)',
              background: live ? 'rgba(253,218,36,0.07)' : 'rgba(255,255,255,0.03)',
            }}
          >
            <span
              className="block text-[7px] font-semibold leading-tight"
              style={{ color: live ? GOLD : 'rgba(246,247,248,0.8)' }}
            >
              {label}
            </span>
            <span className="mt-[1px] block text-[5px] leading-tight opacity-40">{hint}</span>
          </div>
        ))}
      </div>

      {/* assets */}
      <p className="mt-4 px-3 text-[6px] font-semibold tracking-[0.18em] opacity-40">ASSETS</p>
      <div className="mx-3 mt-[6px] flex items-center justify-between rounded-[12px] border border-white/[0.06] bg-white/[0.03] px-[10px] py-[7px]">
        <span className="flex items-center gap-[6px]">
          <span
            className="flex h-[15px] w-[15px] items-center justify-center rounded-full text-[7px] font-bold"
            style={{ background: 'rgba(0,167,181,0.18)', color: TEAL }}
          >
            $
          </span>
          <span>
            <span className="block text-[7.5px] font-semibold leading-tight">USDC</span>
            <span className="block font-mono text-[5.5px] opacity-45">412.98</span>
          </span>
        </span>
        <span className="text-[7.5px] font-semibold">₦642,268</span>
      </div>

      {/* activity */}
      <div className="mt-4 flex items-baseline justify-between px-3">
        <span className="text-[6px] font-semibold tracking-[0.18em] opacity-40">ACTIVITY</span>
        <span className="text-[5.5px]" style={{ color: GOLD }}>
          See all →
        </span>
      </div>
      <div className="mt-[6px] flex-1 space-y-[9px] px-3">
        {[
          ['Cashed out', 'Kuda · 2683', '−₦61,240', false],
          ['Sent', 'GBQ4…TSK4', '−₦2,000', false],
          ['Received', 'drips.network', '+₦640,430', true],
        ].map(([title, sub, amt, isIn]) => (
          <div key={title as string} className="flex items-start justify-between">
            <span>
              <span className="block text-[7.5px] font-medium leading-tight">{title}</span>
              <span className="block font-mono text-[5.5px] opacity-40">{sub}</span>
            </span>
            <span
              className="text-[7.5px] font-semibold"
              style={{ color: isIn ? TEAL : 'rgba(246,247,248,0.9)' }}
            >
              {amt}
            </span>
          </div>
        ))}
      </div>

      {/* the app's four tabs */}
      <div className="mt-3 flex items-center justify-around border-t border-white/[0.07] px-2 py-[7px]">
        {['Home', 'Earn', 'Agent', 'Settings'].map((tab, i) => (
          <span
            key={tab}
            className="text-[6px]"
            style={{ color: i === 0 ? GOLD : 'rgba(246,247,248,0.35)' }}
          >
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
              transform: 'rotateZ(-7deg) rotateY(11deg) rotateX(3deg)',
              transformStyle: 'preserve-3d',
              filter: 'drop-shadow(0 40px 70px rgba(0,0,0,0.6))',
            }}
          >
            <div className="rounded-[2.2rem] border border-white/[0.14] bg-[#1a1a1a] p-[9px]">
              <div className="relative aspect-[9/19.2] overflow-hidden rounded-[1.75rem] bg-[#0F0F0F]">
                {/* notch */}
                <div className="absolute left-1/2 top-[7px] z-10 h-[14px] w-[74px] -translate-x-1/2 rounded-full bg-black" />
                <PhoneScreen />
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

/** A decorative QR block. The real code is generated at the /app route. */
function QrGlyph() {
  const cells = [
    '1111111010001111111', '1000001011101000001', '1011101000101011101',
    '1011101011001011101', '1011101010101011101', '1000001001001000001',
    '1111111010101111111', '0000000011100000000', '1101011101011010110',
    '0100110010110101001', '1110001110001110111', '0101100101101001010',
    '1011011011010110101', '0000000110101101100', '1111111001010110101',
    '1000001010110101011', '1011101011010110100', '1011101001101011011',
    '1111111010110100101',
  ]
  return (
    <svg width="62" height="62" viewBox="0 0 19 19" shapeRendering="crispEdges" aria-hidden="true">
      <rect width="19" height="19" fill="#F6F7F8" />
      {cells.map((row, y) =>
        row.split('').map((c, x) =>
          c === '1' ? <rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#0F0F0F" /> : null,
        ),
      )}
    </svg>
  )
}

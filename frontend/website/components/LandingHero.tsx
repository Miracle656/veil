import Link from 'next/link'

import type { Messages } from '@/lib/i18n'
import { useRegionalCurrency, type RegionalAmounts } from '@/lib/regionalCurrency'

/**
 * Landing hero — centred statement over a collage of the approved mobile screens.
 *
 * The screens are ported from the Claude Design landing file, so the site shows
 * what the app actually looks like. That file's sharp badge, square CTAs and
 * corner brackets are deliberately NOT carried over: Veil is a rounded system,
 * and its phones are rounded too (44-50px shells, 14-20px inner cards) — only the
 * chrome around them was boxy.
 *
 * Responsiveness here is composition, not scaling. A phone mock shrinks badly:
 * past a point the type inside stops being legible and it reads as a blurry
 * sticker. So the collage adds devices as room appears — one on a phone, two on a
 * tablet, three on a desktop — rather than squeezing three into 360px.
 */

function Mark({ size = 19, color = '#FDDA24' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true">
      <rect x="22" y="26" width="52" height="12" rx="6" fill={color} />
      <rect x="28" y="44" width="40" height="12" rx="6" fill={color} opacity="0.5" />
      <rect x="34" y="62" width="28" height="12" rx="6" fill={color} opacity="0.22" />
    </svg>
  )
}

function Phone({
  children,
  tall,
  className = '',
}: {
  children: React.ReactNode
  tall?: boolean
  className?: string
}) {
  return (
    <div
      aria-hidden="true"
      className={`shrink-0 overflow-hidden bg-near-black box-border border-[#1c1c1e] ${
        tall
          ? 'w-[288px] sm:w-[310px] lg:w-[330px] h-[588px] sm:h-[634px] lg:h-[672px] rounded-[46px] lg:rounded-[50px] border-[9px] lg:border-[10px] shadow-[0_34px_90px_rgba(0,0,0,0.72)]'
          : 'w-[276px] lg:w-[296px] h-[550px] lg:h-[590px] rounded-[42px] lg:rounded-[44px] border-[9px] shadow-[0_24px_60px_rgba(0,0,0,0.6)]'
      } ${className}`}
    >
      <div className="flex flex-col h-full px-[18px] pt-[26px] pb-[22px]">{children}</div>
    </div>
  )
}

const LABEL = 'text-[9px] tracking-[0.14em] uppercase text-off-white/40 font-bold'
const FIELD = 'bg-white/[0.04] border border-white/[0.08] rounded-[14px]'

function SendScreen({ amounts }: { amounts: RegionalAmounts }) {
  return (
    <>
      <div className="flex items-center gap-[11px]">
        <span className="w-[30px] h-[30px] rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center text-off-white/70 text-[13px]">
          &lsaquo;
        </span>
        <span className="font-lora italic font-normal text-[22px]">Send</span>
      </div>

      <div className={`${LABEL} mt-5`}>Asset</div>
      <div className={`${FIELD} px-[13px] py-[10px] mt-[7px] flex justify-between items-center`}>
        <span className="flex items-center gap-[10px]">
          <span className="w-[28px] h-[28px] rounded-full bg-teal/15 border border-teal/35 flex items-center justify-center text-[12px] text-teal font-bold">
            $
          </span>
          <span className="flex flex-col gap-px">
            <span className="font-semibold text-[13px]">USDC</span>
            <span className="font-mono text-[10px] text-off-white/45">412.98 available</span>
          </span>
        </span>
        <span className="text-off-white/40 text-[11px]">▾</span>
      </div>

      <div className={`${LABEL} mt-4`}>Amount</div>
      <div className={`${FIELD} px-[13px] pt-[18px] pb-3 mt-[7px] flex flex-col items-center`}>
        <span className="font-lora italic font-normal text-[38px] leading-none">{amounts.transfer}</span>
        <span className="font-mono text-[11px] text-off-white/50 mt-[7px]">≈ 16.08 USDC</span>
        <span className="text-[10px] text-off-white/45 mt-[11px]">Balance {amounts.balance}</span>
        <span className="flex gap-[5px] flex-wrap justify-center mt-2">
          {amounts.chips.map((c, i) => (
            <span
              key={c}
              className={`rounded-pill px-[9px] py-[4px] text-[9px] font-semibold border ${
                i === 2
                  ? 'border-gold/40 bg-gold/[0.08] text-gold'
                  : 'border-white/10 text-off-white/60'
              }`}
            >
              {c}
            </span>
          ))}
        </span>
      </div>

      <div className={`${LABEL} mt-4`}>To</div>
      <div className={`${FIELD} px-[13px] py-[11px] mt-[7px] flex justify-between items-center`}>
        <span className="font-mono text-[13px]">alice*veil.xyz</span>
        <span className="flex gap-[6px] shrink-0">
          {['◫', '⌗'].map((i) => (
            <span
              key={i}
              className="w-[24px] h-[24px] rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center text-[11px] text-off-white/60"
            >
              {i}
            </span>
          ))}
        </span>
      </div>

      <div className="flex justify-between mt-[14px] px-[3px]">
        <span className="text-[11px] text-off-white/45">Network fee</span>
        <span className="text-[11px] text-teal">Sponsored</span>
      </div>

      <div className="flex-1" />
      <div className="bg-gold text-near-black rounded-pill py-[13px] text-center font-semibold text-[12px]">
        ⬡ Review &amp; sign
      </div>
    </>
  )
}

function HomeScreen({ amounts }: { amounts: RegionalAmounts }) {
  const balanceDot = amounts.balance.lastIndexOf('.')
  const balanceMain = balanceDot >= 0 ? amounts.balance.slice(0, balanceDot) : amounts.balance
  const balanceDec = balanceDot >= 0 ? amounts.balance.slice(balanceDot) : null

  return (
    <>
      <div className="flex justify-between items-center px-[5px]">
        <span className="flex items-center gap-2">
          <Mark size={19} />
          <span className="font-anton text-[13px] tracking-[0.08em] text-gold">VEIL</span>
        </span>
        <span className="font-mono text-[11px] text-gold bg-gold/[0.08] border border-gold/[0.18] rounded-pill px-[11px] py-[4px]">
          GDKF…9QX3
        </span>
      </div>

      <div
        className="relative overflow-hidden rounded-[20px] px-[18px] py-[20px] mt-4 text-near-black"
        style={{
          background:
            'linear-gradient(135deg,#3a3d42 0%,#8f959c 22%,#e8ebee 38%,#9aa0a7 52%,#5c6066 70%,#caced3 88%,#75797f 100%)',
        }}
      >
        <div
          className="absolute inset-0"
          style={{ background: 'linear-gradient(105deg,transparent 38%,rgba(255,255,255,0.55) 46%,transparent 55%)' }}
        />
        <div className="relative flex justify-between items-start">
          <span className="text-[9px] tracking-[0.14em] uppercase font-bold text-near-black/55">
            Total balance
          </span>
          <Mark size={21} color="#0F0F0F" />
        </div>
        <div className="relative font-lora italic font-normal text-[35px] leading-[1.1] mt-[11px]">
          {balanceMain}
          {balanceDec && <span className="text-[17px] text-near-black/45">{balanceDec}</span>}
        </div>
        <div className="relative flex justify-between items-center mt-[13px] gap-2">
          <span className="font-mono text-[10px] text-near-black/60">412.98 USDC</span>
          <span className="bg-near-black/85 text-[#00e0f0] rounded-pill px-[9px] py-[3px] text-[9px] font-semibold shrink-0">
            +{amounts.dailyYield}
          </span>
        </div>
        <div className="relative flex gap-2 mt-[14px]">
          <span className="flex-1 bg-near-black text-gold rounded-pill py-[9px] text-center font-semibold text-[11px]">
            ↗ Send
          </span>
          <span className="flex-1 border-[1.5px] border-near-black/55 rounded-pill py-2 text-center font-semibold text-[11px]">
            ↙ Receive
          </span>
        </div>
      </div>

      <div className="bg-white/[0.03] border border-white/[0.08] rounded-[16px] px-[14px] py-1 mt-[11px]">
        <div className="text-[9px] font-bold tracking-[0.14em] uppercase text-gold pt-[9px] pb-[2px]">
          Pay for
        </div>
        <div className="grid grid-cols-4">
          {[
            ['Airtime', 'Networks'], ['Data', 'Bundles'], ['Power', 'Prepaid'], ['TV', 'DStv'],
            ['Bills', 'Water'], ['Transfer', 'Banks'], ['Betting', 'Top up'], ['More', 'All'],
          ].map(([n, s], i) => (
            <div
              key={n}
              className={`py-[9px] flex flex-col gap-[2px] ${i > 3 ? 'border-t border-white/[0.06]' : ''}`}
            >
              <span className={`text-[11px] font-medium ${n === 'More' ? 'text-gold' : ''}`}>{n}</span>
              <span className="text-[8px] text-off-white/40">{s}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bg-white/[0.03] border border-white/[0.08] rounded-[16px] px-[14px] py-1 mt-[9px]">
        <div className="text-[9px] font-bold tracking-[0.14em] uppercase text-gold pt-[9px] pb-px">Assets</div>
        {[
          { code: 'USDC', sub: 'Stablecoin', amt: '412.98', glyph: '$', teal: true },
          { code: 'XLM', sub: 'Stellar Lumens', amt: '100.00', glyph: '✦', teal: false },
        ].map((a, i) => (
          <div
            key={a.code}
            className={`flex justify-between items-center py-[10px] ${i === 0 ? 'border-b border-white/[0.06]' : ''}`}
          >
            <span className="flex items-center gap-[9px]">
              <span
                className={`w-[28px] h-[28px] rounded-full flex items-center justify-center font-bold text-[11px] ${
                  a.teal ? 'bg-teal/15 border border-teal/35 text-teal' : 'bg-gold/10 border border-gold/30 text-gold'
                }`}
              >
                {a.glyph}
              </span>
              <span className="flex flex-col gap-px">
                <span className="text-[11px] font-semibold">{a.code}</span>
                <span className="text-[8px] text-off-white/45">{a.sub}</span>
              </span>
            </span>
            <span className="font-mono text-[11px] shrink-0">{a.amt}</span>
          </div>
        ))}
      </div>

      <div className="flex-1" />
      <div className="relative bg-white/[0.06] border border-white/10 rounded-[22px] px-5 py-[10px] flex justify-between items-center mt-[10px]">
        {[
          { icon: '⌂', label: 'Home', on: true },
          { icon: '◎', label: 'Earn', on: false },
          null,
          { icon: '✦', label: 'Agent', on: false },
          { icon: '⚙', label: 'Settings', on: false },
        ].map((tab, i) =>
          tab ? (
            <span key={tab.label} className="flex flex-col items-center gap-[2px] w-[42px]">
              <span className={`text-[14px] ${tab.on ? 'text-gold' : 'text-off-white/45'}`}>{tab.icon}</span>
              <span className={`text-[8px] ${tab.on ? 'text-gold font-semibold' : 'text-off-white/45'}`}>
                {tab.label}
              </span>
            </span>
          ) : (
            <span
              key={`fab-${i}`}
              className="w-[50px] h-[50px] rounded-full bg-gold text-near-black flex items-center justify-center text-[24px] -mt-7 shadow-[0_8px_20px_rgba(253,218,36,0.35)]"
            >
              +
            </span>
          ),
        )}
      </div>
    </>
  )
}

function ConfirmScreen({ amounts }: { amounts: RegionalAmounts }) {
  return (
    <>
      <div className={LABEL}>Confirm transfer</div>
      <div className="font-lora italic font-normal text-[42px] mt-[11px]">{amounts.transfer}</div>
      <div className="font-mono text-[12px] text-off-white/50 mt-[5px]">To alice*veil.xyz</div>

      <div className="w-full mt-[30px] flex flex-col">
        {[
          ['They receive', amounts.transfer],
          ['Debited', '16.08 USDC'],
          ['Network fee', 'Sponsored'],
        ].map(([k, v], i) => (
          <div
            key={k}
            className={`flex justify-between py-3 border-t border-white/[0.08] ${i === 2 ? 'border-b' : ''}`}
          >
            <span className="text-[11px] text-off-white/45">{k}</span>
            <span className={`text-[11px] ${v === 'Sponsored' ? 'text-teal' : 'font-mono'}`}>{v}</span>
          </div>
        ))}
      </div>

      <div className="flex-1" />
      <div className="relative w-full h-[54px] rounded-pill border border-gold/35 bg-gold/[0.05] flex items-center justify-center overflow-hidden">
        <span className="absolute left-0 top-0 bottom-0 w-[112px] bg-gold/[0.13]" />
        <span className="absolute left-[4px] top-[3px] w-[46px] h-[46px] rounded-full bg-gold text-near-black flex items-center justify-center text-[18px] font-bold">
          »
        </span>
        <span className="relative font-mono text-[12px] tracking-[0.08em] text-off-white/45">
          SLIDE TO CONFIRM
        </span>
      </div>
      <div className="text-[10px] text-off-white/40 mt-3 text-center">Then confirm with your passkey.</div>
    </>
  )
}

export function LandingHero({ t }: { t: Messages }) {
  const copy = t.heroNew
  const amounts = useRegionalCurrency()

  return (
    <section className="relative bg-near-black overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(70% 50% at 50% 30%, rgba(253,218,36,0.13) 0%, rgba(253,218,36,0.04) 42%, transparent 72%)',
        }}
      />

      <div className="relative flex flex-col items-center text-center px-5 sm:px-8 lg:px-14 pt-28 sm:pt-32 lg:pt-36">
        <h1 className="font-lora italic font-normal text-off-white mt-0 text-[clamp(2.3rem,6.4vw,5.4rem)] leading-[1.06] tracking-[-0.02em]">
          {copy.line1}
          <br />
          {copy.line2}
          <br />
          <span className="text-gold">{copy.line3}</span>
        </h1>

        <p className="font-inter text-[15.5px] sm:text-[17px] leading-[1.75] text-off-white/60 mt-6 sm:mt-7 max-w-[600px]">
          {copy.body}
        </p>

        <div className="flex flex-wrap justify-center gap-3 sm:gap-4 mt-8 sm:mt-10">
          <Link
            href="https://app.useveilapp.xyz"
            className="bg-gold text-near-black font-semibold text-[15px] rounded-pill px-7 py-[14px] transition-transform duration-200 ease-stellar hover:-translate-y-[1px]"
          >
            {copy.cta1}
          </Link>
          <Link
            href="https://docs.useveilapp.xyz"
            className="border border-white/15 bg-white/[0.04] text-off-white font-semibold text-[15px] rounded-pill px-7 py-[14px] transition-colors duration-200 hover:border-white/30"
          >
            {copy.cta2}
          </Link>
        </div>

        <dl className="flex flex-wrap justify-center gap-x-10 sm:gap-x-16 gap-y-6 mt-12 sm:mt-14 pt-10 border-t border-white/10 w-full max-w-[720px]">
          {copy.metrics.map((m) => (
            <div key={m.label} className="flex flex-col gap-[6px]">
              <dt className="sr-only">{m.label}</dt>
              <dd className="font-lora italic font-normal text-[28px] sm:text-[32px] leading-none text-off-white">
                {m.value.includes('{sym}') ? m.value.replace('{sym}', amounts.symbol) : m.value}
              </dd>
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-off-white/45 whitespace-nowrap">
                {m.label}
              </span>
            </div>
          ))}
        </dl>
      </div>

      {/* Collage: devices appear as room allows rather than being scaled down. */}
      <div className="relative flex justify-center items-end gap-5 lg:gap-6 mt-16 sm:mt-20 px-5 sm:px-8 lg:px-14 pb-4">
        <Phone className="hidden xl:flex">
          <SendScreen amounts={amounts} />
        </Phone>
        <Phone tall>
          <HomeScreen amounts={amounts} />
        </Phone>
        <Phone className="hidden md:flex">
          <ConfirmScreen amounts={amounts} />
        </Phone>
      </div>
    </section>
  )
}

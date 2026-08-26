/**
 * Shared visual primitives for the revamped web wallet.
 *
 * Every value here is taken from the `Veil Web` design: 26px card radii, the
 * 11px/0.14em uppercase section labels, Lora italic for anything numeric or
 * headline, Inconsolata for addresses and machine values. The colour tokens
 * (gold, teal, lilac, surface, border-dim) already exist in tailwind.config.js,
 * so components reference those rather than re-declaring hex values.
 *
 * These are presentation only — no data fetching, no wallet logic — so a screen
 * can adopt the new look without touching the Stellar code underneath it.
 */
import Image from 'next/image'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

// ── Core wallet primitives ──────────────────────────────────────────────────

/** Shared route header for flows that need a back action and optional actions. */
export function Nav({
  title,
  onBack,
  actions,
}: {
  title?: ReactNode
  onBack?: () => void
  actions?: ReactNode
}) {
  return (
    <nav className="wallet-nav">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 border-0 bg-transparent text-sm text-off-white cursor-pointer"
        >
          <span aria-hidden="true">←</span>
          Back
        </button>
      ) : <span />}
      {title ? <div className="font-anton text-[1.25rem] tracking-[0.08em] text-gold">{title}</div> : null}
      <div className="flex items-center gap-2">{actions}</div>
    </nav>
  )
}

/** Anton uppercase metadata label used throughout wallet panels and forms. */
export function Label({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`font-anton text-xs uppercase tracking-[0.08em] text-[rgba(246,247,248,0.4)] ${className}`}>{children}</div>
}

/** Inconsolata value display for balances, addresses, and transaction amounts. */
export function Amount({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <span className={`font-mono whitespace-nowrap ${className}`}>{children}</span>
}

/** Consistent list row, optionally rendered as an accessible button. */
export function Row({
  children,
  onClick,
  last = false,
  className = '',
  ...buttonProps
}: {
  children: ReactNode
  onClick?: () => void
  last?: boolean
  className?: string
} & Pick<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'title'>) {
  const classes = `flex w-full justify-between items-center py-3.5 text-left ${last ? '' : 'border-b border-[rgba(255,255,255,0.06)]'} ${onClick ? 'cursor-pointer' : ''} ${className}`
  return onClick ? (
    <button type="button" onClick={onClick} className={`border-x-0 border-t-0 bg-transparent ${classes}`} {...buttonProps}>{children}</button>
  ) : (
    <div className={classes}>{children}</div>
  )
}

const TOKEN_LOGOS: Record<string, string> = {
  XLM: '/tokens/xlm.png',
  USDC: '/tokens/usdc.png',
}

/** Circular token mark with a branded image or a token-code fallback. */
export function TokenIcon({ code, size = 32 }: { code: string; size?: number }) {
  const normalized = code.toUpperCase()
  const src = TOKEN_LOGOS[normalized]
  if (src) {
    return (
      <div className="rounded-full overflow-hidden shrink-0 flex items-center justify-center" style={{ width: size, height: size, background: normalized === 'XLM' ? 'var(--near-black)' : 'transparent' }}>
        <Image src={src} alt={code} width={size} height={size} className="object-contain" style={normalized === 'XLM' ? { filter: 'invert(1)', padding: 4 } : undefined} />
      </div>
    )
  }
  return (
    <div className="rounded-full shrink-0 flex items-center justify-center font-bold text-gold" style={{ width: size, height: size, background: 'rgba(253,218,36,0.12)', border: '1px solid rgba(253,218,36,0.2)', fontSize: size * 0.38 }}>
      {normalized[0]}
    </div>
  )
}

// ── Surfaces ─────────────────────────────────────────────────────────────────

/** The standard raised panel: translucent surface, hairline border, 26px radius. */
export function Card({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode
  className?: string
  /** Set false when the card supplies its own padding (e.g. list cards). */
  padded?: boolean
}) {
  return (
    <div
      className={`bg-surface border border-border-dim rounded-[26px] ${padded ? 'px-7 py-6' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

/**
 * A card tinted toward one of the accent colours — used for the Earn (teal) and
 * Agent (lilac) panels, where the tint carries meaning rather than decoration.
 */
export function AccentCard({
  tone,
  children,
  className = '',
}: {
  tone: 'teal' | 'lilac' | 'gold'
  children: ReactNode
  className?: string
}) {
  const tones = {
    teal: 'bg-[rgba(0,167,181,0.06)] border-[rgba(0,167,181,0.22)]',
    lilac: 'bg-[rgba(183,172,232,0.06)] border-[rgba(183,172,232,0.22)]',
    gold: 'bg-[rgba(253,218,36,0.05)] border-[rgba(253,218,36,0.2)]',
  } as const
  return (
    <div className={`border rounded-[26px] px-7 py-6 ${tones[tone]} ${className}`}>{children}</div>
  )
}

// ── Labels and headings ──────────────────────────────────────────────────────

/** The small uppercase label that titles every card. Gold by default. */
export function SectionLabel({
  children,
  tone = 'gold',
  className = '',
}: {
  children: ReactNode
  tone?: 'gold' | 'teal' | 'lilac' | 'dim'
  className?: string
}) {
  const tones = {
    gold: 'text-gold',
    teal: 'text-teal',
    lilac: 'text-lilac',
    dim: 'text-[rgba(246,247,248,0.4)]',
  } as const
  return (
    <div
      className={`text-[11px] font-bold uppercase ${tones[tone]} ${className}`}
      style={{ letterSpacing: '0.14em' }}
    >
      {children}
    </div>
  )
}

/**
 * Page heading — a dim uppercase eyebrow above a Lora italic title. Every
 * screen in the design opens with this pair.
 */
export function PageHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string
  title: string
  /** Optional right-aligned controls, kept top-aligned with the title. */
  action?: ReactNode
}) {
  return (
    <div className="flex justify-between items-start">
      <div className="flex flex-col gap-[3px]">
        <SectionLabel tone="dim">{eyebrow}</SectionLabel>
        <h1 className="font-lora italic font-semibold text-[30px] text-off-white">{title}</h1>
      </div>
      {action ? <div className="flex items-center gap-[10px]">{action}</div> : null}
    </div>
  )
}

/** Lora italic, the design's voice for any number that matters. */
export function DisplayNumber({
  children,
  size = 44,
  tone = 'default',
  className = '',
}: {
  children: ReactNode
  size?: number
  tone?: 'default' | 'teal' | 'gold'
  className?: string
}) {
  const tones = { default: '', teal: 'text-teal', gold: 'text-gold' } as const
  return (
    <div
      className={`font-lora italic font-semibold leading-none whitespace-nowrap ${tones[tone]} ${className}`}
      style={{ fontSize: size }}
    >
      {children}
    </div>
  )
}

// ── Controls ─────────────────────────────────────────────────────────────────

/** Pill button. `primary` is the gold call to action; `ghost` is the outline. */
export function Pill({
  children,
  onClick,
  variant = 'ghost',
  disabled = false,
  className = '',
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'outline-gold'
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  const variants = {
    primary: 'bg-gold text-near-black font-semibold hover:brightness-95',
    ghost:
      'border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.04)] text-[rgba(246,247,248,0.72)] hover:bg-[rgba(255,255,255,0.08)]',
    'outline-gold':
      'border border-[rgba(253,218,36,0.35)] text-gold font-semibold hover:bg-[rgba(253,218,36,0.06)]',
  } as const
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`rounded-pill px-[22px] py-[10px] text-[13px] whitespace-nowrap transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  )
}

/** The full-width gold action that ends every signing flow. */
export function PrimaryAction({
  children,
  onClick,
  disabled = false,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full bg-gold text-near-black rounded-pill py-4 font-semibold text-[15px] flex items-center justify-center gap-[9px] transition-[filter] duration-200 hover:brightness-95 disabled:opacity-40 disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  )
}

/** The 42×24 gold toggle used for auto-earn and settings switches. */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean
  onChange: (next: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className="relative w-[42px] h-6 rounded-pill shrink-0 transition-colors duration-200"
      style={{ background: on ? '#FDDA24' : 'rgba(255,255,255,0.15)' }}
    >
      <span
        className="absolute top-[3px] w-[18px] h-[18px] rounded-full bg-near-black transition-[left] duration-200"
        style={{ left: on ? 21 : 3 }}
      />
    </button>
  )
}

// ── Data display ─────────────────────────────────────────────────────────────

/** One of the three stat cards at the top of Earn. */
export function StatCard({
  label,
  value,
  sub,
  tone = 'gold',
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'gold' | 'teal'
}) {
  const body = (
    <>
      <SectionLabel tone={tone}>{label}</SectionLabel>
      <DisplayNumber size={44} tone={tone === 'teal' ? 'teal' : 'default'} className="mt-[14px]">
        {value}
      </DisplayNumber>
      {sub ? <div className="font-mono text-[13px] text-[rgba(246,247,248,0.5)] mt-[10px]">{sub}</div> : null}
    </>
  )
  // The teal variant is the tinted "earned" card; gold sits on the plain
  // surface. Branching rather than picking a component dynamically keeps the
  // required `tone` prop on AccentCard honest.
  return tone === 'teal' ? (
    <AccentCard tone="teal" className="flex-1">
      {body}
    </AccentCard>
  ) : (
    <Card className="flex-1">{body}</Card>
  )
}

/** A row in any of the design's list cards, with a hairline underneath. */
export function ListRow({
  children,
  onClick,
  last = false,
  className = '',
}: {
  children: ReactNode
  onClick?: () => void
  /** Suppresses the bottom hairline on the final row. */
  last?: boolean
  className?: string
}) {
  return (
    <div
      onClick={onClick}
      className={`flex justify-between items-center py-4 ${
        last ? '' : 'border-b border-[rgba(255,255,255,0.06)]'
      } ${onClick ? 'cursor-pointer' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

/** Small status/tag chip — "earning", "native", "locked", "Active". */
export function Tag({
  children,
  tone = 'dim',
}: {
  children: ReactNode
  tone?: 'teal' | 'gold' | 'lilac' | 'dim'
}) {
  const tones = {
    teal: 'text-teal bg-[rgba(0,167,181,0.12)]',
    gold: 'text-gold bg-[rgba(253,218,36,0.1)]',
    lilac: 'text-lilac bg-[rgba(183,172,232,0.12)]',
    dim: 'text-[rgba(246,247,248,0.6)] bg-[rgba(255,255,255,0.06)]',
  } as const
  return (
    <span
      className={`text-[10px] font-semibold uppercase rounded-pill px-2 py-[2px] whitespace-nowrap ${tones[tone]}`}
      style={{ letterSpacing: '0.08em' }}
    >
      {children}
    </span>
  )
}

/** Circular asset/contact avatar carrying a glyph or initial. */
export function Glyph({
  children,
  tone,
  size = 38,
}: {
  children: ReactNode
  tone: 'teal' | 'gold' | 'lilac'
  size?: number
}) {
  const tones = {
    teal: { bg: 'rgba(0,167,181,0.14)', bd: 'rgba(0,167,181,0.35)', fg: '#00A7B5' },
    gold: { bg: 'rgba(253,218,36,0.1)', bd: 'rgba(253,218,36,0.3)', fg: '#FDDA24' },
    lilac: { bg: 'rgba(183,172,232,0.14)', bd: 'rgba(183,172,232,0.35)', fg: '#B7ACE8' },
  } as const
  const t = tones[tone]
  return (
    <div
      className="rounded-full border flex items-center justify-center font-bold shrink-0"
      style={{
        width: size,
        height: size,
        background: t.bg,
        borderColor: t.bd,
        color: t.fg,
        fontSize: Math.round(size * 0.37),
      }}
    >
      {children}
    </div>
  )
}

/**
 * The metallic balance card. The sheen is a second absolutely-positioned
 * gradient over the base so it reads as a brushed-metal card rather than a flat
 * grey fill; text on it is near-black because the plate is light.
 */
export function SilverBalanceCard({
  label = 'Total balance',
  amount,
  subLine,
  badge,
  className = '',
}: {
  label?: string
  amount: ReactNode
  subLine?: ReactNode
  badge?: ReactNode
  className?: string
}) {
  return (
    <div
      className={`relative overflow-hidden rounded-[26px] px-[30px] py-7 text-near-black ${className}`}
      style={{
        background:
          'linear-gradient(135deg,#3a3d42 0%,#8f959c 22%,#e8ebee 38%,#9aa0a7 52%,#5c6066 70%,#caced3 88%,#75797f 100%)',
        boxShadow: '0 22px 50px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.5)',
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(105deg,transparent 38%,rgba(255,255,255,0.5) 46%,transparent 55%)',
        }}
      />
      <div className="relative flex justify-between items-start">
        <div
          className="text-[11px] font-bold uppercase whitespace-nowrap"
          style={{ letterSpacing: '0.14em', color: 'rgba(15,15,15,0.55)' }}
        >
          {label}
        </div>
        <VeilMarkDark />
      </div>
      <div className="relative font-lora italic font-semibold text-[52px] leading-[1.1] mt-5 whitespace-nowrap">
        {amount}
      </div>
      <div className="relative flex justify-between items-center mt-6">
        <div className="font-mono text-[13px] whitespace-nowrap" style={{ color: 'rgba(15,15,15,0.6)' }}>
          {subLine}
        </div>
        {badge ? (
          <div
            className="rounded-pill px-[14px] py-[5px] text-[12px] font-semibold whitespace-nowrap"
            style={{ background: 'rgba(15,15,15,0.85)', color: '#00e0f0' }}
          >
            {badge}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** The drape mark in near-black, for use on the light silver card. */
function VeilMarkDark() {
  return (
    <svg width="28" height="28" viewBox="0 0 96 96" aria-hidden="true">
      <rect x="22" y="26" width="52" height="12" rx="6" fill="#0F0F0F" />
      <rect x="28" y="44" width="40" height="12" rx="6" fill="#0F0F0F" opacity="0.5" />
      <rect x="34" y="62" width="28" height="12" rx="6" fill="#0F0F0F" opacity="0.22" />
    </svg>
  )
}

/** Monospace address/machine text at the design's standard dim treatment. */
export function Mono({
  children,
  size = 12,
  className = '',
}: {
  children: ReactNode
  size?: number
  className?: string
}) {
  return (
    <span
      className={`font-mono text-[rgba(246,247,248,0.45)] whitespace-nowrap ${className}`}
      style={{ fontSize: size }}
    >
      {children}
    </span>
  )
}

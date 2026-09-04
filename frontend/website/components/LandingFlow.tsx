import type { Messages } from '@/lib/i18n'
import { useRegionalCurrency, type RegionalAmounts } from '@/lib/regionalCurrency'

/**
 * "Everything money, in one place" — three cards on a ruled field.
 *
 * This replaced a set of phone mockups. The phones were a mistake: a device
 * frame implicitly claims "this is our app", and ours did not match the real
 * mobile design, so it read as wrong rather than as illustration. Cards show a
 * *fragment* of a surface instead — enough to convey the idea, without pretending
 * to be a screenshot of something that looks different in the product.
 *
 * All three cards describe shipped behaviour: a balance that earns in Blend,
 * a passkey-signed send with sponsored fees, and a Soroswap route. Nothing here
 * depends on bills, which are not switched on.
 */

/** Crosshair markers on the rule lines — the drafting-table cue Talise uses. */
function Cross({ className }: { className: string }) {
  return (
    <span aria-hidden="true" className={`absolute ${className}`}>
      <span className="block w-[13px] h-px bg-near-black/25 absolute top-1/2 -translate-y-1/2 left-0" />
      <span className="block h-[13px] w-px bg-near-black/25 absolute left-1/2 -translate-x-1/2 top-0" />
    </span>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-[20px] p-5 sm:p-6 shadow-[0_18px_44px_rgba(15,15,15,0.10)] border border-near-black/[0.06]">
      {children}
    </div>
  )
}

/** 1 — a balance that quietly earns. */
function BalanceCard({ amounts }: { amounts: RegionalAmounts }) {
  // Heights are fixed, not random: a chart that reshuffles on every render
  // reads as decoration, and this one is standing in for real yield accrual.
  const bars = [34, 46, 40, 58, 82, 52, 66]

  const balanceDot = amounts.balance.lastIndexOf('.')
  const balanceMain = balanceDot >= 0 ? amounts.balance.slice(0, balanceDot) : amounts.balance
  const balanceDec = balanceDot >= 0 ? amounts.balance.slice(balanceDot) : null

  return (
    <Card>
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-near-black/45">
        Total balance
      </div>
      <div className="font-lora italic font-normal text-near-black text-[32px] sm:text-[40px] leading-none mt-2">
        {balanceMain}
        {balanceDec && <span className="text-[24px] text-near-black/45">{balanceDec}</span>}
      </div>
      <div className="inline-flex items-center mt-3 rounded-pill bg-teal/12 border border-teal/25 px-3 py-[5px]">
        <span className="font-mono text-[11px] text-teal">+{amounts.dailyYield} today · earning</span>
      </div>
      <div className="flex items-end gap-[7px] h-[62px] mt-6">
        {bars.map((h, i) => (
          <span
            key={i}
            className={`flex-1 rounded-[4px] ${i === 4 ? 'bg-gold' : 'bg-near-black/10'}`}
            style={{ height: `${h}%` }}
          />
        ))}
      </div>
    </Card>
  )
}

/** 2 — the passkey moment. */
function SendCard({ amounts }: { amounts: RegionalAmounts }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 bg-near-black/[0.04] border border-near-black/[0.07] rounded-[14px] p-[14px]">
        <span className="flex items-center gap-3 min-w-0">
          <span className="w-[34px] h-[34px] rounded-full bg-gold/20 border border-gold/40 flex items-center justify-center text-near-black font-semibold text-[13px] shrink-0">
            A
          </span>
          <span className="flex flex-col gap-[2px] min-w-0">
            <span className="font-inter font-semibold text-near-black text-[14px]">Adaeze</span>
            <span className="font-mono text-[11px] text-near-black/45">GDKF…9QX3</span>
          </span>
        </span>
        <span className="font-inter font-semibold text-near-black text-[16px] whitespace-nowrap">
          {amounts.transfer}
        </span>
      </div>

      <div className="flex items-center gap-2 mt-4">
        <span className="text-teal text-[12px]">✓</span>
        <span className="font-mono text-[11px] text-near-black/55">
          No network fee, sponsored by Veil
        </span>
      </div>

      <div className="relative mt-5 h-[52px] rounded-pill bg-near-black flex items-center justify-center">
        <span className="font-anton uppercase tracking-[0.08em] text-gold text-[14px]">
          Slide to sign
        </span>
        <span className="absolute left-[4px] w-[44px] h-[44px] rounded-full bg-gold text-near-black flex items-center justify-center text-[18px] font-bold">
          »
        </span>
      </div>
    </Card>
  )
}

/** 3 — one step, best route. */
function SwapCard() {
  const rows = [
    { from: 'XLM', to: 'USDC', note: 'best of 3 pools' },
    { from: 'USDC', to: 'XLM', note: 'best of 3 pools' },
    { from: 'XLM', to: 'EURC', note: 'routed' },
  ]
  return (
    <Card>
      {rows.map((r, i) => (
        <div
          key={r.from + r.to}
          className={`flex items-center justify-between gap-3 py-[13px] ${
            i < rows.length - 1 ? 'border-b border-near-black/[0.07]' : ''
          }`}
        >
          <span className="flex items-center gap-2 font-inter font-semibold text-near-black text-[14px]">
            {r.from}
            <span className="text-near-black/35">→</span>
            {r.to}
          </span>
          <span className="font-mono text-[11px] text-near-black/45 whitespace-nowrap">{r.note}</span>
        </div>
      ))}
      <div className="font-mono text-[11px] text-teal mt-4">Settles in ~5 seconds</div>
    </Card>
  )
}

export function FlowShowcase({ t }: { t: Messages }) {
  const copy = t.flow
  const amounts = useRegionalCurrency()
  const cards = [
    () => <BalanceCard amounts={amounts} />,
    () => <SendCard amounts={amounts} />,
    SwapCard,
  ]

  return (
    <section id="how-sending-works" className="relative overflow-hidden bg-warm-grey py-16 sm:py-20 lg:py-24">
      <div className="relative max-w-[1240px] mx-auto px-5 sm:px-6 lg:px-10 text-center">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-near-black/50">
          {copy.label}
        </span>
        <h2 className="font-lora italic font-normal text-near-black text-display mt-4 max-lg:text-display-sm">
          {copy.title1}
          <br />
          {copy.title2}
        </h2>
        <p className="font-inter text-[17px] leading-[1.75] text-near-black/65 mt-6 max-w-[640px] mx-auto">
          {copy.body}
        </p>
      </div>

      <div className="relative max-w-[1240px] mx-auto px-5 sm:px-6 lg:px-10 mt-12 lg:mt-16">
        {/* Ruled field: one line above the cards, verticals between them. */}
        <div aria-hidden="true" className="absolute inset-x-5 sm:inset-x-6 lg:inset-x-10 top-0 h-px bg-near-black/12" />
        <Cross className="top-0 left-6 lg:left-10 -translate-x-1/2 -translate-y-1/2 w-[13px] h-[13px]" />
        <Cross className="top-0 right-6 lg:right-10 translate-x-1/2 -translate-y-1/2 w-[13px] h-[13px]" />
        <Cross className="top-0 left-1/3 -translate-x-1/2 -translate-y-1/2 w-[13px] h-[13px] max-lg:hidden" />
        <Cross className="top-0 left-2/3 -translate-x-1/2 -translate-y-1/2 w-[13px] h-[13px] max-lg:hidden" />

        <div className="grid grid-cols-3 max-lg:grid-cols-2 max-md:grid-cols-1 gap-x-6 lg:gap-x-10 gap-y-10 lg:gap-y-12 pt-10 lg:pt-14">
          {cards.map((C, i) => (
            <div key={i} className="relative flex flex-col">
              {/* Divider between columns, matching the rule above. */}
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute -left-3 lg:-left-5 top-[-40px] lg:top-[-56px] bottom-0 w-px bg-near-black/12 max-lg:hidden"
                />
              )}
              <C />
              <h3 className="font-lora italic font-normal text-near-black text-[24px] mt-7">
                {copy.cards[i].title}
              </h3>
              <p className="font-inter text-[15px] leading-[1.75] text-near-black/60 mt-3">
                {copy.cards[i].body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

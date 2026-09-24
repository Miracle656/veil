'use client'

/**
 * Bills & airtime — the everyday-money surface from the `Veil Web` design.
 *
 * The service grid and layout are real; the rails behind them are not wired
 * yet, and deliberately so. Paying a Nigerian bill from crypto needs a
 * naira conversion leg, and `docs/NGN_RAILS.md` records why that leg is
 * currently blocked on licensing rather than on engineering. So this screen
 * states plainly that nothing is live instead of showing invented balances or
 * a button that fails — a fake purchase history here would be the single most
 * misleading thing in the wallet.
 */
import { AccentCard, Card, PageHeader, SectionLabel } from '@/components/ui/primitives'

type Service = {
  name: string
  sub: string
  icon: string
  tone: 'gold' | 'teal' | 'lilac'
}

const SERVICES: Service[] = [
  { name: 'Airtime', sub: 'All networks', icon: '☎', tone: 'gold' },
  { name: 'Data', sub: 'Bundles', icon: '▦', tone: 'gold' },
  { name: 'Power', sub: 'Prepaid units', icon: '⌁', tone: 'teal' },
  { name: 'TV', sub: 'DStv · GOtv', icon: '▤', tone: 'lilac' },
  { name: 'Water', sub: 'State boards', icon: '◈', tone: 'teal' },
  { name: 'Transfer', sub: 'To any bank', icon: '↗', tone: 'gold' },
  { name: 'Betting', sub: 'Top up', icon: '◉', tone: 'lilac' },
  { name: 'Education', sub: 'WAEC · JAMB', icon: '✎', tone: 'teal' },
]

const TONE_FG = {
  gold: 'var(--gold)',
  teal: 'var(--teal)',
  lilac: 'var(--lilac)',
} as const

export default function BillsPage() {
  return (
    <>
      <PageHeader eyebrow="Everyday" title="Bills & airtime" />

      <div className="flex gap-5 mt-[26px] items-start max-xl:flex-col">
        <div className="flex-1 min-w-0 flex flex-col gap-5 w-full">
          <Card>
            <SectionLabel>Pay for</SectionLabel>
            <div className="grid grid-cols-4 max-md:grid-cols-2 gap-3 mt-[18px]">
              {SERVICES.map((s) => (
                <div
                  key={s.name}
                  aria-disabled="true"
                  title="Not available yet"
                  className="bg-[rgba(255,255,255,0.04)] border border-border-dim rounded-[18px] px-4 py-[18px] flex flex-col gap-[5px] opacity-60"
                >
                  <div className="text-[17px]" style={{ color: TONE_FG[s.tone] }}>
                    {s.icon}
                  </div>
                  <div className="text-sm font-semibold mt-1 whitespace-nowrap">{s.name}</div>
                  <div className="text-[11px] text-[rgba(246,247,248,0.4)] whitespace-nowrap">
                    {s.sub}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <SectionLabel>Scheduled</SectionLabel>
            <p className="text-[13px] text-[rgba(246,247,248,0.55)] leading-[1.7] mt-3">
              Recurring bills will appear here once a payment rail is connected. Each run will
              build an unsigned transaction and wait for your passkey — nothing will ever be
              charged automatically.
            </p>
          </Card>
        </div>

        <div className="w-[400px] max-xl:w-full shrink-0">
          <AccentCard tone="gold">
            <SectionLabel>Not live yet</SectionLabel>
            <p className="font-lora italic font-semibold text-[21px] leading-[1.45] mt-3">
              The rails are chosen. The paperwork is not done.
            </p>
            <p className="text-[13px] text-[rgba(246,247,248,0.6)] leading-[1.75] mt-3">
              Paying a Nigerian bill from crypto needs a naira conversion leg, and doing that for
              real users is regulated activity here. Veil will not route live money through an
              unlicensed path, so this screen stays a preview until that is resolved properly.
            </p>
            <p className="text-[13px] text-[rgba(246,247,248,0.6)] leading-[1.75] mt-3">
              The provider research, costs and legal position are written up in
              <span className="font-mono text-[12px] text-gold"> docs/NGN_RAILS.md</span>.
            </p>
          </AccentCard>
        </div>
      </div>
    </>
  )
}

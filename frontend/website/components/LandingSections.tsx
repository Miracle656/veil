/**
 * The three sections Talise's landing has and ours did not: a capability grid,
 * a security/trust block, and an FAQ.
 *
 * Honesty rule applied throughout: every capability carries a Live or Coming
 * tag, and nothing in the trust block or the FAQ is a claim we cannot point at
 * code or a ledger entry for. A landing page that implies bills already work
 * would be the same mistake the wallet's /bills screen deliberately refuses to
 * make.
 */

import type { Messages } from '@/lib/i18n'

type Capability = { name: string; blurb: string; live: boolean }

/** Shipped state lives in code; the words live in messages/. */
const CAPABILITY_LIVE: boolean[] = [true, true, true, true, true, true, true, false]



function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-gold">{children}</span>
  )
}

export function Capabilities({ t }: { t: Messages }) {
  const copy = t.capabilities
  return (
    <section id="capabilities" className="bg-near-black section-pad">
      <div className="max-w-[1240px] mx-auto px-5 sm:px-6 lg:px-10">
        <SectionLabel>{copy.label}</SectionLabel>
        <h2 className="font-lora italic font-normal text-off-white text-display-sm mt-3 max-w-[620px]">
          {copy.title}
        </h2>

        <div className="grid grid-cols-4 max-lg:grid-cols-2 max-sm:grid-cols-1 gap-3 sm:gap-4 mt-10 sm:mt-12">
          {copy.items.map((c, i) => (
            <div
              key={c.name}
              className="bg-white/[0.03] border border-white/10 rounded-[22px] p-6 flex flex-col gap-2"
            >
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-inter font-semibold text-off-white text-[15px]">{c.name}</h3>
                {/* An untagged grid would read as "all of this works today". */}
                <span
                  className={`font-mono text-[9px] uppercase tracking-[0.1em] rounded-pill px-2 py-[3px] whitespace-nowrap ${
                    CAPABILITY_LIVE[i]
                      ? 'text-teal bg-teal/10 border border-teal/25'
                      : 'text-off-white/45 bg-white/[0.04] border border-white/10'
                  }`}
                >
                  {CAPABILITY_LIVE[i] ? copy.live : copy.coming}
                </span>
              </div>
              <p className="font-inter text-[13.5px] leading-[1.65] text-off-white/55">{c.blurb}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export function Trust({ t }: { t: Messages }) {
  const copy = t.trust
  return (
    <section id="security" className="bg-off-white section-pad">
      <div className="max-w-[1240px] mx-auto px-5 sm:px-6 lg:px-10">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-near-black/50">
          {copy.label}
        </span>
        <h2 className="font-lora italic font-normal text-near-black text-display-sm mt-3 max-w-[640px]">
          {copy.title}
        </h2>

        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-x-10 lg:gap-x-14 gap-y-8 lg:gap-y-10 mt-10 sm:mt-12">
          {copy.items.map((item) => (
            <div key={item.title} className="flex flex-col gap-3">
              <h3 className="font-inter font-semibold text-near-black text-[17px]">{item.title}</h3>
              <p className="font-inter text-[14.5px] leading-[1.75] text-near-black/65">{item.body}</p>
            </div>
          ))}
        </div>

        <a
          href="https://docs.useveilapp.xyz/threat-model"
          className="inline-flex items-center gap-2 mt-11 font-inter font-semibold text-[14px] text-near-black border-b-2 border-gold pb-1 transition-opacity hover:opacity-70"
        >
          {copy.link}
          <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  )
}

export function Faq({ t }: { t: Messages }) {
  const copy = t.faq
  return (
    <section id="faq" className="bg-near-black section-pad">
      <div className="max-w-[880px] mx-auto px-5 sm:px-6 lg:px-10">
        <SectionLabel>{copy.label}</SectionLabel>
        <h2 className="font-lora italic font-normal text-off-white text-display-sm mt-3">
          {copy.title}
        </h2>

        <div className="mt-11 border-t border-white/10">
          {copy.items.map((item) => (
            <details key={item.q} className="group border-b border-white/10 py-6">
              <summary className="flex items-center justify-between gap-4 sm:gap-6 cursor-pointer list-none">
                <h3 className="font-inter font-semibold text-off-white text-[15.5px] sm:text-[17px]">{item.q}</h3>
                <span
                  aria-hidden="true"
                  className="text-gold text-[20px] leading-none shrink-0 transition-transform duration-200 ease-stellar group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="font-inter text-[15px] leading-[1.8] text-off-white/60 mt-4 max-w-[720px]">
                {item.a}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

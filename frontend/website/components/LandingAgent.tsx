import type { Messages } from '@/lib/i18n'
import { useRegionalCurrency } from '@/lib/regionalCurrency'

/**
 * The agent section — an inverted (light) band, ported from the Claude Design
 * landing file.
 *
 * It earns its place because it shows the one thing that distinguishes Veil's
 * agent from a chatbot that spends your money: the agent only ever produces an
 * *unsigned* payload, and the passkey is the sole thing that can send it. A
 * paragraph claiming that is forgettable; a queue labelled "awaiting your
 * approval" with a SIGN button beside each row makes the trust model visible.
 *
 * The source file's square badge and square SIGN chips are rounded here, per the
 * house style. The rest — the inversion, the transcript, the approval queue and
 * the section index in the corner — is carried over.
 */

export function LandingAgent({ t }: { t: Messages }) {
  const copy = t.agent
  const amounts = useRegionalCurrency()

  return (
    <section id="agent" className="bg-off-white text-near-black py-20 sm:py-24 lg:py-28">
      <div className="max-w-[1240px] mx-auto px-5 sm:px-8 lg:px-14">
        <div className="flex gap-12 lg:gap-20 items-center max-lg:flex-col max-lg:items-stretch">
          <div className="flex-1 min-w-0">
            <span className="inline-flex items-center gap-[11px] bg-near-black rounded-pill px-[18px] py-2">
              <span className="w-2 h-2 rounded-full bg-gold shrink-0" />
              <span className="font-anton text-[12px] sm:text-[13px] tracking-[0.14em] text-gold whitespace-nowrap">
                {copy.badge}
              </span>
            </span>

            <h2 className="font-lora italic font-normal text-near-black text-[clamp(2rem,4.6vw,3.5rem)] leading-[1.1] tracking-[-0.02em] mt-7">
              {copy.title1}
              <br />
              {copy.title2}
            </h2>

            <p className="font-mono text-[15px] sm:text-[17px] leading-[1.7] text-near-black/60 mt-5 max-w-[560px]">
              {copy.body}
            </p>

            <div className="mt-8">
              {copy.bullets.map((b) => (
                <div
                  key={b.strong}
                  className="flex items-center gap-4 py-[18px] border-t border-near-black/[0.12]"
                >
                  <span className="w-[26px] h-[26px] rounded-full bg-near-black/[0.06] border border-near-black/20 flex items-center justify-center text-[12px] shrink-0">
                    ✓
                  </span>
                  <span className="font-mono text-[14px] sm:text-[16px]">
                    <span className="font-semibold">{b.strong}</span>
                    <span className="text-near-black/55"> — {b.rest}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* The transcript and the approval queue. */}
          <div className="w-[520px] max-lg:w-full shrink-0 bg-near-black text-off-white rounded-[26px] p-6 sm:p-8 box-border">
            <div className="flex flex-col gap-[14px]">
              <div className="self-end max-w-[80%] bg-gold/10 border border-gold/[0.22] rounded-[18px] rounded-br-[6px] px-[18px] py-[14px] font-mono text-[13.5px] sm:text-[15px] leading-[1.6]">
                {copy.ask
                  .replace('{largeAmount}', amounts.largeAmount)
                  .replace('{smallAmount}', amounts.smallAmount)}
              </div>
              <div className="self-start max-w-[86%] bg-white/[0.04] border border-white/[0.08] rounded-[18px] rounded-bl-[6px] px-[18px] py-[14px] font-mono text-[13.5px] sm:text-[15px] leading-[1.7] text-off-white/80">
                {copy.reply}
              </div>
            </div>

            <div className="border border-teal/30 bg-teal/[0.06] rounded-[18px] p-5 mt-5">
              <div className="font-anton text-[12px] tracking-[0.14em] text-teal">{copy.queueLabel}</div>
              {copy.queue.map((q, i) => (
                <div
                  key={q.title}
                  className={`flex justify-between items-center gap-3 py-4 ${
                    i === 0 ? 'border-b border-white/[0.08] mt-2' : ''
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block font-mono text-[13px] sm:text-[14px]">
                    {q.title.replace('{smallAmount}', amounts.smallAmount)}
                  </span>
                    <span className="block font-mono text-[11px] text-off-white/40 mt-[3px]">{q.sub}</span>
                  </span>
                  <span className="bg-gold text-near-black rounded-pill font-mono text-[12px] font-semibold tracking-[0.1em] px-4 py-2 shrink-0">
                    {copy.sign}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Section index, as in the source file — an editorial anchor. */}
        <div className="pt-12 font-mono text-[12px] sm:text-[13px] tracking-[0.14em] text-near-black/35">
          {copy.index}
        </div>
      </div>
    </section>
  )
}

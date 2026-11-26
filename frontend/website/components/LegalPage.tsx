import Link from 'next/link'

import { LEGAL_ENTITY_NAME, LEGAL_RC, SUPPORT_EMAIL, WALLET_URL } from '@/lib/site'

/**
 * One section of a legal page. A string is a paragraph; an array of strings is
 * a bulleted list. Plain data rather than JSX so the wording can be reviewed,
 * diffed and tested as text.
 */
export interface LegalSection {
  heading: string
  body: Array<string | string[]>
}

const anchor = (i: number) => `section-${i + 1}`
const number = (i: number) => String(i + 1).padStart(2, '0')

/** The three bars, drawn the same way as on the landing page. */
function Wordmark({ size }: { size: number }) {
  return (
    <Link href="/" className="flex items-center gap-2.5 select-none">
      <svg width={size} height={size} viewBox="0 0 96 96" aria-hidden="true" className="shrink-0">
        <rect x="22" y="26" width="52" height="12" rx="6" fill="#FDDA24" />
        <rect x="28" y="44" width="40" height="12" rx="6" fill="#FDDA24" opacity="0.5" />
        <rect x="34" y="62" width="28" height="12" rx="6" fill="#FDDA24" opacity="0.22" />
      </svg>
      <span className="font-lora font-semibold italic text-gold text-xl tracking-tight">Veil</span>
    </Link>
  )
}

/**
 * The Terms and the Privacy Policy share this frame, in the landing page's own
 * type and colours: Lora for the title, Inter for the text, Inconsolata for
 * labels, gold on near-black.
 *
 * A server component with no animation on purpose. These pages have to load
 * and be readable on the slowest phone, and each section has an address so it
 * can be quoted.
 */
export default function LegalPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string
  updated: string
  intro: string[]
  sections: LegalSection[]
}) {
  return (
    <div className="min-h-screen bg-near-black text-off-white">
      {/* Fixed, like the landing page's bar. `sticky` does nothing on this site:
          body clips sideways overflow, which makes it the scroll container. */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-near-black/80 backdrop-blur-md border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Wordmark size={22} />
          <a
            href={WALLET_URL}
            className="font-inter text-sm font-medium text-near-black bg-gold rounded-full px-4 py-2 hover:opacity-90 transition-opacity"
          >
            Open wallet
          </a>
        </div>
      </nav>

      <header className="border-b border-white/[0.06]">
        <div className="max-w-6xl mx-auto px-6 pt-36 pb-12">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-gold">Legal</p>
          <h1 className="mt-4 font-lora text-4xl md:text-6xl font-semibold tracking-tight text-off-white">
            {title}
          </h1>
          <p className="mt-5 font-mono text-xs uppercase tracking-[0.14em] text-warm-grey/60">
            Last updated {updated}
          </p>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-14 grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-12">
        {/* Contents, on a wide screen only. On a phone seventeen links would
            push the first sentence two screens down. */}
        <aside className="hidden lg:block">
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-warm-grey/60 mb-4">On this page</p>
          <ol className="space-y-2.5">
            {sections.map((section, i) => (
              <li key={section.heading}>
                <a
                  href={`#${anchor(i)}`}
                  className="group flex gap-3 font-inter text-sm text-warm-grey hover:text-off-white transition-colors"
                >
                  <span className="font-mono text-xs text-warm-grey/40 group-hover:text-gold pt-0.5">
                    {number(i)}
                  </span>
                  <span>{section.heading}</span>
                </a>
              </li>
            ))}
          </ol>
        </aside>

        <main className="max-w-2xl">
          <div className="rounded-2xl border border-gold/20 bg-gold/[0.04] p-6 md:p-7 space-y-4">
            {intro.map((p) => (
              <p key={p} className="font-inter text-[15px] leading-relaxed text-off-white/90">
                {p}
              </p>
            ))}
          </div>

          {sections.map((section, i) => (
            <section
              key={section.heading}
              id={anchor(i)}
              className="mt-14 scroll-mt-24 border-t border-white/[0.06] pt-10"
            >
              <p className="font-mono text-xs tracking-[0.14em] text-gold">{number(i)}</p>
              <h2 className="mt-2 font-lora text-2xl md:text-[28px] font-semibold tracking-tight text-off-white">
                {section.heading}
              </h2>
              <div className="mt-5 space-y-4 font-inter text-[15px] leading-relaxed text-warm-grey">
                {section.body.map((block) =>
                  Array.isArray(block) ? (
                    <ul key={block.join('|')} className="space-y-3">
                      {block.map((item) => (
                        <li key={item} className="flex gap-3">
                          <span aria-hidden="true" className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p key={block}>{block}</p>
                  ),
                )}
              </div>
            </section>
          ))}

          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="mt-6 inline-block font-lora text-xl text-gold underline underline-offset-4"
          >
            {SUPPORT_EMAIL}
          </a>
        </main>
      </div>

      <footer className="border-t border-white/[0.06] px-6 py-10">
        <div className="max-w-6xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="font-inter text-xs text-warm-grey/60 text-center md:text-left">
            © {new Date().getFullYear()} {LEGAL_ENTITY_NAME} (RC {LEGAL_RC}). Veil is a product of Divinity Labs.
          </p>
          <nav aria-label="Legal" className="flex items-center gap-6">
            <Link
              href="/privacy"
              className="font-mono text-xs uppercase tracking-[0.14em] text-warm-grey hover:text-gold transition-colors"
            >
              Privacy Policy
            </Link>
            <Link
              href="/terms"
              className="font-mono text-xs uppercase tracking-[0.14em] text-warm-grey hover:text-gold transition-colors"
            >
              Terms of Service
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}

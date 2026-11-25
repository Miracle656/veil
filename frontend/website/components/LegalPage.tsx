import Link from 'next/link'

import { LEGAL_ENTITY, SUPPORT_EMAIL } from '@/lib/site'

/**
 * One section of a legal page. A string is a paragraph; an array of strings is
 * a bulleted list. Plain data rather than JSX so the wording can be reviewed,
 * diffed and tested as text.
 */
export interface LegalSection {
  heading: string
  body: Array<string | string[]>
}

/**
 * The Terms and the Privacy Policy share this frame. A server component with
 * no animation on purpose: these pages have to load and be readable on the
 * slowest phone, and to be quotable by address.
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
    <main className="min-h-screen bg-[#0F0F0F] text-[#F6F7F8] px-6 py-16">
      <article className="max-w-3xl mx-auto">
        <Link href="/" className="text-sm text-[#FDDA24] hover:underline">
          ← Veil
        </Link>
        <h1 className="mt-8 text-4xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-3 text-sm text-[#8a8a8a]">Last updated: {updated}</p>

        <div className="mt-8 space-y-4 text-[15px] leading-relaxed text-[#cfcfcf]">
          {intro.map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>

        {sections.map((section, i) => (
          <section key={section.heading} className="mt-10">
            <h2 className="text-xl font-semibold text-white">
              {i + 1}. {section.heading}
            </h2>
            <div className="mt-3 space-y-4 text-[15px] leading-relaxed text-[#cfcfcf]">
              {section.body.map((block) =>
                Array.isArray(block) ? (
                  <ul key={block.join('|')} className="list-disc pl-6 space-y-2">
                    {block.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                ) : (
                  <p key={block}>{block}</p>
                ),
              )}
            </div>
          </section>
        ))}

        <footer className="mt-14 border-t border-white/10 pt-6 text-sm text-[#8a8a8a] space-y-2">
          <p>{LEGAL_ENTITY}</p>
          <p>
            Contact:{' '}
            <a className="text-[#FDDA24] hover:underline" href={`mailto:${SUPPORT_EMAIL}`}>
              {SUPPORT_EMAIL}
            </a>
          </p>
          <p>
            <Link className="hover:underline" href="/terms">
              Terms of Service
            </Link>
            {' · '}
            <Link className="hover:underline" href="/privacy">
              Privacy Policy
            </Link>
          </p>
        </footer>
      </article>
    </main>
  )
}

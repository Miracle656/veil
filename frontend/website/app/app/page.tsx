import Link from 'next/link'
import type { Metadata } from 'next'

/**
 * The install page behind every "Download for Android" and the QR on the
 * landing page.
 *
 * Both used to point at `/app`, which did not exist — the button did nothing
 * and the QR, labelled "Scan to install", was a hand-drawn pattern that
 * decoded to nothing at all.
 *
 * The button links to a fixed-name asset, `veil.apk`, which the release
 * workflow uploads beside the versioned one. GitHub redirects
 * `releases/latest/download/veil.apk` to the newest release itself, so the link
 * is right the moment a build is published and nothing here can make it stale.
 *
 * It used to take the link from the GitHub API at render time. That answer is
 * cached, and a refresh that fails keeps the old one: on 2026-11-12 this page
 * was still handing out build 26 a day after build 28 shipped, and a new user
 * installed it twice and hit a bug 28 had fixed. The API is now used only for
 * the label next to the button (build number and size), where being an hour
 * behind costs nothing.
 */

const RELEASES = 'https://github.com/Miracle656/veil/releases'
const API = 'https://api.github.com/repos/Miracle656/veil/releases/latest'
const LATEST_APK = `${RELEASES}/latest/download/veil.apk`

export const metadata: Metadata = {
  title: 'Install Veil for Android',
  description:
    'Download the Veil Android app. A naira-ready Stellar wallet you open with the same fingerprint that opens your bank app.',
}

// An hour is far shorter than the gap between builds, and keeps this page well
// inside GitHub's unauthenticated rate limit however much traffic it sees.
export const revalidate = 3600

type Release = {
  tag_name?: string
  name?: string
  published_at?: string
  assets?: { name?: string; browser_download_url?: string; size?: number }[]
}

/** Build number and size for the label. Never the download link. */
async function latestApk() {
  try {
    const res = await fetch(API, {
      headers: { Accept: 'application/vnd.github+json' },
      next: { revalidate },
    })
    if (!res.ok) return null
    const release = (await res.json()) as Release
    const apk = release.assets?.find((a) => a.name?.endsWith('.apk'))
    if (!apk) return null
    return {
      // Megabytes, because a number of bytes means nothing to someone deciding
      // whether to start this download on mobile data.
      mb: apk.size ? Math.round(apk.size / 1e5) / 10 : null,
      version: release.name ?? release.tag_name ?? null,
      published: release.published_at ?? null,
    }
  } catch {
    // The page works without it: the button does not depend on this.
    return null
  }
}

const STEPS = [
  {
    n: '01',
    title: 'Tap download',
    body: 'The file is an APK — the standard Android install package. It is the same build we hand testers, signed with the same key every time, so it installs over any Veil you already have without touching your wallet or your passkey.',
  },
  {
    n: '02',
    title: 'Allow the install',
    body: 'Android will ask whether to allow installs from your browser. That prompt appears for every app that does not come from the Play Store, and you can turn the permission back off straight afterwards.',
  },
  {
    n: '03',
    title: 'Open it and use your fingerprint',
    body: 'There is no seed phrase to write down. Your passkey is the wallet, so setup is the fingerprint you already use, and nothing to copy onto paper.',
  },
]

export default async function AppPage() {
  const apk = await latestApk()

  return (
    <main className="min-h-screen bg-near-black px-6 py-16 text-off-white sm:px-10 sm:py-24">
      <div className="mx-auto max-w-[720px]">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[13px] text-warm-grey/50 transition-colors hover:text-warm-grey"
        >
          <span aria-hidden="true">&larr;</span> Back to veil
        </Link>

        <p
          className="mt-12 inline-flex items-center gap-2 rounded-full border border-gold/30 px-3 py-1 text-[11px] font-semibold tracking-[0.14em] text-gold"
          style={{ textTransform: 'uppercase' }}
        >
          <span className="inline-block h-[6px] w-[6px] rounded-full bg-gold" aria-hidden="true" />
          Now shipping
        </p>

        <h1 className="mt-5 font-lora text-[40px] leading-[1.08] tracking-tight sm:text-[52px]">
          Install Veil for <span className="text-gold">Android</span>.
        </h1>

        <p className="mt-5 max-w-[52ch] text-[15px] leading-[1.6] text-off-white/80">
          The whole wallet in your pocket. Open it with the same fingerprint that opens your bank
          app, spend in naira, and keep earning on the balance you have not spent yet.
        </p>

        <div className="mt-10 flex flex-wrap items-center gap-4">
          <a
            href={LATEST_APK}
            className="inline-flex items-center gap-2 rounded-full bg-gold px-7 py-[15px] text-[14px] font-semibold text-near-black transition-transform hover:scale-[1.02]"
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
            Download the APK
          </a>

          {apk ? (
            <span className="font-mono text-[12px] text-warm-grey/45">
              {[apk.version, apk.mb ? `${apk.mb} MB` : null].filter(Boolean).join(' · ')}
            </span>
          ) : null}
        </div>

        {/* Stated, not implied. An App Store badge that opens nothing is a worse
            first impression than an honest line of text. */}
        <p className="mt-4 text-[13px] text-warm-grey/45">
          iPhone: join the TestFlight list — we will mail you when the build is ready.
        </p>

        <ol className="mt-14 space-y-8 border-t border-white/[0.08] pt-10">
          {STEPS.map((s) => (
            <li key={s.n} className="flex gap-5">
              <span className="mt-[3px] font-mono text-[11px] text-gold/70">{s.n}</span>
              <div>
                <h2 className="text-[15px] font-semibold">{s.title}</h2>
                <p className="mt-2 max-w-[56ch] text-[14px] leading-[1.6] text-off-white/65">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>

        <p className="mt-12 text-[13px] leading-[1.6] text-warm-grey/40">
          Every build is published at{' '}
          <a href={RELEASES} className="text-warm-grey/70 underline underline-offset-2">
            github.com/Miracle656/veil/releases
          </a>
          , so you can check what you are installing and read what changed.
        </p>
      </div>
    </main>
  )
}

import type { Metadata } from 'next'

/**
 * The link-preview image, declared explicitly on every page.
 *
 * Relying on the app/opengraph-image file convention left /es and several
 * product pages with no og:image: a page that sets its own `openGraph` replaces
 * the inherited object, image included. Built by scripts/generate-og-image.py.
 */
const OG_IMAGE = {
  url: '/og.png',
  width: 1200,
  height: 630,
  alt: 'Veil — a passkey smart wallet on Stellar. No seed phrases. No private keys.',
}

/**
 * Open Graph and Twitter card metadata for one page, from one title and one
 * description, so the three never drift apart and no page ships without an image.
 * Relative `path` resolves against `metadataBase` (lib/site.ts).
 */
export function socialMetadata({
  title,
  description,
  path,
  locale = 'en_US',
}: {
  title: string
  description: string
  path: string
  locale?: string
}): Pick<Metadata, 'openGraph' | 'twitter'> {
  return {
    openGraph: {
      title,
      description,
      url: path,
      siteName: 'Veil',
      type: 'website',
      locale,
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [OG_IMAGE.url],
    },
  }
}

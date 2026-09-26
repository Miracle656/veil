import type { MetadataRoute } from 'next'

/**
 * The wallet app's crawl rules: the entry page, and nothing behind it.
 *
 * Every other route (/dashboard, /send, /settings …) is a client-rendered
 * screen over one person's wallet. To a crawler each one is an empty shell that
 * competes with the marketing site for the same searches, so they are kept out.
 * The entry page stays crawlable — "open the Veil wallet" is a real search —
 * and the product page on www.useveilapp.xyz is where the explaining happens.
 *
 * `/$` matches the root exactly; the longer, more specific Allow wins over the
 * blanket Disallow. Build assets stay allowed so the entry page can render.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: ['/$', '/_next/', '/icon.svg', '/manifest.json'],
        disallow: ['/'],
      },
    ],
  }
}

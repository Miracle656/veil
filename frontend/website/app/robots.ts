import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

/**
 * Everything on the marketing site is public, so everything may be crawled.
 *
 * AI crawlers are allowed on purpose. Being quoted in ChatGPT, Perplexity and
 * Google's AI answers is a discovery channel for a wallet nobody has heard of
 * yet, and the pages here are marketing copy with nothing to protect.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/' }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  }
}

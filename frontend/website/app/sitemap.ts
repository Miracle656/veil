import type { MetadataRoute } from 'next'
import { SITE_URL } from '@/lib/site'

/**
 * Every public page, with the English/Spanish pair declared on the homepage so
 * each language version is indexed for its own audience rather than competing
 * with the other.
 *
 * Add a route here when you add a page — a page missing from the sitemap still
 * gets found through links, but slowly, and a new page wants to be found fast.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()
  const page = (path: string, priority: number): MetadataRoute.Sitemap[number] => ({
    url: `${SITE_URL}${path}`,
    lastModified,
    changeFrequency: 'monthly',
    priority,
  })

  return [
    {
      ...page('/', 1),
      alternates: { languages: { en: `${SITE_URL}/`, es: `${SITE_URL}/es` } },
    },
    {
      ...page('/es', 0.9),
      alternates: { languages: { en: `${SITE_URL}/`, es: `${SITE_URL}/es` } },
    },
    page('/products', 0.8),
    page('/products/wallet', 0.8),
    page('/products/agent', 0.6),
    page('/products/lens', 0.5),
    page('/products/wraith', 0.5),
  ]
}

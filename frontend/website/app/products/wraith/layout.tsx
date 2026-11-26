import type { Metadata } from 'next'
import { socialMetadata } from '@/lib/metadata'

/**
 * Metadata for /products/wraith.
 *
 * The page is a client component (it animates), and client components cannot
 * export metadata, so it lives in this server layout instead. Before this, every
 * product page inherited the homepage's title and description, and search
 * engines saw five copies of one page.
 */
const PATH = '/products/wraith'
const TITLE = 'Wraith — Stellar Asset Contract Transfer Indexer'
const DESCRIPTION =
  'Wraith indexes Stellar Asset Contract events that Horizon does not: query incoming and outgoing Soroban token transfers with filters, date ranges, summaries and pagination.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  ...socialMetadata({
    title: TITLE,
    description: DESCRIPTION,
    path: PATH,
  }),
}

export default function Layout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

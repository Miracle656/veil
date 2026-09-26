import type { Metadata } from 'next'
import { socialMetadata } from '@/lib/metadata'

/**
 * Metadata for /products.
 *
 * The page is a client component (it animates), and client components cannot
 * export metadata, so it lives in this server layout instead. Before this, every
 * product page inherited the homepage's title and description, and search
 * engines saw five copies of one page.
 */
const PATH = '/products'
const TITLE = 'Products — Veil wallet, AI agent, Lens and Wraith'
const DESCRIPTION =
  'The Veil suite on Stellar: a passkey smart wallet with no seed phrase, a Claude-powered wallet agent, the Lens price oracle, and the Wraith token-transfer indexer.'

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

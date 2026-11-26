import type { Metadata } from 'next'
import { socialMetadata } from '@/lib/metadata'

/**
 * Metadata for /products/agent.
 *
 * The page is a client component (it animates), and client components cannot
 * export metadata, so it lives in this server layout instead. Before this, every
 * product page inherited the homepage's title and description, and search
 * engines saw five copies of one page.
 */
const PATH = '/products/agent'
const TITLE = 'Veil Agent — An AI Assistant for Your Stellar Wallet'
const DESCRIPTION =
  'A Claude-powered agent inside the Veil wallet. Check prices, review transfers and prepare swaps in plain language — every transaction still needs your passkey approval.'

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

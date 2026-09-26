import type { Metadata } from 'next'
import { socialMetadata } from '@/lib/metadata'

/**
 * Metadata for /products/lens.
 *
 * The page is a client component (it animates), and client components cannot
 * export metadata, so it lives in this server layout instead. Before this, every
 * product page inherited the homepage's title and description, and search
 * engines saw five copies of one page.
 */
const PATH = '/products/lens'
const TITLE = 'Lens — Real-Time Stellar Price Oracle (VWAP, OHLCV)'
const DESCRIPTION =
  'Lens aggregates Stellar DEX trades and AMM pool snapshots into VWAP, OHLCV and best-route pricing, available pay-per-call over x402 micropayments.'

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

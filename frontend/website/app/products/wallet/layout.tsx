import type { Metadata } from 'next'
import { socialMetadata } from '@/lib/metadata'
import { WalletAppJsonLd } from '@/components/JsonLd'

/**
 * Metadata for /products/wallet.
 *
 * The page is a client component (it animates), and client components cannot
 * export metadata, so it lives in this server layout instead. Before this, every
 * product page inherited the homepage's title and description, and search
 * engines saw five copies of one page.
 */
const PATH = '/products/wallet'
const TITLE = 'Veil Wallet — A Passkey Stellar Wallet With No Seed Phrase'
const DESCRIPTION =
  'A seedless smart wallet on Stellar Soroban. Your fingerprint or face signs every transaction with a passkey, verified on-chain. No seed phrase, no private key to lose. Free on web and Android.'

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
  return (
    <>
      <WalletAppJsonLd />
      {children}
    </>
  )
}

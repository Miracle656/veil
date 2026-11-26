import type { Metadata } from 'next'

import LegalPage from '@/components/LegalPage'
import { TERMS_INTRO, TERMS_SECTIONS, TERMS_UPDATED } from '@/lib/legal/terms'
import { socialMetadata } from '@/lib/metadata'

const PATH = '/terms'
const TITLE = 'Terms of Service — Veil'
const DESCRIPTION =
  'The agreement between you and Divinity Labs Limited for using the Veil wallet: self-custody, fees, naira services and what we cannot do for you.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  ...socialMetadata({ title: TITLE, description: DESCRIPTION, path: PATH }),
}

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated={TERMS_UPDATED}
      intro={TERMS_INTRO}
      sections={TERMS_SECTIONS}
    />
  )
}

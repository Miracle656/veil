import type { Metadata } from 'next'

import LegalPage from '@/components/LegalPage'
import { PRIVACY_INTRO, PRIVACY_SECTIONS, PRIVACY_UPDATED } from '@/lib/legal/privacy'
import { socialMetadata } from '@/lib/metadata'

const PATH = '/privacy'
const TITLE = 'Privacy Policy — Veil'
const DESCRIPTION =
  'What personal data Veil handles, why, who it is shared with, and your rights under the Nigeria Data Protection Act.'

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: PATH },
  ...socialMetadata({ title: TITLE, description: DESCRIPTION, path: PATH }),
}

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      updated={PRIVACY_UPDATED}
      intro={PRIVACY_INTRO}
      sections={PRIVACY_SECTIONS}
    />
  )
}

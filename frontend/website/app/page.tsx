import type { Metadata } from 'next'
import { socialMetadata } from '@/lib/metadata'
import LandingPage from '@/components/LandingPage'
import { SiteJsonLd } from '@/components/JsonLd'
import { getMessages } from '@/lib/i18n'

const t = getMessages('en')

export const metadata: Metadata = {
  title: t.metadata.title,
  description: t.metadata.description,
  alternates: {
    canonical: '/',
    languages: { en: '/', es: '/es' },
  },
  ...socialMetadata({
    title: t.metadata.ogTitle,
    description: t.metadata.ogDescription,
    path: '/',
    locale: 'en_US',
  }),
}

export default function Page() {
  return (
    <>
      <SiteJsonLd />
      <LandingPage locale="en" />
    </>
  )
}

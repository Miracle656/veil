import type { Metadata } from 'next'
import { socialMetadata } from '@/lib/metadata'
import LandingPage from '@/components/LandingPage'
import { SiteJsonLd } from '@/components/JsonLd'
import { getMessages } from '@/lib/i18n'

const t = getMessages('es')

export const metadata: Metadata = {
  title: t.metadata.title,
  description: t.metadata.description,
  alternates: {
    canonical: '/es',
    languages: { en: '/', es: '/es' },
  },
  ...socialMetadata({
    title: t.metadata.ogTitle,
    description: t.metadata.ogDescription,
    path: '/es',
    locale: 'es_ES',
  }),
}

export default function EsPage() {
  return (
    <>
      <SiteJsonLd />
      <LandingPage locale="es" />
    </>
  )
}

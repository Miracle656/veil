import type { Metadata } from 'next'
import LandingPage from '@/components/LandingPage'
import { getMessages } from '@/lib/i18n'

const t = getMessages('es')

export const metadata: Metadata = {
  title: t.metadata.title,
  description: t.metadata.description,
  alternates: {
    canonical: '/es',
    languages: { en: '/', es: '/es' },
  },
  openGraph: {
    title: t.metadata.ogTitle,
    description: t.metadata.ogDescription,
    locale: 'es_ES',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: t.metadata.twitterTitle,
    description: t.metadata.twitterDescription,
  },
}

export default function EsPage() {
  return <LandingPage locale="es" />
}

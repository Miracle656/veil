import type { Metadata } from 'next'
import LandingPage from '@/components/LandingPage'
import { getMessages } from '@/lib/i18n'

const t = getMessages('en')

export const metadata: Metadata = {
  title: t.metadata.title,
  description: t.metadata.description,
  alternates: {
    canonical: '/',
    languages: { en: '/', es: '/es' },
  },
  openGraph: {
    title: t.metadata.ogTitle,
    description: t.metadata.ogDescription,
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: t.metadata.twitterTitle,
    description: t.metadata.twitterDescription,
  },
}

export default function Page() {
  return <LandingPage locale="en" />
}

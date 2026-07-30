import en from '@/messages/en.json'
import es from '@/messages/es.json'

export const locales = ['en', 'es'] as const
export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = 'en'

/** Shape of a message bundle — `en.json` is the source of truth. */
export type Messages = typeof en

const dictionaries: Record<Locale, Messages> = {
  en,
  es: es as Messages,
}

export function getMessages(locale: Locale): Messages {
  return dictionaries[locale] ?? dictionaries[defaultLocale]
}

/** Prefix an internal path with the locale segment (`en` stays at the root). */
export function localePath(locale: Locale, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`
  if (locale === defaultLocale) return clean
  return clean === '/' ? `/${locale}` : `/${locale}${clean}`
}

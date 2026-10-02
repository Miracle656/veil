'use client'

import { useEffect } from 'react'
import type { Locale } from '@/lib/i18n'

/**
 * Keeps `<html lang>` in sync with the page locale.
 *
 * The App Router only allows the `<html>` element in the root layout, which is
 * shared by every route, so the document-level language has to be set from the
 * page. The rendered content is additionally wrapped in an element carrying the
 * same `lang`, which keeps the server-rendered markup correct for crawlers.
 */
export default function HtmlLang({ locale }: { locale: Locale }) {
  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return null
}

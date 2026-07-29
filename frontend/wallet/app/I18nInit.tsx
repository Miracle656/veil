'use client'

import { useEffect } from 'react'
import i18n from '@/lib/i18n'

/** Triggers i18next's client-side init (see lib/i18n.ts) and keeps <html lang> in sync. */
export function I18nInit() {
  useEffect(() => {
    const syncHtmlLang = (lng: string) => {
      document.documentElement.lang = lng
    }
    syncHtmlLang(i18n.language ?? 'en')
    i18n.on('languageChanged', syncHtmlLang)
    return () => {
      i18n.off('languageChanged', syncHtmlLang)
    }
  }, [])

  return null
}

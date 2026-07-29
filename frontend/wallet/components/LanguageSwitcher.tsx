'use client'

import { useTranslation } from 'react-i18next'
import { supportedLanguages, defaultLanguage, type SupportedLanguage } from '@/lib/i18nConfig'

const LABELS: Record<SupportedLanguage, string> = {
  en: 'English',
  es: 'Español',
}

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation('common')
  const current = (supportedLanguages as readonly string[]).includes(i18n.language)
    ? (i18n.language as SupportedLanguage)
    : defaultLanguage

  return (
    <select
      aria-label={t('language')}
      value={current}
      onChange={e => i18n.changeLanguage(e.target.value)}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border-dim)',
        borderRadius: '0.5rem',
        color: 'var(--off-white)',
        fontSize: '0.8125rem',
        padding: '0.375rem 0.5rem',
        cursor: 'pointer',
      }}
    >
      {supportedLanguages.map(lng => (
        <option key={lng} value={lng}>
          {LABELS[lng]}
        </option>
      ))}
    </select>
  )
}

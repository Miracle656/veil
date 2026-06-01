'use client'

import { useTranslation } from 'react-i18next'

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation('settings')

  const changeLanguage = (lng: string) => {
    i18n.changeLanguage(lng)
    localStorage.setItem('veil_language', lng)
  }

  return (
    <div className="card">
      <p style={{ fontSize: '0.75rem', color: 'rgba(246,247,248,0.4)', fontFamily: 'Anton, Impact, sans-serif', letterSpacing: '0.06em', marginBottom: '0.625rem' }}>
        {t('language').toUpperCase()}
      </p>
      <select
        value={i18n.language}
        onChange={(e) => changeLanguage(e.target.value)}
        className="input-field"
        style={{ fontFamily: 'Inter, sans-serif', color: 'var(--off-white)', background: 'var(--surface)' }}
      >
        <option value="en">{t('english')}</option>
        <option value="es">{t('spanish')}</option>
      </select>
    </div>
  )
}

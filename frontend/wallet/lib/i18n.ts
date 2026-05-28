import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

// Translation resources
const resources = {
  en: {
    common: {} as Record<string, string>,
    dashboard: {} as Record<string, string>,
    send: {} as Record<string, string>,
    receive: {} as Record<string, string>,
    settings: {} as Record<string, string>,
    errors: {} as Record<string, string>,
  },
  es: {
    common: {} as Record<string, string>,
    dashboard: {} as Record<string, string>,
    send: {} as Record<string, string>,
    receive: {} as Record<string, string>,
    settings: {} as Record<string, string>,
    errors: {} as Record<string, string>,
  },
}

// Lazy-load translation files
async function loadTranslations(lng: string, ns: string) {
  try {
    const response = await fetch(`/locales/${lng}/${ns}.json`)
    if (!response.ok) throw new Error(`Failed to load ${lng}/${ns}`)
    return await response.json()
  } catch (error) {
    console.warn(`Could not load translation file: ${lng}/${ns}`, error)
    return {}
  }
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    defaultNS: 'common',
    ns: ['common', 'dashboard', 'send', 'receive', 'settings', 'errors'],
    
    interpolation: {
      escapeValue: false, // React already escapes
    },

    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'veil_language',
    },

    react: {
      useSuspense: false,
    },
  })

// Load translations dynamically
const currentLang = i18n.language || 'en'
const namespaces = ['common', 'dashboard', 'send', 'receive', 'settings', 'errors']

Promise.all(
  namespaces.flatMap(ns => 
    ['en', 'es'].map(async lng => {
      const translations = await loadTranslations(lng, ns)
      i18n.addResourceBundle(lng, ns, translations, true, true)
    })
  )
).then(() => {
  // Ensure current language is loaded
  i18n.changeLanguage(currentLang)
})

export default i18n

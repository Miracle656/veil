import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import HttpBackend from 'i18next-http-backend'
import LanguageDetector from 'i18next-browser-languagedetector'
import { supportedLanguages, defaultLanguage, namespaces, LANGUAGE_STORAGE_KEY } from './i18nConfig'

export { supportedLanguages, defaultLanguage, namespaces, LANGUAGE_STORAGE_KEY }
export type { SupportedLanguage } from './i18nConfig'

// i18next reads `navigator`/`localStorage` during init (via the language
// detector), so this only runs in the browser. On the server the module
// re-evaluates per-request without initialising; the client re-evaluates
// once after hydration and initialises for real.
if (typeof window !== 'undefined' && !i18n.isInitialized) {
  i18n
    .use(HttpBackend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      supportedLngs: supportedLanguages,
      fallbackLng: defaultLanguage,
      ns: namespaces,
      defaultNS: 'common',
      backend: {
        loadPath: '/locales/{{lng}}/{{ns}}.json',
      },
      detection: {
        order: ['localStorage', 'navigator'],
        lookupLocalStorage: LANGUAGE_STORAGE_KEY,
        caches: ['localStorage'],
      },
      interpolation: {
        escapeValue: false,
      },
      react: {
        useSuspense: false,
      },
    })
}

export default i18n

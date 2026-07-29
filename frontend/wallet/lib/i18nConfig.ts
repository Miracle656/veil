/** Pure i18n constants — no side effects, safe to import from tests or the client init module. */

export const supportedLanguages = ['en', 'es'] as const
export type SupportedLanguage = (typeof supportedLanguages)[number]

export const defaultLanguage: SupportedLanguage = 'en'
export const namespaces = ['common', 'dashboard', 'send', 'receive', 'errors'] as const

/** Same storage key convention as `useTheme`'s `veil_theme`. */
export const LANGUAGE_STORAGE_KEY = 'veil_language'

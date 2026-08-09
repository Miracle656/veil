/**
 * Confirms every locale ships the same set of translation keys as English
 * (the source of truth), so a missing Spanish string fails CI instead of
 * silently falling back to a blank string at runtime.
 */

import fs from 'fs'
import path from 'path'
import { namespaces, supportedLanguages, defaultLanguage } from '../i18nConfig'

const localesDir = path.join(__dirname, '../../public/locales')

function loadJson(lang: string, ns: string): unknown {
  const file = path.join(localesDir, lang, `${ns}.json`)
  return JSON.parse(fs.readFileSync(file, 'utf-8'))
}

/** Flattens nested keys, e.g. `{ a: { b: 1 } }` -> `['a.b']`. */
function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix]
  return Object.entries(obj as Record<string, unknown>).flatMap(([key, value]) =>
    flattenKeys(value, prefix ? `${prefix}.${key}` : key)
  )
}

describe('locale files', () => {
  for (const lang of supportedLanguages) {
    for (const ns of namespaces) {
      it(`${lang}/${ns}.json is valid JSON`, () => {
        expect(() => loadJson(lang, ns)).not.toThrow()
      })
    }
  }

  const nonDefaultLanguages = supportedLanguages.filter(l => l !== defaultLanguage)

  for (const ns of namespaces) {
    for (const lang of nonDefaultLanguages) {
      it(`${lang}/${ns}.json has the same keys as ${defaultLanguage}/${ns}.json`, () => {
        const enKeys = flattenKeys(loadJson(defaultLanguage, ns)).sort()
        const langKeys = flattenKeys(loadJson(lang, ns)).sort()
        expect(langKeys).toEqual(enKeys)
      })
    }
  }
})

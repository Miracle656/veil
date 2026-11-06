import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { TOKEN_LOGOS, VECTOR_TOKEN_MARKS } from '../ui/primitives'

/**
 * EURC, AQUA and USDT0 all shipped in the mobile bundle and were never mapped
 * on the web, so a USDT0 holder saw a generic lettered "U" sitting next to the
 * real XLM and USDC logos. Nothing failed — the lettered fallback is a valid
 * render for an unknown asset, so the gap was invisible to every other test.
 *
 * These two assertions close it from both directions: a mapping may not point
 * at a file that is not there, and a file that IS there may not go unmapped.
 */
const TOKENS_DIR = join(__dirname, '..', '..', 'public', 'tokens')

describe('TokenIcon marks', () => {
  it.each(Object.entries(TOKEN_LOGOS))('%s maps to a file that exists', (_code, src) => {
    expect(src.startsWith('/tokens/')).toBe(true)
    expect(existsSync(join(TOKENS_DIR, src.replace('/tokens/', '')))).toBe(true)
  })

  it('maps every logo shipped in public/tokens', () => {
    const shipped = readdirSync(TOKENS_DIR).filter((f) => /\.(png|svg|webp)$/i.test(f)).sort()
    const mapped = Object.values(TOKEN_LOGOS).map((s) => s.replace('/tokens/', '')).sort()
    expect(mapped).toEqual(shipped)
  })

  it('draws USDY as a vector rather than leaving it to the lettered fallback', () => {
    expect(VECTOR_TOKEN_MARKS).toContain('USDY')
    expect(TOKEN_LOGOS.USDY).toBeUndefined()
  })
})

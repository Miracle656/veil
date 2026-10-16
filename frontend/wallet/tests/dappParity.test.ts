/**
 * Web/mobile dApp discovery parity (#813).
 *
 * Acceptance: "a test fails if the two apps could diverge." There is exactly
 * ONE allow-list — mobile's `frontend/mobile/lib/dappAllowlist.ts`, the same
 * module #897 made the source of truth for the browser shell and the mobile
 * directory — and the web wallet's `/dapps` screen must render it, not a copy:
 *
 *   - the web screen and the opener must import it via the pinned `@veil/dapps`
 *     mapping, and the mapping must resolve to the real file;
 *   - `DAPP_ALLOWLIST` must be defined in exactly one place under `frontend/`;
 *   - neither screen may carry its own hard-coded entries, under this name or
 *     the retired `DAPP_DIRECTORY` name;
 *   - the web side must open a new tab and never embed a browser.
 *
 * Break any of those — fork the list, add a second copy, embed a frame — and
 * this suite goes red.
 */

import fs from 'fs'
import path from 'path'

/** `frontend/wallet/tests` → repo root. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const ONE_LIST = path.join(REPO_ROOT, 'frontend', 'mobile', 'lib', 'dappAllowlist.ts')
const WEB_SCREEN = path.join(REPO_ROOT, 'frontend', 'wallet', 'app', 'dapps', 'page.tsx')
const WEB_OPENER = path.join(REPO_ROOT, 'frontend', 'wallet', 'lib', 'dapps.ts')
const WEB_TSCONFIG = path.join(REPO_ROOT, 'frontend', 'wallet', 'tsconfig.json')
const WEB_JEST = path.join(REPO_ROOT, 'frontend', 'wallet', 'jest.config.js')

const read = (file: string) => fs.readFileSync(file, 'utf8')

/** All `.ts`/`.tsx` files under `frontend/`, skipping install/build output. */
function walk(dir: string): string[] {
  const files: string[] = []
  const skip = new Set(['node_modules', '.next', '.expo', 'coverage', 'dist', '.git'])
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name)) continue
    const full = path.join(dir, name)
    const stat = fs.statSync(full)
    if (stat.isDirectory()) files.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(name)) files.push(full)
  }
  return files
}

describe('dApp discovery parity (#813)', () => {
  it('the one allow-list is mobile\'s dappAllowlist module', () => {
    expect(fs.existsSync(ONE_LIST)).toBe(true)
    expect(read(ONE_LIST)).toMatch(/export\s+const\s+DAPP_ALLOWLIST\b/)
  })

  it('@veil/dapps is pinned to that exact file in the wallet tsconfig', () => {
    // This is what makes the import "the same module": the alias resolves to
    // mobile's file, not to a wallet-local copy.
    const tsconfig = JSON.parse(read(WEB_TSCONFIG).replace(/^\s*\/\/.*$/gm, '')) as {
      compilerOptions?: { paths?: Record<string, string[]> }
    }
    const targets = tsconfig.compilerOptions?.paths?.['@veil/dapps'] ?? []
    expect(targets).toContain('../mobile/lib/dappAllowlist')
  })

  it('the jest moduleNameMapper resolves @veil/dapps to the same file', () => {
    expect(read(WEB_JEST)).toMatch(/'\^@veil\/dapps\$':\s*'<rootDir>\/\.\.\/mobile\/lib\/dappAllowlist'/)
  })

  it('the web directory screen renders the shared list', () => {
    const source = read(WEB_SCREEN)
    expect(source).toContain("from '@veil/dapps'")
    expect(source).toMatch(/filterDapps\s*\(/)
    expect(source).toMatch(/\.map\(\s*\(?\s*dapp/)
    // An `origin:` literal in a screen means someone forked the list — adding
    // a dApp must stay a single edit to mobile's dappAllowlist.ts.
    expect(source).not.toMatch(/origin:\s*['"]https:\/\//)
  })

  it('the opener checks against the shared allow-list', () => {
    const opener = read(WEB_OPENER)
    expect(opener).toContain("from '@veil/dapps'")
    expect(opener).toContain('allowedOriginOf')
    expect(opener).toContain("window.open(origin, '_blank'")
    expect(opener).toContain('noopener,noreferrer')
  })

  it('DAPP_ALLOWLIST has exactly one definition across both apps', () => {
    const re = /export\s+const\s+DAPP_ALLOWLIST\b/
    const defining = walk(path.join(REPO_ROOT, 'frontend'))
      .filter((file) => re.test(read(file)))
      .map((file) => path.normalize(file))
    expect(defining).toEqual([path.normalize(ONE_LIST)])
  })

  it('the retired forked-directory name appears nowhere under frontend/', () => {
    // The pre-#897 branch carried `frontend/shared/dapps.ts` with a
    // `DAPP_DIRECTORY` copy whose origins already disagreed with the real
    // list. Any reappearance of that name in app code is a regression to two
    // lists. (This spec file is excluded — it is the thing doing the looking.)
    const SELF = path.normalize(__filename)
    const offenders = walk(path.join(REPO_ROOT, 'frontend'))
      .filter((file) => path.normalize(file) !== SELF)
      .filter((file) => /DAPP_DIRECTORY/.test(read(file)))
      .map((file) => path.relative(REPO_ROOT, file))
    expect(offenders).toEqual([])
  })

  it('web opens in a new tab and never embeds a browser', () => {
    const source = read(WEB_SCREEN)
    expect(source).not.toMatch(/<iframe|<embed|<object|<webview/i)
    expect(source).toContain('openDappInNewTab')
  })
})

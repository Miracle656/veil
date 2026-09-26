/**
 * Web/mobile dApp discovery parity (#813).
 *
 * Acceptance: "a test fails if the two apps could diverge." Both apps must
 * render the same directory from ONE module — `frontend/shared/dapps.ts` — so:
 *
 *   - each screen's list import must resolve to that shared file;
 *   - `DAPP_DIRECTORY` must be defined in exactly one place under `frontend/`;
 *   - neither screen may carry its own hard-coded entries;
 *   - the web side must open a new tab and never embed a browser.
 *
 * Break any of those — fork the list, add a second copy, embed a frame — and
 * this suite goes red.
 */

import fs from 'fs'
import path from 'path'

/** `frontend/wallet/tests` → repo root. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const SHARED = path.join(REPO_ROOT, 'frontend', 'shared', 'dapps.ts')
const WEB_SCREEN = path.join(REPO_ROOT, 'frontend', 'wallet', 'app', 'dapps', 'page.tsx')
const WEB_OPENER = path.join(REPO_ROOT, 'frontend', 'wallet', 'lib', 'dapps.ts')
const MOBILE_SCREEN = path.join(REPO_ROOT, 'frontend', 'mobile', 'app', 'dapps.tsx')

const read = (file: string) => fs.readFileSync(file, 'utf8')

/** Every `from '...'` / `import '...'` specifier in a source file. */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const re = /\bfrom\s*['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) specifiers.push(match[1])
  return specifiers
}

/** Whether a relative import from `importer` resolves to the shared module. */
function resolvesToShared(importer: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false
  const base = path.normalize(path.resolve(path.dirname(importer), specifier))
  const shared = path.normalize(SHARED)
  return base === shared || `${base}.ts` === shared
}

function readsSharedModule(importer: string): boolean {
  return importSpecifiers(read(importer)).some((specifier) =>
    resolvesToShared(importer, specifier),
  )
}

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

/** Files under `frontend/` that DEFINE the directory (rather than import it). */
function directoryDefinitions(): string[] {
  const re = /export\s+const\s+DAPP_DIRECTORY\b/
  return walk(path.join(REPO_ROOT, 'frontend'))
    .filter((file) => re.test(read(file)))
    .map((file) => path.normalize(file))
}

describe('dApp discovery parity (#813)', () => {
  it('web directory screen renders the one shared allow-list', () => {
    expect(readsSharedModule(WEB_SCREEN)).toBe(true)
    expect(read(WEB_SCREEN)).toMatch(/DAPP_DIRECTORY\s*\.\s*map/)
  })

  it('mobile directory screen renders the same shared allow-list', () => {
    expect(readsSharedModule(MOBILE_SCREEN)).toBe(true)
    expect(read(MOBILE_SCREEN)).toMatch(/DAPP_DIRECTORY\s*\.\s*map/)
  })

  it('the allow-list has exactly one definition across both apps', () => {
    expect(directoryDefinitions()).toEqual([path.normalize(SHARED)])
  })

  it('neither screen carries its own hard-coded entries', () => {
    // Adding a dApp must be a one-file change: an `origin:` literal inside a
    // screen means someone forked the list and the apps can now diverge.
    expect(read(WEB_SCREEN)).not.toMatch(/origin:\s*['"]https:\/\//)
    expect(read(MOBILE_SCREEN)).not.toMatch(/origin:\s*['"]https:\/\//)
  })

  it('web opens in a new tab and never embeds a browser', () => {
    const source = read(WEB_SCREEN)
    expect(source).not.toMatch(/<iframe|<embed|<object|<webview/i)
    expect(source).toContain('openDappInNewTab')

    const opener = read(WEB_OPENER)
    expect(opener).toContain("window.open(origin, '_blank'")
    expect(opener).toContain('noopener,noreferrer')
    expect(opener).toContain('isAllowedDappOrigin')
  })
})

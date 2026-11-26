#!/usr/bin/env node
/**
 * Prove the SDK's published surface the way a consumer sees it — from a packed
 * tarball, not from the working tree.
 *
 * Why a packing check and not a unit test: the working tree can contain files
 * that `files` excludes, so `require('./src/vue')` succeeding locally says
 * nothing about what an installed copy can reach. Failures invisible from the
 * tree:
 *
 *  - a subpath declared in `exports` whose target `files` never ships, which
 *    resolves for us and throws ERR_MODULE_NOT_FOUND for a consumer;
 *  - `./package.json` missing from `exports`, which makes the manifest
 *    unreachable through the package name;
 *  - a condition that names the wrong format (#1216): `module` and every
 *    `exports` entry pointed ESM and CommonJS consumers at the same CommonJS
 *    file, and nothing checked which format a file actually was;
 *  - a subpath that resolves but cannot load: `/react` resolved fine and threw
 *    "Cannot find module '../../src/useInvisibleWallet'" the moment it ran,
 *    because resolution was all this script checked.
 *
 * So, for every subpath, against the extracted tarball:
 *   1. every declared target is in the tarball;
 *   2. it resolves under `require`, under `import`, and under `react-native`,
 *      each to the file that condition declares;
 *   3. each target really is the format its condition claims;
 *   4. a CommonJS consumer and an ESM consumer import it and run something;
 *   5. TypeScript (nodenext) type-checks a .cts and a .mts consumer, and each
 *      picks the declaration file for its own format.
 *
 * Run with `npm run verify:exports` (which builds first). It is not part of
 * `jest` on purpose: the tarball needs `dist/`, and CI runs Jest before the
 * build. See .github/workflows/ci.yml, sdk job.
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')

const root = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
// npm is a .cmd shim on Windows, which execFile cannot run without a shell;
// there the command goes through the shell as one string.
const npm = (args, opts) => process.platform === 'win32'
  ? require('node:child_process').execSync(['npm', ...args.map((a) => JSON.stringify(a))].join(' '), opts)
  : execFileSync('npm', args, opts)

const failures = []
const fail = (message) => failures.push(message)

// ── What each subpath ships ─────────────────────────────────────────────────
//
// Dual (ESM + CommonJS) except /angular, which is ESM only: @angular/core
// itself ships only ESM, so a CommonJS build of the adapter cannot load its
// own peer on Node < 20.19. Declaring one would be the same untrue claim this
// script exists to catch. See the format strategy in the PR for #1216.
const ESM_ONLY = new Set(['./angular'])
// Subpaths whose react-native condition points Metro at TypeScript source.
const REACT_NATIVE = new Set(['.', './vanilla'])

/** A conditions object flattened to leaf paths: { 'import.types': './…' }. */
function leaves(target, prefix = '') {
  if (typeof target === 'string') return { [prefix || 'default']: target }
  const out = {}
  for (const [condition, value] of Object.entries(target)) {
    Object.assign(out, leaves(value, prefix ? `${prefix}.${condition}` : condition))
  }
  return out
}

/** The file a condition path selects, following nested `default`s. */
function pick(target, ...conditions) {
  let node = target
  for (const c of conditions) {
    if (typeof node !== 'object' || node === null || !(c in node)) return undefined
    node = node[c]
  }
  while (typeof node === 'object' && node !== null) node = node.default
  return node
}

const strip = (p) => String(p).replace(/^\.\//, '')

// ── Manifest checks ─────────────────────────────────────────────────────────

const { exports: exportsMap, files, name } = manifest

if (!name) fail('package.json has no name; a consumer cannot resolve anything.')
if (!exportsMap || typeof exportsMap !== 'object') {
  fail('package.json declares no exports map; nothing below applies.')
}
if (files === undefined) {
  // Without `files`, npm packs everything except .gitignore'd paths — the
  // shipped surface would be whatever happens to be on disk.
  fail('package.json declares no "files"; the package would ship whatever is on disk.')
}

// The legacy fields have to tell the same story as `exports`: `type` makes
// dist/*.js CommonJS, `main` is that build, `module` is the ESM one.
if (manifest.type !== 'commonjs') fail(`"type" is ${JSON.stringify(manifest.type)}; dist/*.js is CommonJS, so it must be "commonjs".`)
if (strip(manifest.main) !== 'dist/index.js') fail(`"main" is ${manifest.main}; expected the CommonJS build, dist/index.js.`)
if (strip(manifest.module) !== 'dist/esm/index.js') fail(`"module" is ${manifest.module}; expected the ESM build, dist/esm/index.js.`)
if (strip(manifest['react-native']) !== 'src/index.ts') fail(`"react-native" is ${manifest['react-native']}; Metro needs src/index.ts.`)

if (exportsMap) {
  if (exportsMap['./package.json'] !== './package.json') {
    // Tooling that reads the manifest by package name gets ERR_PACKAGE_PATH_NOT_EXPORTED.
    fail('exports does not list "./package.json": "./package.json".')
  }
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (!subpath.startsWith('./') && subpath !== '.') {
      fail(`exports key "${subpath}" is malformed; keys must be "." or start with "./".`)
    }
    if (typeof target !== 'string' && (typeof target !== 'object' || target === null)) {
      fail(`exports["${subpath}"] is neither a path nor a conditions object.`)
      continue
    }
    // Every target must be inside the package and written as "./…", or the
    // resolution escapes the package root.
    for (const [condition, file] of Object.entries(leaves(target))) {
      if (typeof file !== 'string' || !file.startsWith('./')) {
        fail(`exports["${subpath}"].${condition} = ${JSON.stringify(file)} is not a "./…" path.`)
      }
    }
    if (subpath === './package.json') continue

    const keys = Object.keys(target)
    // Condition order is resolution order: the first key a resolver asserts wins.
    if (REACT_NATIVE.has(subpath)) {
      if (keys[0] !== 'react-native') {
        // Metro asserts import/require *and* react-native; if either comes
        // first, the app bundles dist/ instead of the native source.
        fail(`exports["${subpath}"]: "react-native" must be the first condition, found ${keys.join(', ')}.`)
      }
      const rn = pick(target, 'react-native')
      if (!/^\.\/src\/.+\.ts$/.test(String(rn))) fail(`exports["${subpath}"]["react-native"] → ${rn}; must be TypeScript source under ./src.`)
    }
    if (keys[keys.length - 1] !== 'default') fail(`exports["${subpath}"]: "default" must be the last condition.`)

    const esm = pick(target, 'import')
    if (!String(esm).startsWith('./dist/esm/')) fail(`exports["${subpath}"].import → ${esm}; the ESM build is under ./dist/esm/.`)
    if (!pick(target, 'import', 'types')?.startsWith('./dist/esm/')) fail(`exports["${subpath}"].import.types must be the ESM declarations under ./dist/esm/.`)
    if (ESM_ONLY.has(subpath)) {
      if ('require' in target) fail(`exports["${subpath}"] declares "require", but that subpath ships ESM only.`)
    } else {
      const cjs = pick(target, 'require')
      if (!String(cjs).startsWith('./dist/') || String(cjs).startsWith('./dist/esm/')) fail(`exports["${subpath}"].require → ${cjs}; the CommonJS build is ./dist/ outside ./dist/esm/.`)
      if (pick(target, 'require', 'types')?.startsWith('./dist/esm/')) fail(`exports["${subpath}"].require.types points at ESM declarations.`)
    }
  }
}

// Older tooling (and React Native's packager) still read these, not `exports`.
for (const field of ['main', 'module', 'types', 'react-native']) {
  const value = manifest[field]
  if (value === undefined) continue
  const relative = strip(value)
  if (!relative.startsWith('dist/') && !relative.startsWith('src/')) {
    fail(`"${field}" points at ${value}, which is outside the published layout.`)
  }
}

// ── The packed tarball ──────────────────────────────────────────────────────

if (!fs.existsSync(path.join(root, 'dist'))) {
  console.error('dist/ is missing. Run `npm run build` (or `npm run verify:exports`) first.')
  process.exit(1)
}

// The consumer lives inside sdk/ so that, walking up, it finds sdk/node_modules
// for the SDK's own dependencies and the framework peers — the same thing a
// real app's node_modules provides. It gets its own package.json, or Node would
// resolve the package name to sdk/ itself (self-reference) instead of the
// installed tarball.
const tmp = fs.mkdtempSync(path.join(root, '.verify-consumer-'))

try {
  const [packed] = JSON.parse(
    npm(['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  )

  const shipped = new Set(packed.files.map((file) => file.path))
  const tarball = path.join(tmp, packed.filename)

  const consumerDir = path.join(tmp, 'consumer')
  const installDir = path.join(consumerDir, 'node_modules', name)
  fs.mkdirSync(installDir, { recursive: true })
  fs.writeFileSync(path.join(consumerDir, 'package.json'), `${JSON.stringify({ name: 'veil-sdk-consumer-check', private: true }, null, 2)}\n`)
  try {
    // A relative tarball path: GNU tar reads "C:\…" as host:path.
    execFileSync('tar', ['-xzf', path.relative(installDir, tarball), '--strip-components=1'], {
      cwd: installDir,
      stdio: 'inherit',
    })
  } catch (error) {
    console.error('Could not extract the tarball with tar(1):', error.message)
    process.exit(1)
  }

  const consumerRequire = createRequire(path.join(consumerDir, 'index.js'))
  const node = (args, opts = {}) => execFileSync(process.execPath, args, { cwd: consumerDir, encoding: 'utf8', ...opts }).trim()
  const inPackage = (file) => path.join(installDir, strip(file))
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

  /** Is this built file the format we claim? Checked on the bytes, not the name. */
  function formatOf(file) {
    const text = fs.readFileSync(file, 'utf8')
    const esm = /^\s*(import|export)\s/m.test(text)
    const cjs = /^"use strict";/.test(text) || /\brequire\(/.test(text) || /\bexports\./.test(text)
    return esm && !cjs ? 'esm' : cjs && !esm ? 'cjs' : 'mixed'
  }

  // A .js file is ESM to Node only inside a "type": "module" scope.
  const scope = path.join(installDir, 'dist', 'esm', 'package.json')
  if (!fs.existsSync(scope) || JSON.parse(fs.readFileSync(scope, 'utf8')).type !== 'module') {
    fail('dist/esm/package.json is missing or not "type": "module"; Node would load the ESM build as CommonJS.')
  }

  const report = []

  for (const [subpath, target] of Object.entries(exportsMap ?? {})) {
    const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`

    // 1. Every declared target must actually be in the tarball.
    for (const [condition, file] of Object.entries(leaves(target))) {
      const relative = strip(file)
      if (!shipped.has(relative)) fail(`${specifier} [${condition}] → ${file} is NOT in the tarball.`)
      if (!fs.existsSync(path.join(installDir, relative))) fail(`${specifier} [${condition}] → ${file} was not extracted from the tarball.`)
    }

    if (subpath === './package.json') {
      // The manifest itself has to be readable through the package name.
      const readBack = consumerRequire(consumerRequire.resolve(specifier))
      if (readBack.version !== manifest.version) fail(`./package.json resolved to version ${readBack.version}, expected ${manifest.version}.`)
      report.push({ specifier, conditions: 'default', target })
      continue
    }

    // 2. Resolution under each condition lands on the file that condition declares.
    const expected = {
      require: pick(target, 'require') ?? pick(target, 'default'),
      import: pick(target, 'import'),
      'react-native': REACT_NATIVE.has(subpath) ? pick(target, 'react-native') : undefined,
    }
    let resolved
    try {
      resolved = {
        require: consumerRequire.resolve(specifier),
        import: require('node:url').fileURLToPath(node(['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`])),
      }
      if (expected['react-native']) {
        resolved['react-native'] = node(['--conditions=react-native', '-p', `require.resolve(${JSON.stringify(specifier)})`])
      }
    } catch (error) {
      fail(`${specifier} does not resolve from a consumer: ${error.code ?? error.message.split('\n')[0]}`)
      continue
    }
    for (const [condition, file] of Object.entries(expected)) {
      if (!file) continue
      if (!same(resolved[condition], inPackage(file))) fail(`${specifier} under "${condition}" resolved to ${resolved[condition]}, expected ${file}.`)
    }

    // 3. The format each condition promises is the format of the file.
    // A missing target was already reported by the manifest checks; the
    // file it resolved to instead is what a consumer gets, so judge that.
    const importFile = expected.import ? inPackage(expected.import) : resolved.import
    const requireFile = expected.require ? inPackage(expected.require) : resolved.require
    if (fs.existsSync(importFile) && formatOf(importFile) !== 'esm') fail(`${specifier}: an ESM consumer is handed ${path.relative(installDir, importFile)}, which is not ESM.`)
    if (!ESM_ONLY.has(subpath) && fs.existsSync(requireFile) && formatOf(requireFile) !== 'cjs') fail(`${specifier}: a CommonJS consumer is handed ${path.relative(installDir, requireFile)}, which is not CommonJS.`)

    report.push({ specifier, conditions: Object.keys(target).join(', '), target })
  }

  // 4. A CommonJS consumer and an ESM consumer import every subpath and run something.
  //
  // The root and /vanilla are exercised with real calls (hex round trip,
  // network config, wallet construction). The adapters need a framework
  // runtime to do anything, so loading them — which executes every module in
  // their import graph — and checking their entry points is the test; that is
  // exactly the step /react used to fail.
  const body = (load) => `
const assert = ${load('assert')}
const sdk = ${load(name)}
assert.strictEqual(sdk.bufferToHex(new Uint8Array([0, 1, 254, 255])), '0001feff')
assert.deepStrictEqual(Array.from(sdk.hexToUint8Array('0001feff')), [0, 1, 254, 255])
assert.strictEqual(sdk.getNetworkConfig('mainnet').name, 'mainnet')
assert.strictEqual(typeof sdk.useInvisibleWallet, 'function')
const vanilla = ${load(`${name}/vanilla`)}
const memory = new Map()
const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => void memory.set(k, v), removeItem: (k) => void memory.delete(k) }
// InvisibleWallet's constructor reads the global localStorage even when
// config.storage is given (reported separately); Node has none.
globalThis.localStorage = storage
// Network values come from the SDK itself, never typed here.
const testnet = sdk.getNetworkConfig('testnet')
const wallet = vanilla.createInvisibleWallet({ factoryContractId: testnet.factoryContractId, rpcUrl: testnet.rpcUrl, networkPassphrase: testnet.networkPassphrase, storage })
assert.ok(wallet instanceof vanilla.InvisibleWallet)
assert.strictEqual(typeof (${load(`${name}/react`)}).VeilProvider, 'function')
assert.strictEqual(typeof (${load(`${name}/vue`)}).useInvisibleWallet, 'function')
assert.strictEqual(typeof (${load(`${name}/svelte`)}).createWalletStore, 'function')
assert.strictEqual(typeof (${load(`${name}/solid`)}).useInvisibleWallet, 'function')
`
  fs.writeFileSync(path.join(consumerDir, 'cjs-consumer.cjs'), `'use strict'\n${body((s) => `require(${JSON.stringify(s)})`)}
// /angular ships ESM only. require() reaches it only where Node can require ESM.
if (process.features.require_module) {
  assert.strictEqual(typeof require(${JSON.stringify(`${name}/angular`)}).provideVeil, 'function')
} else {
  assert.throws(() => require(${JSON.stringify(`${name}/angular`)}), { code: 'ERR_REQUIRE_ESM' })
}
console.log('cjs consumer: ok')
`)
  fs.writeFileSync(path.join(consumerDir, 'esm-consumer.mjs'), `${body((s) => `await import(${JSON.stringify(s)})`)}
assert.strictEqual(typeof (await import(${JSON.stringify(`${name}/angular`)})).provideVeil, 'function')
console.log('esm consumer: ok')
`)
  for (const consumer of ['cjs-consumer.cjs', 'esm-consumer.mjs']) {
    try {
      console.log(node([consumer], { stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (error) {
      fail(`${consumer} failed: ${String(error.stderr || error.message).split('\n').filter(Boolean).slice(0, 6).join(' | ')}`)
    }
  }

  // 5. TypeScript consumers, one per format, under nodenext — the resolution
  // mode that honours import/require conditions and checks the format of the
  // declaration files it lands on.
  const typeCheck = (body) => `import { bufferToHex, type WalletConfig } from '${name}'
import { createInvisibleWallet } from '${name}/vanilla'
import { VeilProvider } from '${name}/react'
const hex: string = bufferToHex(new Uint8Array([1]))
declare const config: WalletConfig
const wallet = createInvisibleWallet(config)
void hex; void wallet; void VeilProvider
${body}`
  fs.writeFileSync(path.join(consumerDir, 'types-cjs.cts'), typeCheck(''))
  fs.writeFileSync(path.join(consumerDir, 'types-esm.mts'), typeCheck(`import { provideVeil } from '${name}/angular'\nvoid provideVeil\n`))
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  let listed = ''
  try {
    listed = node([tsc, '--ignoreConfig', '--noEmit', '--listFiles', '--strict', '--skipLibCheck', '--module', 'nodenext', '--moduleResolution', 'nodenext',
      '--target', 'es2020', '--lib', 'es2020,dom', '--jsx', 'react-jsx', '--types', 'node', '--typeRoots', path.join(root, 'node_modules', '@types'),
      'types-cjs.cts', 'types-esm.mts'], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    fail(`TypeScript consumers failed to type-check: ${String(error.stdout || error.message).split('\n').filter(Boolean).slice(0, 8).join(' | ')}`)
  }
  if (listed) {
    const has = (rel) => listed.split('\n').some((line) => same(line.trim(), path.join(installDir, rel)))
    // The .cts consumer must get CommonJS declarations, the .mts one ESM declarations.
    if (!has('dist/index.d.ts')) fail('the .cts consumer did not resolve dist/index.d.ts (CommonJS types).')
    if (!has('dist/esm/index.d.ts')) fail('the .mts consumer did not resolve dist/esm/index.d.ts (ESM types).')
    if (!has('dist/esm/angular/index.d.ts')) fail('the .mts consumer did not resolve the ESM /angular declarations.')
    console.log('typescript consumers (nodenext, .cts + .mts): ok')
  }

  // ── Output ────────────────────────────────────────────────────────────────

  const width = Math.max(...report.map((row) => row.specifier.length), 'subpath'.length)
  console.log(`\n${name}@${manifest.version} — ${packed.files.length} files in ${packed.filename}\n`)
  console.log(`${'subpath'.padEnd(width)}  conditions`)
  console.log(`${'-'.repeat(width)}  ------------------------------------------`)
  for (const row of report) console.log(`${row.specifier.padEnd(width)}  ${row.conditions}`)

  if (failures.length > 0) {
    console.error('\nFAILED:')
    for (const message of failures) console.error(`  - ${message}`)
    process.exitCode = 1
  } else {
    console.log('\nEvery subpath resolves to its declared format, and loads, from the packed tarball.')
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

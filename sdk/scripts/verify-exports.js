#!/usr/bin/env node
/**
 * Prove the SDK's published surface the way a consumer sees it — from a packed
 * tarball, not from the working tree.
 *
 * Why a packing check and not a unit test: the working tree can contain files
 * that `files` excludes, so `require('./src/vue')` succeeding locally says
 * nothing about what an installed copy can reach. Two real failures are
 * invisible from the tree:
 *
 *  - a subpath declared in `exports` whose target `files` never ships, which
 *    resolves for us and throws ERR_MODULE_NOT_FOUND for a consumer;
 *  - `./package.json` missing from `exports`, which makes the manifest
 *    unreachable through the package name. Tooling reads it constantly
 *    (bundler plugins resolving versions, test runners, framework CLIs), and
 *    once `exports` exists an unlisted path is unreachable — including this one.
 *
 * Run with `npm run verify:exports` (which builds first). It is not part of
 * `jest` on purpose: the tarball needs `dist/`, and CI runs Jest before the
 * build. See .github/workflows/ci.yml, sdk job.
 */

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')

const root = path.join(__dirname, '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const failures = []
const fail = (message) => failures.push(message)

// ── Manifest checks (cheap, and the reason this file exists) ────────────────

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

if (exportsMap) {
  if (exportsMap['./package.json'] !== './package.json') {
    // Tooling that reads the manifest by package name gets ERR_PACKAGE_PATH_NOT_EXPORTED.
    fail('exports does not list "./package.json": "./package.json".')
  }
  for (const [subpath, target] of Object.entries(exportsMap)) {
    if (!subpath.startsWith('./') && subpath !== '.') {
      fail(`exports key "${subpath}" is malformed; keys must be "." or start with "./".`)
    }
    const conditions = typeof target === 'string' ? { default: target } : target
    if (typeof conditions !== 'object' || conditions === null) {
      fail(`exports["${subpath}"] is neither a path nor a conditions object.`)
      continue
    }
    // Every target must be inside the package and written as "./…", or the
    // resolution escapes the package root.
    for (const [condition, file] of Object.entries(conditions)) {
      if (typeof file !== 'string' || !file.startsWith('./')) {
        fail(`exports["${subpath}"].${condition} = ${JSON.stringify(file)} is not a "./…" path.`)
      }
    }
  }
}

// Older tooling (and React Native's packager) still read these, not `exports`.
// A leading "./" is optional in these legacy fields; `dist/` and `src/` are the
// only two directories the package ships.
for (const field of ['main', 'module', 'types', 'react-native']) {
  const value = manifest[field]
  if (value === undefined) continue
  const relative = String(value).replace(/^\.\//, '')
  if (!relative.startsWith('dist/') && !relative.startsWith('src/')) {
    fail(`"${field}" points at ${value}, which is outside the published layout.`)
  }
}

// ── The packed tarball ──────────────────────────────────────────────────────

if (!fs.existsSync(path.join(root, 'dist'))) {
  console.error('dist/ is missing. Run `npm run build` (or `npm run verify:exports`) first.')
  process.exit(1)
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-sdk-pack-'))

try {
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', tmp], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  )

  const shipped = new Set(packed.files.map((file) => file.path))
  const tarball = path.join(tmp, packed.filename)

  // Extract as a consumer would receive it. Resolution through the real
  // `exports` machinery is the only way to know the map is honoured.
  const consumerDir = path.join(tmp, 'consumer')
  const installDir = path.join(consumerDir, 'node_modules', name)
  fs.mkdirSync(installDir, { recursive: true })
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', installDir, '--strip-components=1'], {
      stdio: 'inherit',
    })
  } catch (error) {
    console.error('Could not extract the tarball with tar(1):', error.message)
    process.exit(1)
  }

  const consumerRequire = createRequire(path.join(consumerDir, 'index.js'))

  const report = []

  for (const [subpath, target] of Object.entries(exportsMap ?? {})) {
    const conditions = typeof target === 'string' ? { default: target } : target
    const specifier = subpath === '.' ? name : `${name}/${subpath.slice(2)}`

    // 1. Every declared target must actually be in the tarball.
    for (const [condition, file] of Object.entries(conditions)) {
      const relative = String(file).replace(/^\.\//, '')
      if (!shipped.has(relative)) {
        fail(`${specifier} [${condition}] → ${file} is NOT in the tarball.`)
      }
      if (!fs.existsSync(path.join(installDir, relative))) {
        fail(`${specifier} [${condition}] → ${file} was not extracted from the tarball.`)
      }
    }

    // 2. The subpath must resolve through `exports` from outside the package.
    let resolved
    try {
      resolved = consumerRequire.resolve(specifier)
    } catch (error) {
      fail(`${specifier} does not resolve from a consumer: ${error.code ?? error.message}`)
      continue
    }

    // 3. Resolution must land on the declared file, not merely on something.
    const declared = conditions.default ?? conditions.require ?? Object.values(conditions)[0]
    const expected = path.join(installDir, String(declared).replace(/^\.\//, ''))
    if (path.resolve(resolved) !== path.resolve(expected)) {
      fail(`${specifier} resolved to ${resolved}, expected ${expected}.`)
    }

    if (specifier === `${name}/package.json`) {
      // The manifest itself has to be readable through the package name.
      const readBack = consumerRequire(resolved)
      if (readBack.version !== manifest.version) {
        fail(`./package.json resolved to version ${readBack.version}, expected ${manifest.version}.`)
      }
    }

    report.push({
      specifier,
      target: declared,
      conditions: Object.keys(conditions).join(', '),
      ok: failures.length === 0,
    })
  }

  // ── Output ────────────────────────────────────────────────────────────────

  const width = Math.max(...report.map((row) => row.specifier.length), 'subpath'.length)
  console.log(`\n${name}@${manifest.version} — ${packed.files.length} files in ${packed.filename}\n`)
  console.log(`${'subpath'.padEnd(width)}  conditions                  target`)
  console.log(`${'-'.repeat(width)}  --------------------------  ------------------------------------`)
  for (const row of report) {
    console.log(`${row.specifier.padEnd(width)}  ${row.conditions.padEnd(26)}  ${row.target}`)
  }

  if (failures.length > 0) {
    console.error('\nFAILED:')
    for (const message of failures) console.error(`  - ${message}`)
    process.exit(1)
  }

  console.log('\nAll declared subpaths resolve from the packed tarball.')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

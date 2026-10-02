#!/usr/bin/env node
/**
 * verify-root-lockfile.mjs — guards the repo-root install (issue #670).
 *
 * Veil is a collection of independent npm projects sharing one git repo, not an
 * npm workspace: sdk/, packages/*, frontend/* and examples/* each own a
 * package.json + package-lock.json and are installed on their own. The repo
 * root is its own small project too — it installs only the release/changelog
 * tooling and the smoke test's stellar-sdk.
 *
 * When the root declared `workspaces`, `npm install` at the root pulled every
 * member into one hoisted tree and rewrote package-lock.json from ~950 to
 * ~21,000 lines on every fresh clone. This script fails if that (or any other
 * lockfile drift) comes back:
 *
 *   1. the root package.json must not declare npm workspaces;
 *   2. `npm ci` must be able to install it — package.json and package-lock.json
 *      have to describe the same dependency set;
 *   3. `npm install` must be a no-op — resolving the manifest against the
 *      registry must reproduce the committed lockfile byte for byte.
 *
 * Run from the repo root: `npm run verify:lockfile`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(repoRoot, 'package.json');
const lockPath = join(repoRoot, 'package-lock.json');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(args) {
  return execFileSync(npm, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

function fail(message, detail) {
  console.error(`\nFAIL  ${message}`);
  if (detail) console.error(`\n${detail.trimEnd()}\n`);
  process.exit(1);
}

// 1. No npm workspaces at the root.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.workspaces !== undefined) {
  fail(
    'The root package.json declares "workspaces".',
    'Veil installs per package (see CONTRIBUTING.md). A root `workspaces` field makes\n' +
      '`npm install` hoist sdk/ and packages/* into the root tree and rewrite\n' +
      'package-lock.json on every fresh clone. Changesets reads the package set from\n' +
      'pnpm-workspace.yaml instead, which npm ignores.'
  );
}
console.log('ok    root package.json declares no npm workspaces');

// 2. package.json and package-lock.json agree.
try {
  run(['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund']);
} catch (error) {
  fail(
    '`npm ci` cannot install the root project — package.json and package-lock.json disagree.',
    `${error.stdout ?? ''}${error.stderr ?? ''}\nRun \`npm install\` at the repo root and commit package-lock.json.`
  );
}
console.log('ok    package.json and package-lock.json agree (npm ci --dry-run)');

// 3. `npm install` reproduces the committed lockfile exactly.
const committedLock = readFileSync(lockPath);
try {
  run(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
} catch (error) {
  writeFileSync(lockPath, committedLock);
  fail('`npm install --package-lock-only` failed at the repo root.', `${error.stdout ?? ''}${error.stderr ?? ''}`);
}

const resolvedLock = readFileSync(lockPath);
if (!resolvedLock.equals(committedLock)) {
  const before = committedLock.toString('utf8').split('\n').length;
  const after = resolvedLock.toString('utf8').split('\n').length;
  writeFileSync(lockPath, committedLock);
  fail(
    `\`npm install\` rewrites package-lock.json (${before} -> ${after} lines).`,
    'A fresh clone must leave `git status` clean after a root install.\n' +
      'Run `npm install` at the repo root and commit the resulting package-lock.json.'
  );
}
console.log('ok    `npm install` leaves package-lock.json byte-identical');
console.log('\nRoot install is clean.');

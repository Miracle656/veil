import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE_PATH = resolve(ROOT, 'sdk', 'src', 'core.ts');
const SDK_PKG_PATH = resolve(ROOT, 'sdk', 'package.json');
const DOCS_PATH = resolve(ROOT, 'frontend', 'docs', 'pages', 'sdk-reference.mdx');

const coreSource = readFileSync(CORE_PATH, 'utf8');
const sdkPkg = JSON.parse(readFileSync(SDK_PKG_PATH, 'utf8'));
const docsSource = readFileSync(DOCS_PATH, 'utf8');

/**
 * Extract the action keys defined on `this.actions = { ... }` in `sdk/src/core.ts`.
 */
function extractActionKeys(source) {
  const match = source.match(/this\.actions\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(match, 'could not locate `this.actions = { ... };` in sdk/src/core.ts');

  const keys = [];
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const keyMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
    if (keyMatch) keys.push(keyMatch[1]);
  }
  return keys;
}

/**
 * Extract the public package import paths from `exports` in `sdk/package.json`
 * (skipping `./package.json`).
 */
function extractExportImportPaths(pkg) {
  const name = pkg.name;
  assert.ok(name && typeof name === 'string', 'sdk/package.json must have a package name');
  assert.ok(pkg.exports && typeof pkg.exports === 'object', 'sdk/package.json must have exports');

  return Object.keys(pkg.exports)
    .filter((subpath) => subpath !== './package.json')
    .map((subpath) => (subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`));
}

/**
 * Find any action keys that do not have a `### \`<action>...\`` section heading
 * in `sdk-reference.mdx`.
 */
function findMissingActions(mdx, actionKeys) {
  return actionKeys.filter((key) => {
    const headingPattern = new RegExp(`^###\\s+\`${key}(?:\\([^)]*\\))?\`\\s*$`, 'm');
    return !headingPattern.test(mdx);
  });
}

/**
 * Find any SDK export import paths missing from `sdk-reference.mdx`.
 */
function findMissingExports(mdx, importPaths) {
  return importPaths.filter((importPath) => !mdx.includes(`\`${importPath}\``));
}

test('sdk/src/core.ts exposes all wallet actions on this.actions', () => {
  const actions = extractActionKeys(coreSource);
  assert.ok(actions.length >= 26, `expected at least 26 actions, found ${actions.length}`);
});

test('sdk-reference.mdx documents every action in this.actions', () => {
  const actions = extractActionKeys(coreSource);
  const missing = findMissingActions(docsSource, actions);
  assert.deepEqual(
    missing,
    [],
    `sdk-reference.mdx is missing section(s) for wallet action(s): ${missing.join(', ')}`,
  );
});

test('sdk-reference.mdx lists every entry point in sdk/package.json exports', () => {
  const importPaths = extractExportImportPaths(sdkPkg);
  assert.ok(importPaths.length >= 8, `expected at least 8 entry points, found ${importPaths.length}`);

  const missing = findMissingExports(docsSource, importPaths);
  assert.deepEqual(
    missing,
    [],
    `sdk-reference.mdx is missing entry point(s): ${missing.join(', ')}`,
  );
});

test('sdk-reference.mdx never builds a Keypair from a secret string in browser examples', () => {
  assert.equal(
    /Keypair\.fromSecret\s*\(/.test(docsSource),
    false,
    'sdk-reference.mdx must use TransactionSigner in examples instead of Keypair.fromSecret()',
  );
});

test('parity check fails when an action or entry point is removed from the page', () => {
  const actions = extractActionKeys(coreSource);
  const withoutSendPayment = docsSource.replace(/^###\s+`sendPayment\([^)]*\)`\s*$/m, '');
  assert.deepEqual(findMissingActions(withoutSendPayment, actions), ['sendPayment']);

  const importPaths = extractExportImportPaths(sdkPkg);
  const withoutSolid = docsSource.replace(/`invisible-wallet-sdk\/solid`/g, '');
  assert.deepEqual(findMissingExports(withoutSolid, importPaths), ['invisible-wallet-sdk/solid']);
});

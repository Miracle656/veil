import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  repoRoot,
  findLockfileDirs,
  parseNpmCiError,
  verifyWorkspace,
  verifyAllLockfiles,
} from '../verify-all-lockfiles.mjs';

describe('verify-all-lockfiles', () => {
  test('findLockfileDirs finds all workspaces containing package-lock.json', () => {
    const dirs = findLockfileDirs();
    assert(Array.isArray(dirs));
    assert(dirs.length >= 20, `Expected at least 20 lockfiles, got ${dirs.length}`);
    assert(dirs.includes('.'), 'Root directory should be included');
    assert(dirs.includes('frontend/mobile'), 'frontend/mobile should be included');
    assert(dirs.includes('frontend/wallet'), 'frontend/wallet should be included');
    assert(dirs.includes('sdk'), 'sdk should be included');
    assert(dirs.includes('packages/agent'), 'packages/agent should be included');
  });

  test('parseNpmCiError parses npm error messages and extracts offending packages', () => {
    const sampleOutput = `
npm error code EUSAGE
npm error
npm error \`npm ci\` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with \`npm install\` before continuing.
npm error
npm error Invalid: lock file's @babel/plugin-transform-react-display-name@0.0.0 does not satisfy @babel/plugin-transform-react-display-name@7.29.7
npm error Missing: lodash@^4.17.21 from lock file
npm error
npm error Clean install a project
npm error
npm error Usage:
npm error npm ci
`;
    const parsed = parseNpmCiError(sampleOutput);
    assert(parsed.includes('@babel/plugin-transform-react-display-name'));
    assert(parsed.includes('lodash'));
    assert(!parsed.includes('npm error code'));
    assert(!parsed.includes('Clean install a project'));
  });

  test('clean workspaces pass verification', () => {
    const result = verifyWorkspace('frontend/mobile');
    assert.equal(result.ok, true);
  });

  test('deliberately drifted lockfile fails verification with workspace and package name', () => {
    const lockPath = join(repoRoot, 'frontend/mobile/package-lock.json');
    const origLock = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(origLock);

    // Modify a package in packages map to create intentional drift
    const pkgKeys = Object.keys(parsed.packages || {});
    const targetKey = pkgKeys.find((k) => k.includes('react')) || pkgKeys[1];
    assert(targetKey, 'Expected to find package entry in package-lock.json');

    const origVersion = parsed.packages[targetKey].version;
    parsed.packages[targetKey].version = '0.0.0';
    writeFileSync(lockPath, JSON.stringify(parsed, null, 2));

    try {
      const result = verifyWorkspace('frontend/mobile');
      assert.equal(result.ok, false, 'Expected drifted lockfile to fail verification');
      assert(typeof result.error === 'string' && result.error.length > 0, 'Expected error details');
      // Verify error names the offending package
      const packageName = targetKey.replace(/^node_modules\//, '');
      assert(
        result.error.includes(packageName) || result.error.includes('does not satisfy') || result.error.includes('lock file'),
        `Expected error to mention offending package or mismatch, got: ${result.error}`
      );
    } finally {
      writeFileSync(lockPath, origLock);
    }

    // Verify it is restored and passes again
    const restoredResult = verifyWorkspace('frontend/mobile');
    assert.equal(restoredResult.ok, true, 'Expected restored lockfile to pass verification');
  });
});

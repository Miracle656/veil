import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  findLockfileDirs,
  parseNpmCiError,
  verifyWorkspace,
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

  test('reports npm ci lockfile errors with package names', () => {
    const result = verifyWorkspace('frontend/mobile', () => {
      const error = new Error('npm ci failed');
      error.stderr = "npm error Invalid: lock file's invisible-wallet-sdk@0.0.0 does not satisfy invisible-wallet-sdk@0.2.0";
      throw error;
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /invisible-wallet-sdk/);
  });
});

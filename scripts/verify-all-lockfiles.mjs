#!/usr/bin/env node
/**
 * verify-all-lockfiles.mjs — proves `npm ci` works for every workspace with a lockfile (#823).
 *
 * Veil is a collection of independent npm projects sharing one git repo.
 * When a workspace's package.json changes without updating package-lock.json (or vice-versa),
 * `npm ci` fails. This script discovers every directory with a package-lock.json and
 * runs `npm ci --dry-run` to ensure dependencies and lockfiles are in sync.
 *
 * If drift is detected, it fails with a clear, legible error message naming the
 * workspace and the offending package(s).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Recursively find all directories containing a package-lock.json,
 * skipping node_modules and .git.
 */
export function findLockfileDirs(dir = repoRoot) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findLockfileDirs(fullPath));
    } else if (entry.name === 'package-lock.json') {
      const relDir = relative(repoRoot, dir).replace(/\\/g, '/') || '.';
      results.push(relDir);
    }
  }

  return results.sort();
}

/**
 * Parse npm ci error output to extract offending packages or error reasons.
 */
export function parseNpmCiError(output) {
  const lines = (output || '').split('\n');
  const details = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('npm error')) continue;
    if (trimmed.includes('npm error code')) continue;
    if (trimmed.includes('npm error Clean install')) break;
    if (trimmed.includes('npm error A complete log')) continue;
    if (trimmed.includes('npm error Run "npm help')) continue;
    const msg = trimmed.replace(/^npm error\s*/, '').trim();
    if (msg) details.push(msg);
  }
  return details.length > 0 ? details.join('\n  ') : (output ? output.trim() : 'Unknown npm ci error');
}

/**
 * Verify a single workspace directory with npm ci --dry-run.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export function verifyWorkspace(workspaceDir) {
  const fullPath = join(repoRoot, workspaceDir);
  const args = ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'];
  if (workspaceDir === 'sdk') {
    args.push('--legacy-peer-deps');
  }

  const options = {
    cwd: fullPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  if (process.platform === 'win32') {
    options.shell = true;
  }

  try {
    execFileSync(npm, args, options);
    return { ok: true };
  } catch (error) {
    const rawOutput = (error.stderr ?? '') + '\n' + (error.stdout ?? '');
    return {
      ok: false,
      error: parseNpmCiError(rawOutput),
    };
  }
}

/**
 * Main verification runner.
 */
export function verifyAllLockfiles() {
  const lockfileDirs = findLockfileDirs();
  console.log(`Checking ${lockfileDirs.length} workspace(s) with package-lock.json for lockfile drift...\n`);

  const failures = [];

  for (const dir of lockfileDirs) {
    const result = verifyWorkspace(dir);
    if (result.ok) {
      console.log(`ok    ${dir}`);
    } else {
      console.error(`FAIL  ${dir}`);
      console.error(`  ${result.error}\n`);
      failures.push({ dir, error: result.error });
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ Lockfile drift detected in ${failures.length} workspace(s):`);
    for (const f of failures) {
      console.error(`\n[Workspace: ${f.dir}]`);
      console.error(`  ${f.error}`);
    }
    console.error('\nRun `npm install` inside the affected workspace(s) and commit the updated package-lock.json.');
    return false;
  }

  console.log(`\nAll ${lockfileDirs.length} workspace lockfiles are in sync with package.json.`);
  return true;
}

// Run CLI if executed directly
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const success = verifyAllLockfiles();
  if (!success) {
    process.exit(1);
  }
}

#!/usr/bin/env node
/**
 * sync-package-lockfiles.mjs — runs after `changeset version`.
 *
 * `changeset version` bumps the `version` field in each publishable package.json
 * but never touches that package's package-lock.json, which carries the same
 * version in two places. Left alone, the very next `npm install` in that
 * directory rewrites the lockfile and dirties a fresh clone — the same class of
 * bug as #670, one level down. Refresh the lockfiles in place so the Version
 * Packages PR carries them.
 *
 * `--package-lock-only` resolves against the registry without writing
 * node_modules, so this is safe to run on a machine that never installed the
 * package.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishablePackages, repoRoot } from './publishable-packages.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let changed = 0;

for (const pkg of publishablePackages()) {
  if (!pkg.hasLockfile) {
    console.log(`skip  ${pkg.dir} — no package-lock.json`);
    continue;
  }

  const lockPath = join(repoRoot, pkg.dir, 'package-lock.json');
  const before = readFileSync(lockPath);

  try {
    execFileSync(npm, ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: join(repoRoot, pkg.dir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  } catch (error) {
    writeFileSync(lockPath, before);
    console.error(`\nFAIL  could not refresh ${pkg.dir}/package-lock.json`);
    console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`);
    process.exit(1);
  }

  const after = readFileSync(lockPath);
  if (after.equals(before)) {
    console.log(`ok    ${pkg.dir} — package-lock.json already at ${pkg.version}`);
  } else {
    changed += 1;
    console.log(`sync  ${pkg.dir} — package-lock.json updated to ${pkg.version}`);
  }
}

console.log(`\n${changed} lockfile(s) updated.`);

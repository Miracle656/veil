/**
 * publishable-packages.mjs — the package set Changesets versions and publishes.
 *
 * Single source of truth is pnpm-workspace.yaml, the same file Changesets reads
 * through @manypkg/get-packages. Veil is NOT an npm workspace (see #670 and
 * CONTRIBUTING.md), so nothing here may assume a hoisted root install — each
 * directory is its own npm project with its own package-lock.json.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Expand the `packages:` globs in pnpm-workspace.yaml. Only a trailing `/*` is supported. */
function workspaceGlobs() {
  const yaml = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');
  const body = yaml.slice(yaml.indexOf('packages:') + 'packages:'.length);
  return [...body.matchAll(/^\s*-\s*['"]?([^'"\s#]+)['"]?\s*$/gm)].map((m) => m[1]);
}

function expand(glob) {
  if (!glob.endsWith('/*')) return [glob];
  const parent = glob.slice(0, -2);
  return readdirSync(join(repoRoot, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(repoRoot, parent, entry.name, 'package.json')))
    .map((entry) => `${parent}/${entry.name}`);
}

/** @returns {{dir: string, name: string, version: string, private: boolean, hasLockfile: boolean}[]} */
export function publishablePackages() {
  return workspaceGlobs()
    .flatMap(expand)
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, dir, 'package.json'), 'utf8'));
      return {
        dir,
        name: manifest.name,
        version: manifest.version,
        private: manifest.private === true,
        hasLockfile: existsSync(join(repoRoot, dir, 'package-lock.json')),
      };
    })
    .filter((pkg) => !pkg.private)
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

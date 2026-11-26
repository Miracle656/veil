import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function packageHashes(root) {
  const hashes = Object.create(null);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'SDK artifacts must not contain symlinks');
      if (entry.isDirectory()) await visit(file);
      else {
        assert.ok(entry.isFile(), 'SDK artifacts must be regular files');
        hashes[path.relative(root, file).split(path.sep).join('/')] = createHash('sha256').update(await readFile(file)).digest('hex');
      }
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}

export async function verifyPackage(root, manifest) {
  // CI artifacts retain the old npm version: checking package.json's version alone is unsafe.
  assert.deepEqual(await packageHashes(root), manifest, 'SDK contents differ from the verified upstream CI package');
}

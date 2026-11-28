import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertRegistryParity, parseAssetRegistry } from '../verify-asset-registry.mjs';

/**
 * The assistant keeps its own copy of the asset registry
 * (packages/agent/src/assets.ts) beside the wallet's and the mobile app's.
 * Three copies are only safe while something forces them to agree: an issuer
 * corrected in one and not the others means the assistant calls an asset
 * "verified" that an app does not, or the reverse.
 *
 * This is that something. It reads the three files as text, with the same
 * parser the wallet/mobile check uses, and fails on any difference.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const walletAssets = parseAssetRegistry(join(repoRoot, 'frontend', 'wallet', 'lib', 'assets.ts'));
const mobileAssets = parseAssetRegistry(join(repoRoot, 'frontend', 'mobile', 'lib', 'assets.ts'));
const agentAssets = parseAssetRegistry(join(repoRoot, 'packages', 'agent', 'src', 'assets.ts'));

test('the assistant registry lists assets', () => {
  assert.ok(agentAssets.length > 0);
});

test('the assistant registry matches the wallet registry', () => {
  assertRegistryParity(walletAssets, agentAssets);
});

test('the assistant registry matches the mobile registry', () => {
  assertRegistryParity(mobileAssets, agentAssets);
});

test('a changed issuer in one copy is caught', () => {
  const tampered = agentAssets.map((asset, i) =>
    i === 0 ? { ...asset, issuer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF' } : asset,
  );
  assert.throws(() => assertRegistryParity(walletAssets, tampered));
});

test('an asset missing from one copy is caught', () => {
  assert.throws(() => assertRegistryParity(walletAssets, agentAssets.slice(1)));
});

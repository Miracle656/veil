import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Networks, StrKey } from '@stellar/stellar-sdk';
import { packageHashes, verifyPackage } from './verify-package.mjs';
import { transactionHashes, stroops } from './evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('ordinary invocation refuses before opening a browser or funding an account', () => {
  const env = { ...process.env };
  delete env.SPP_LIVE_TESTNET;
  const result = spawnSync(process.execPath, [path.join(here, 'run.mjs')], { env, encoding: 'utf8' });
  // A missing explicit opt-in must not silently become a live payment in CI.
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Set SPP_LIVE_TESTNET=1 to deliberately submit testnet payments/);
});

test('artifact verification rejects changed, missing and extra files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'veil-spp-integrity-'));
  try {
    await writeFile(path.join(root, 'sdk.js'), 'verified');
    const manifest = await packageHashes(root);
    await verifyPackage(root, manifest);
    await writeFile(path.join(root, 'sdk.js'), 'modified');
    // An unchanged npm version must not allow a different WASM/JS payload.
    await assert.rejects(verifyPackage(root, manifest), /SDK contents differ/);
    await rm(path.join(root, 'sdk.js'));
    await assert.rejects(verifyPackage(root, manifest), /SDK contents differ/);
    await writeFile(path.join(root, 'sdk.js'), 'verified');
    await writeFile(path.join(root, 'extra.js'), 'unexpected');
    await assert.rejects(verifyPackage(root, manifest), /SDK contents differ/);
    await rm(path.join(root, 'extra.js'));
    await writeFile(path.join(root, '__proto__'), 'unexpected');
    // Prototype property names must not disappear from the all-file integrity check.
    await assert.rejects(verifyPackage(root, manifest), /SDK contents differ/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('evidence preserves partial executions and signed hashes when the SDK times out', () => {
  const first = '1'.repeat(64);
  const second = '2'.repeat(64);
  // Dropping a signed or partially confirmed hash makes a blind retry possible.
  assert.deepEqual(transactionHashes([
    { action: 'signed-transaction', hash: first },
    { action: 'pool-result', result: { status: 'failed', hashes: [second, first] } },
  ]), [first, second]);
  assert.throws(() => transactionHashes([{ result: { hashes: ['invalid'] } }]));
});

test('deployment fixture is testnet-only and retains complete valid addresses', async () => {
  const config = JSON.parse(await readFile(path.join(here, 'deployments.json'), 'utf8'));
  // A truncated pin or mainnet substitution must fail before a live run starts.
  assert.equal(config.network, 'testnet');
  assert.equal(config.networkPassphrase, Networks.TESTNET);
  for (const address of [config.deployer, config.admin]) assert.ok(StrKey.isValidEd25519PublicKey(address));
  for (const address of [config.asp_membership, config.asp_non_membership, config.public_key_registry,
    ...Object.values(config.verifiers), ...config.pools.flatMap(pool => [pool.poolContractId, pool.tokenContractId])]) {
    assert.ok(StrKey.isValidContract(address));
  }
  assert.equal(config.pools[0].asset.kind, 'native');
  assert.equal(config.pools[0].gvkMode, undefined);
  assert.deepEqual(config.pools[0].policyFlags, ['blocklist']);
});

test('public XLM checks use exact base units, not rounded floating point', () => {
  // One stroop must remain visible even above Number.MAX_SAFE_INTEGER base units.
  assert.equal(stroops('900719925.4740993') - stroops('900719925.4740992'), 1n);
  assert.throws(() => stroops('1.0'));
});

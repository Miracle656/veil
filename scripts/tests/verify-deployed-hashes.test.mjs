import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { Address, xdr } from '@stellar/stellar-sdk';

import {
  DEPLOYMENTS_PATH,
  RpcError,
  codeKey,
  instanceKey,
  loadDeployment,
  verifyDeployment,
  verifySourceCommit,
} from '../verify-deployed-hashes.mjs';

const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
const mainnet = loadDeployment(deployments, 'mainnet');
const FACTORY_ID = mainnet.factory.contract_id;

// Stand-in bytecode; the fake ledger stores it under its real SHA-256.
const FACTORY_CODE = Buffer.from('fake factory bytecode for tests');
const FACTORY_HASH = createHash('sha256').update(FACTORY_CODE).digest('hex');
const WALLET_HASH = createHash('sha256').update('fake wallet bytecode for tests').digest('hex');
const OTHER_HASH = createHash('sha256').update('some other build').digest('hex');

function entryFor({ factoryHash = FACTORY_HASH, walletHash = WALLET_HASH } = {}) {
  return {
    ...mainnet,
    factory: { ...mainnet.factory, factory_wasm_sha256: factoryHash, wallet_wasm_sha256: walletHash },
  };
}

function instanceXdr(executableHash, walletHash) {
  const storage = walletHash
    ? [
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('WasmHash')]),
          val: xdr.ScVal.scvBytes(Buffer.from(walletHash, 'hex')),
        }),
      ]
    : [];
  return xdr.LedgerEntryData.contractData(
    new xdr.ContractDataEntry({
      ext: new xdr.ExtensionPoint(0),
      contract: new Address(FACTORY_ID).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
      val: xdr.ScVal.scvContractInstance(
        new xdr.ScContractInstance({
          executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(executableHash, 'hex')),
          storage,
        }),
      ),
    }),
  ).toXDR('base64');
}

function codeXdr(hashHex, code) {
  return xdr.LedgerEntryData.contractCode(
    new xdr.ContractCodeEntry({
      ext: new xdr.ContractCodeEntryExt(0),
      hash: Buffer.from(hashHex, 'hex'),
      code,
    }),
  ).toXDR('base64');
}

/** A fake Soroban RPC serving `entries`, keyed by base64 LedgerKey. */
function fakeRpc(entries) {
  return async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    assert.equal(method, 'getLedgerEntries');
    const found = entries.get(params.keys[0]);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { entries: found ? [{ xdr: found }] : [] } }),
      { status: 200 },
    );
  };
}

function ledger({ executableHash = FACTORY_HASH, walletHash = WALLET_HASH, code = FACTORY_CODE } = {}) {
  const entries = new Map();
  entries.set(instanceKey(FACTORY_ID).toXDR('base64'), instanceXdr(executableHash, walletHash));
  if (code) entries.set(codeKey(executableHash).toXDR('base64'), codeXdr(executableHash, code));
  return fakeRpc(entries);
}

const CURRENT_BUILD = { 'factory.wasm': FACTORY_HASH, 'invisible_wallet.wasm': WALLET_HASH };

test('the committed mainnet record is complete and unshortened', () => {
  assert.equal(FACTORY_ID, 'CCZ3JLRESNLDADGXWNEH4YQ4NXUUAHRJNCWZHYG6QB4KTDYHOH6OQ7BK');
  assert.match(mainnet.factory.factory_wasm_sha256, /^[0-9a-f]{64}$/);
  assert.match(mainnet.factory.wallet_wasm_sha256, /^[0-9a-f]{64}$/);
  assert.match(mainnet.factory.source_commit, /^[0-9a-f]{40}$/);
  assert.equal(mainnet.network_passphrase, 'Public Global Stellar Network ; September 2015');
});

test('loadDeployment rejects shortened ids and hashes', () => {
  const bad = (factory) => ({ mainnet: { ...mainnet, factory: { ...mainnet.factory, ...factory } } });
  assert.throws(() => loadDeployment(bad({ contract_id: 'CCZ3JLRE…OQ7BK' }), 'mainnet'), /not a full contract id/);
  assert.throws(() => loadDeployment(bad({ factory_wasm_sha256: '3a6756d2…b853' }), 'mainnet'), /not a full SHA-256/);
  assert.throws(() => loadDeployment(bad({ wallet_wasm_sha256: 'b485f817' }), 'mainnet'), /not a full SHA-256/);
  assert.throws(() => loadDeployment({}, 'mainnet'), /no "mainnet" entry/);
});

test('a ledger matching the record passes', async () => {
  const { ok, lines } = await verifyDeployment('mainnet', entryFor(), CURRENT_BUILD, { fetchImpl: ledger() });
  assert.equal(ok, true, lines.join('\n'));
  assert.ok(lines.some((l) => l.includes(FACTORY_HASH)));
  assert.ok(lines.some((l) => l.includes(WALLET_HASH)));
});

test('a different factory executable fails with both hashes in full', async () => {
  const { ok, lines } = await verifyDeployment('mainnet', entryFor({ factoryHash: OTHER_HASH }), CURRENT_BUILD, {
    fetchImpl: ledger(),
  });
  assert.equal(ok, false);
  const text = lines.join('\n');
  assert.match(text, /MISMATCH factory executable/);
  assert.ok(text.includes(`expected ${OTHER_HASH}`), text);
  assert.ok(text.includes(`on chain ${FACTORY_HASH}`), text);
});

test('a different wallet WasmHash fails with both hashes in full', async () => {
  const { ok, lines } = await verifyDeployment('mainnet', entryFor(), CURRENT_BUILD, {
    fetchImpl: ledger({ walletHash: OTHER_HASH }),
  });
  assert.equal(ok, false);
  const text = lines.join('\n');
  assert.match(text, /MISMATCH factory WasmHash/);
  assert.ok(text.includes(`expected ${WALLET_HASH}`), text);
  assert.ok(text.includes(`on chain ${OTHER_HASH}`), text);
});

test('a factory with no WasmHash set fails', async () => {
  const { ok, lines } = await verifyDeployment('mainnet', entryFor(), CURRENT_BUILD, {
    fetchImpl: ledger({ walletHash: null }),
  });
  assert.equal(ok, false);
  assert.match(lines.join('\n'), /on chain \(absent\)/);
});

test('bytecode that does not hash to its claimed hash fails', async () => {
  const { ok, lines } = await verifyDeployment('mainnet', entryFor(), CURRENT_BUILD, {
    fetchImpl: ledger({ code: Buffer.from('tampered bytecode') }),
  });
  assert.equal(ok, false);
  const text = lines.join('\n');
  assert.match(text, /MISMATCH factory bytecode SHA-256/);
  assert.ok(text.includes(createHash('sha256').update('tampered bytecode').digest('hex')), text);
});

test('a missing contract instance fails', async () => {
  const { ok, lines } = await verifyDeployment('mainnet', entryFor(), CURRENT_BUILD, { fetchImpl: fakeRpc(new Map()) });
  assert.equal(ok, false);
  assert.ok(lines.join('\n').includes(`no contract instance for ${FACTORY_ID}`));
});

test('a current build that differs from the deployment is reported, not failed', async () => {
  const current = { 'factory.wasm': OTHER_HASH, 'invisible_wallet.wasm': WALLET_HASH };
  const { ok, lines } = await verifyDeployment('mainnet', entryFor(), current, { fetchImpl: ledger() });
  assert.equal(ok, true);
  const text = lines.join('\n');
  assert.match(text, /current build: differs/);
  assert.ok(text.includes(`deployed      ${FACTORY_HASH}`), text);
  assert.ok(text.includes(`current build ${OTHER_HASH}`), text);
});

test('RPC failures are RpcErrors, not mismatches', async () => {
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(verifyDeployment('mainnet', entryFor(), CURRENT_BUILD, { fetchImpl: down }), RpcError);

  const overloaded = async () => new Response('busy', { status: 503 });
  await assert.rejects(verifyDeployment('mainnet', entryFor(), CURRENT_BUILD, { fetchImpl: overloaded }), RpcError);

  const rpcError = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600 } }), { status: 200 });
  await assert.rejects(verifyDeployment('mainnet', entryFor(), CURRENT_BUILD, { fetchImpl: rpcError }), RpcError);
});

test('source commit check passes when that commit built both hashes', () => {
  const read = () => JSON.stringify({ artifacts: CURRENT_BUILD });
  const { ok } = verifySourceCommit('mainnet', entryFor(), read);
  assert.equal(ok, true);
});

test('source commit check fails with both hashes when that commit built something else', () => {
  const read = () => JSON.stringify({ artifacts: { 'factory.wasm': OTHER_HASH, 'invisible_wallet.wasm': WALLET_HASH } });
  const { ok, lines } = verifySourceCommit('mainnet', entryFor(), read);
  assert.equal(ok, false);
  const text = lines.join('\n');
  assert.ok(text.includes(`deployed         ${FACTORY_HASH}`), text);
  assert.ok(text.includes(`built at commit  ${OTHER_HASH}`), text);
});

test('source commit check fails when the commit cannot be read', () => {
  const read = () => {
    throw new Error('bad object');
  };
  const { ok, lines } = verifySourceCommit('mainnet', entryFor(), read);
  assert.equal(ok, false);
  assert.match(lines.join('\n'), /cannot read contracts\/expected-hashes.json/);
});

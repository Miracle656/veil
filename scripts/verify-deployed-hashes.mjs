#!/usr/bin/env node
/**
 * Deployed-vs-expected contract hash verification (#1186).
 *
 * `scripts/reproducible-build.sh` answers "does the current source build to the
 * hashes in contracts/expected-hashes.json?" and runs on every PR. This script
 * answers the other question: "is the code running on mainnet the code we say it
 * is?" It reads the ledger directly and checks, for every deployment recorded in
 * contracts/deployments.json:
 *
 * 1. The factory instance's executable WASM hash equals the recorded
 *    `factory.wasm` hash.
 * 2. The bytecode stored under that hash really hashes to it (SHA-256 of the
 *    CONTRACT_CODE entry), so the check does not rest on the instance's claim.
 * 3. The factory's `WasmHash` instance-storage value — the wallet code every new
 *    wallet is deployed from — equals the recorded `invisible_wallet.wasm` hash.
 * 4. Offline: contracts/expected-hashes.json at the recorded `source_commit`
 *    lists both hashes, so the deployed code is code this repository's
 *    reproducible build produced (needs full git history).
 *
 * Deployed contracts cannot be upgraded, so after any contract change lands the
 * current build legitimately differs from what is deployed. That is why the
 * comparison is against the pinned deployment record, not the current build.
 * Whether the deployment still matches the current build is reported too, as
 * information, with both hashes in full.
 *
 * Needs network access, so it runs on a schedule and on demand, never on the PR
 * path (.github/workflows/deployed-hashes.yml).
 *
 * Usage:
 *   node scripts/verify-deployed-hashes.mjs [--network mainnet] [--rpc-url URL]
 *
 * Exit codes:
 *   0: every recorded hash matches the ledger and the source commit
 *   1: a hash mismatch, or a recorded contract or source commit is missing
 *   2: the RPC was unreachable or returned an error
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Address, xdr } from '@stellar/stellar-sdk';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEPLOYMENTS_PATH = join(repoRoot, 'contracts', 'deployments.json');
export const EXPECTED_HASHES_PATH = join(repoRoot, 'contracts', 'expected-hashes.json');

/** Thrown when the RPC itself failed, as opposed to the ledger disagreeing with us. */
export class RpcError extends Error {}

const HEX64 = /^[0-9a-f]{64}$/;

/** Validate and return the deployment record for `network`. */
export function loadDeployment(doc, network) {
  const entry = doc?.[network];
  if (!entry) throw new Error(`contracts/deployments.json has no "${network}" entry`);
  const f = entry.factory;
  if (!f || typeof f.contract_id !== 'string') {
    throw new Error(`deployments.json ${network}.factory.contract_id is missing`);
  }
  // Full ids and hashes only: a shortened one must never be accepted as a record.
  if (!/^C[A-Z2-7]{55}$/.test(f.contract_id)) {
    throw new Error(`deployments.json ${network}.factory.contract_id is not a full contract id: ${f.contract_id}`);
  }
  for (const field of ['factory_wasm_sha256', 'wallet_wasm_sha256']) {
    if (!HEX64.test(f[field] ?? '')) {
      throw new Error(`deployments.json ${network}.factory.${field} is not a full SHA-256: ${f[field]}`);
    }
  }
  if (typeof entry.rpc_url !== 'string' || typeof entry.network_passphrase !== 'string') {
    throw new Error(`deployments.json ${network} needs rpc_url and network_passphrase`);
  }
  return entry;
}

export function instanceKey(contractId) {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

export function codeKey(hashHex) {
  return xdr.LedgerKey.contractCode(
    new xdr.LedgerKeyContractCode({ hash: Buffer.from(hashHex, 'hex') }),
  );
}

/** One `getLedgerEntries` call; returns the LedgerEntryData for `key`, or null if absent. */
export async function getLedgerEntry(rpcUrl, key, { fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLedgerEntries',
        params: { keys: [key.toXDR('base64')] },
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new RpcError(`RPC ${rpcUrl} unreachable: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) throw new RpcError(`RPC ${rpcUrl} returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new RpcError(`RPC ${rpcUrl} error: ${JSON.stringify(body.error)}`);
  const entry = body.result?.entries?.[0];
  return entry ? xdr.LedgerEntryData.fromXDR(entry.xdr, 'base64') : null;
}

/** The factory's executable hash and its `WasmHash` storage value, as hex. */
export function readFactoryInstance(data) {
  const instance = data.contractData().val().instance();
  const executable = instance.executable();
  if (executable.switch().name !== 'contractExecutableWasm') {
    throw new Error(`factory executable is ${executable.switch().name}, not a WASM contract`);
  }
  const executableHash = Buffer.from(executable.wasmHash()).toString('hex');

  let walletHash = null;
  for (const item of instance.storage() ?? []) {
    const k = item.key();
    // The factory's #[contracttype] enum key DataKey::WasmHash encodes as Vec[Symbol("WasmHash")].
    if (k.switch().name !== 'scvVec') continue;
    const parts = k.vec() ?? [];
    if (parts.length === 1 && parts[0].switch().name === 'scvSymbol' && parts[0].sym().toString() === 'WasmHash') {
      walletHash = Buffer.from(item.val().bytes()).toString('hex');
    }
  }
  return { executableHash, walletHash };
}

/**
 * Compare the ledger with the deployment record. Returns `{ ok, lines }`;
 * every hash in `lines` is printed in full.
 */
export async function verifyDeployment(network, entry, expectedArtifacts, opts = {}) {
  const rpcUrl = opts.rpcUrl ?? entry.rpc_url;
  const f = entry.factory;
  const lines = [];
  let ok = true;
  const check = (label, expected, actual) => {
    if (expected === actual) {
      lines.push(`  OK       ${label}`, `           ${actual}`);
    } else {
      ok = false;
      lines.push(`  MISMATCH ${label}`, `           expected ${expected}`, `           on chain ${actual ?? '(absent)'}`);
    }
  };

  lines.push(`${network} factory ${f.contract_id}`, `  rpc ${rpcUrl}`);

  const instance = await getLedgerEntry(rpcUrl, instanceKey(f.contract_id), opts);
  if (!instance) {
    lines.push(`  MISSING  no contract instance for ${f.contract_id} on ${network}`);
    return { ok: false, lines };
  }
  const { executableHash, walletHash } = readFactoryInstance(instance);

  check('factory executable (factory.wasm)', f.factory_wasm_sha256, executableHash);

  const code = await getLedgerEntry(rpcUrl, codeKey(executableHash), opts);
  if (!code) {
    ok = false;
    lines.push(`  MISSING  no CONTRACT_CODE entry for ${executableHash}`);
  } else {
    const digest = createHash('sha256').update(code.contractCode().code()).digest('hex');
    check('factory bytecode SHA-256 (recomputed from the ledger)', executableHash, digest);
  }

  check('factory WasmHash (invisible_wallet.wasm)', f.wallet_wasm_sha256, walletHash);

  // Information only: deployed contracts are immutable, so this legitimately
  // differs once contract changes land. It tells a reader whether mainnet runs
  // the code at HEAD.
  const pairs = [
    ['factory.wasm', f.factory_wasm_sha256],
    ['invisible_wallet.wasm', f.wallet_wasm_sha256],
  ];
  const stale = pairs.filter(([name, hash]) => expectedArtifacts?.[name] !== hash);
  if (stale.length === 0) {
    lines.push('  current build: matches this deployment (expected-hashes.json)');
  } else {
    lines.push(`  current build: differs from this deployment; a new factory deploy is needed to ship it`);
    for (const [name, hash] of stale) {
      lines.push(`           ${name}`, `             deployed      ${hash}`, `             current build ${expectedArtifacts?.[name] ?? '(absent)'}`);
    }
  }

  return { ok, lines };
}

/**
 * The deployed hashes must be ones this repository's reproducible build
 * produced: `contracts/expected-hashes.json` at the recorded `source_commit`
 * lists both. `readAtCommit(commit, path)` returns that file's text.
 */
export function verifySourceCommit(network, entry, readAtCommit) {
  const f = entry.factory;
  const lines = [`${network} deployment source ${f.source_commit}`];
  if (!/^[0-9a-f]{40}$/.test(f.source_commit ?? '')) {
    lines.push(`  MISMATCH source_commit is not a full commit hash: ${f.source_commit}`);
    return { ok: false, lines };
  }
  let artifacts;
  try {
    artifacts = JSON.parse(readAtCommit(f.source_commit, 'contracts/expected-hashes.json')).artifacts ?? {};
  } catch (error) {
    lines.push(`  MISSING  cannot read contracts/expected-hashes.json at ${f.source_commit}: ${error instanceof Error ? error.message : error}`);
    return { ok: false, lines };
  }
  let ok = true;
  for (const [name, hash] of [['factory.wasm', f.factory_wasm_sha256], ['invisible_wallet.wasm', f.wallet_wasm_sha256]]) {
    if (artifacts[name] === hash) {
      lines.push(`  OK       ${name} built by that commit`, `           ${hash}`);
    } else {
      ok = false;
      lines.push(`  MISMATCH ${name}`, `           deployed         ${hash}`, `           built at commit  ${artifacts[name] ?? '(absent)'}`);
    }
  }
  return { ok, lines };
}

function gitShow(commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], { cwd: repoRoot, encoding: 'utf8' });
}

function parseArgs(argv) {
  const args = { network: 'mainnet', rpcUrl: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--network') args.network = argv[++i];
    else if (argv[i] === '--rpc-url') args.rpcUrl = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deployments = JSON.parse(readFileSync(DEPLOYMENTS_PATH, 'utf8'));
  const expected = JSON.parse(readFileSync(EXPECTED_HASHES_PATH, 'utf8')).artifacts ?? {};
  const entry = loadDeployment(deployments, args.network);

  const source = verifySourceCommit(args.network, entry, gitShow);
  console.log(source.lines.join('\n') + '\n');

  try {
    const { ok: ledgerOk, lines } = await verifyDeployment(args.network, entry, expected, {
      rpcUrl: args.rpcUrl ?? process.env.VEIL_RPC_URL,
    });
    console.log(lines.join('\n'));
    const ok = ledgerOk && source.ok;
    if (!ok) {
      console.error(`\nDeployed contract hashes do not match contracts/deployments.json for ${args.network}.`);
      process.exit(1);
    }
    console.log(`\n==> ${args.network} deployment matches contracts/deployments.json`);
  } catch (error) {
    if (error instanceof RpcError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

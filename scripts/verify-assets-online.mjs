#!/usr/bin/env node
/**
 * Live / online asset registry verification (#794).
 *
 * Runs on a scheduled GitHub Actions workflow (or manual dispatch), never on the
 * push path. For every non-native mainnet registry entry it applies the same
 * fail-closed identity check as `verify-asset-registry.mjs`:
 * - Horizon must return the exact pinned issuer account
 * - the pinned SAC contract id must derive from code + issuer
 * - if the issuer declares a `home_domain`, its parsed stellar.toml must list one
 *   `[[CURRENCIES]]` entry with exactly the pinned `code` AND `issuer`
 *   (an issuer with no `home_domain`, like the real USDT0, passes on identity alone)
 *
 * Exit codes:
 *   0: All live checks pass (or --warn-only active)
 *   1: Verification error / asset mismatch
 *   2: Network error / third-party service unreachable
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  fetchTomlText,
  loadHorizonAccount,
  parseAssetRegistry,
  verifyAssetResult,
} from './verify-asset-registry.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walletAssetsPath = join(repoRoot, 'frontend', 'wallet', 'lib', 'assets.ts');

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verify one registry entry against the live network.
 *
 * `networkError` is true when a third party was unreachable or erroring (fetch
 * rejected, timed out, 429 or 5xx) as opposed to the registry actually being wrong,
 * so a flaky host can be told apart from a real mismatch.
 */
export async function checkAssetOnline(asset, { fetchImpl = globalThis.fetch } = {}) {
  let networkError = false;
  const trackedFetch = async (url, init) => {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      networkError = true;
      throw error;
    }
    if (response.status === 429 || response.status >= 500) networkError = true;
    return response;
  };

  const result = await verifyAssetResult(asset, {
    loadAccount: (entry) => loadHorizonAccount(entry, { fetchImpl: trackedFetch }),
    fetchToml: (domain) => fetchTomlText(domain, { fetchImpl: trackedFetch }),
  });

  if (result.ok) {
    return { code: asset.code, ok: true, issues: [], networkError: false, note: result.value.note };
  }
  return { code: asset.code, ok: false, issues: [errorMessage(result.error)], networkError };
}

export async function runOnlineVerification(argv = process.argv.slice(2)) {
  const warnOnly = argv.includes('--warn-only');
  const jsonOutput = argv.includes('--json');
  const diffFileIdx = argv.indexOf('--diff-file');
  const diffFilePath = diffFileIdx !== -1 ? argv[diffFileIdx + 1] : null;

  // Testnet is reset periodically, so a missing testnet issuer is not an alert.
  const assets = parseAssetRegistry(walletAssetsPath).filter(
    (asset) => asset.kind !== 'native' && asset.network !== 'testnet',
  );

  console.log(`Verifying ${assets.length} assets against the live network...`);

  const results = [];
  for (const asset of assets) {
    results.push(await checkAssetOnline(asset));
  }

  const hasVerificationError = results.some((r) => !r.ok && !r.networkError);
  const hasNetworkError = results.some((r) => !r.ok && r.networkError);

  if (jsonOutput) {
    console.log(JSON.stringify({ results }));
  } else {
    for (const r of results) {
      if (r.ok) {
        console.log(`✓ ${r.code}: ${r.note}`);
      } else {
        console.error(`✗ ${r.code}: Verification failed${r.networkError ? ' (network error)' : ''}`);
        for (const issue of r.issues) console.error(`    - ${issue}`);
      }
    }
  }

  // The report becomes an alert issue, so it is written only when a registry entry is actually wrong. A
  // third party being unreachable still fails the job (exit 2) but must not file an issue.
  const failed = results.filter((r) => !r.ok);
  if (hasVerificationError && diffFilePath) {
    const lines = [
      'LIVE ASSET REGISTRY VERIFICATION FAILURE REPORT',
      '==============================================',
      ...failed.flatMap((f) => [`Asset: ${f.code}`, ...f.issues.map((issue) => `  * ${issue}`)]),
      '==============================================',
    ];
    try {
      writeFileSync(diffFilePath, lines.join('\n'), 'utf8');
    } catch (error) {
      console.error(`Failed to write diff file: ${errorMessage(error)}`);
    }
  }

  if (hasVerificationError) {
    process.exitCode = warnOnly ? 0 : 1;
  } else if (hasNetworkError) {
    process.exitCode = warnOnly ? 0 : 2;
  } else {
    process.exitCode = 0;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runOnlineVerification().catch((error) => {
    console.error(`[UNEXPECTED ERROR] ${error.stack || error}`);
    process.exitCode = 1;
  });
}

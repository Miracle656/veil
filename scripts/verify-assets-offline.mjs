#!/usr/bin/env node
/**
 * Fast, pure offline asset registry verification (#794).
 *
 * Runs on the push path with zero network calls:
 * - Validates every non-native issuer is a well-formed Ed25519 public key (StrKey)
 * - Derives each pinned SAC contract id and asserts it matches
 * - Verifies the wallet and mobile asset registries are identical
 *
 * Parsing, SAC derivation and registry normalisation come from
 * `verify-asset-registry.mjs`, and key validation from `@stellar/stellar-sdk`, so there is a single
 * implementation of each and the offline and live verifiers cannot disagree about what a registry
 * entry means.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { StrKey } from '@stellar/stellar-sdk';

import {
  deriveSacContractId,
  normalizeRegistry,
  parseAssetRegistry,
} from './verify-asset-registry.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walletAssetsPath = join(repoRoot, 'frontend', 'wallet', 'lib', 'assets.ts');
const mobileAssetsPath = join(repoRoot, 'frontend', 'mobile', 'lib', 'assets.ts');

const COMPARED_FIELDS = ['code', 'issuer', 'network', 'homeDomain', 'sacContractId'];

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @param {Array<object>} walletAssets assets as returned by `parseAssetRegistry`
 * @param {Array<object>} mobileAssets assets as returned by `parseAssetRegistry`
 * @returns {string[]} human-readable problems; empty when the registries are sound
 */
export function verifyOfflineRegistries(walletAssets, mobileAssets) {
  const errors = [];

  // 1. Wallet / mobile parity, reported per asset and field.
  const wallet = normalizeRegistry(walletAssets);
  const mobile = normalizeRegistry(mobileAssets);

  for (const key of Object.keys(wallet)) {
    if (!mobile[key]) {
      errors.push(`Registry divergence: asset "${key}" exists in wallet but is missing in mobile registry.`);
      continue;
    }
    for (const field of COMPARED_FIELDS) {
      if (wallet[key][field] !== mobile[key][field]) {
        errors.push(
          `Registry divergence for "${key}.${field}": wallet="${wallet[key][field]}" vs mobile="${mobile[key][field]}"`,
        );
      }
    }
  }
  for (const key of Object.keys(mobile)) {
    if (!wallet[key]) {
      errors.push(`Registry divergence: asset "${key}" exists in mobile but is missing in wallet registry.`);
    }
  }

  // 2. StrKey validity and SAC derivation for every non-native wallet asset.
  for (const asset of walletAssets) {
    if (asset.kind === 'native') continue;

    if (!asset.issuer) {
      errors.push(`Asset "${asset.key}" has no issuer defined.`);
      continue;
    }
    if (!StrKey.isValidEd25519PublicKey(asset.issuer)) {
      errors.push(`Asset "${asset.key}" has invalid Ed25519 public key StrKey: ${asset.issuer}`);
      continue;
    }
    try {
      deriveSacContractId(asset);
    } catch (error) {
      errors.push(`Asset "${asset.key}": ${errorMessage(error)}`);
    }
  }

  return errors;
}

export async function runOfflineAssetVerification() {
  console.log('Running offline asset registry verification (zero network calls)...');

  const walletAssets = parseAssetRegistry(walletAssetsPath);
  const mobileAssets = parseAssetRegistry(mobileAssetsPath);
  const errors = verifyOfflineRegistries(walletAssets, mobileAssets);

  if (errors.length > 0) {
    console.error('\n✕ Asset registry offline verification failed:');
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return false;
  }

  console.log(`✓ All ${walletAssets.length} registered assets verified offline:`);
  for (const asset of walletAssets) {
    if (asset.kind === 'native') {
      console.log(`  ✓ ${asset.key}: native asset`);
    } else {
      console.log(
        `  ✓ ${asset.key} (${asset.issuer.slice(0, 8)}…${asset.issuer.slice(-4)}) - StrKey & SAC verified`,
      );
    }
  }
  console.log('✓ Wallet and mobile registries are identical.');
  process.exitCode = 0;
  return true;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  runOfflineAssetVerification().catch((error) => {
    console.error(`[UNEXPECTED ERROR] ${error.stack || error}`);
    process.exitCode = 1;
  });
}

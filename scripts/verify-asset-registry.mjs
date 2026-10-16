#!/usr/bin/env node
/**
 * Verify registered non-native assets by exact issuer identity on their
 * claimed Stellar network, verifying wallet and mobile registry parity and
 * corroborating with stellar.toml.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Asset, Networks } from '@stellar/stellar-sdk';
import toml from 'toml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walletAssetsPath = join(repoRoot, 'frontend', 'wallet', 'lib', 'assets.ts');
const mobileAssetsPath = join(repoRoot, 'frontend', 'mobile', 'lib', 'assets.ts');

export const STELLAR_NETWORKS = {
  mainnet: {
    horizon: 'https://horizon.stellar.org',
    passphrase: Networks.PUBLIC,
  },
  testnet: {
    horizon: 'https://horizon-testnet.stellar.org',
    passphrase: Networks.TESTNET,
  },
};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function resolveStringValue(rawValue, constants, field, source) {
  if (rawValue === undefined) return undefined;

  const quoted = rawValue.match(/^(['"])([\s\S]*)\1$/);
  if (quoted) return quoted[2];
  if (constants.has(rawValue)) return constants.get(rawValue);

  throw new Error(`Could not resolve ${field} value "${rawValue}" in ${source}`);
}

export function parseAssetRegistryText(content, source = '<registry>') {
  const registryMatch = content.match(
    /export const ASSET_REGISTRY: Record<string, RegisteredAsset> = (\{[\s\S]*?\n\};?)/,
  );
  if (!registryMatch) {
    throw new Error(`Could not find ASSET_REGISTRY in ${source}`);
  }

  const constants = new Map(
    [...content.matchAll(/export const ([A-Z0-9_]+)\s*=\s*(['"])(.*?)\2\s*;?/g)].map(
      ([, name, , value]) => [name, value],
    ),
  );
  const assetBlocks = registryMatch[1].split(/\n\s*([A-Z0-9]+):\s*\{/);
  const assets = [];

  for (let i = 1; i < assetBlocks.length; i += 2) {
    const key = assetBlocks[i];
    const block = assetBlocks[i + 1];
    const rawField = (field) =>
      block.match(new RegExp(`^\\s*${field}:\\s*([^,\\n]+)`, 'm'))?.[1].trim();
    const stringField = (field) =>
      resolveStringValue(rawField(field), constants, field, source);

    const asset = {
      key,
      code: stringField('code'),
      issuer: stringField('issuer') ?? '',
      network: stringField('network'),
      homeDomain: stringField('homeDomain'),
      kind: stringField('kind'),
      sacContractId: stringField('sacContractId'),
    };

    if (!asset.code) throw new Error(`Asset ${key} has no code in ${source}`);
    if (!asset.network) throw new Error(`Asset ${key} has no network in ${source}`);
    assets.push(asset);
  }

  return assets;
}

export function parseAssetRegistry(filePath) {
  return parseAssetRegistryText(readFileSync(filePath, 'utf8'), filePath);
}

export function normalizeRegistry(assets) {
  return Object.fromEntries(
    [...assets]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map(({ key, code, issuer, network, homeDomain, sacContractId }) => [
        key,
        {
          code,
          issuer,
          network,
          homeDomain: homeDomain ?? null,
          sacContractId: sacContractId ?? null,
        },
      ]),
  );
}

export function assertRegistryParity(walletAssets, mobileAssets) {
  const wallet = normalizeRegistry(walletAssets);
  const mobile = normalizeRegistry(mobileAssets);
  if (JSON.stringify(wallet) !== JSON.stringify(mobile)) {
    throw new Error(
      `Wallet and mobile asset registries differ.\nWallet: ${JSON.stringify(wallet, null, 2)}\nMobile: ${JSON.stringify(mobile, null, 2)}`,
    );
  }
  return wallet;
}

export function parseTomlCurrencies(tomlText) {
  let parsed;
  try {
    parsed = toml.parse(tomlText);
  } catch (error) {
    throw new Error(`stellar.toml could not be parsed: ${errorMessage(error)}`);
  }

  if (!Array.isArray(parsed.CURRENCIES) || parsed.CURRENCIES.length === 0) {
    throw new Error('stellar.toml has no CURRENCIES entries');
  }
  return parsed.CURRENCIES;
}

export function hasExactTomlCurrency(currencies, asset) {
  return currencies.some(
    (currency) => currency?.code === asset.code && currency?.issuer === asset.issuer,
  );
}

export function deriveSacContractId(asset) {
  if (!asset.sacContractId) return null;
  const network = STELLAR_NETWORKS[asset.network];
  if (!network) {
    throw new Error(
      `Cannot derive SAC for ${asset.code}:${asset.issuer}: unsupported network "${asset.network}"`,
    );
  }

  const derived = new Asset(asset.code, asset.issuer).contractId(network.passphrase);
  if (derived !== asset.sacContractId) {
    throw new Error(
      `SAC mismatch for ${asset.code}:${asset.issuer} on ${asset.network}: derived ${derived}, registry has ${asset.sacContractId}`,
    );
  }
  return derived;
}

export async function fetchTomlText(
  domain,
  {
    fetchImpl = fetch,
    timeoutMs = 10_000,
    createTimeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  } = {},
) {
  const url = `https://${domain}/.well-known/stellar.toml`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'Veil asset registry verifier',
      },
      redirect: 'follow',
      signal: createTimeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `Failed to fetch stellar.toml for declared home_domain ${domain}: ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch stellar.toml for declared home_domain ${domain}: HTTP ${response.status}`,
    );
  }

  try {
    return { url, text: await response.text() };
  } catch (error) {
    throw new Error(
      `Failed to read stellar.toml for declared home_domain ${domain}: ${errorMessage(error)}`,
    );
  }
}

export async function loadHorizonAccount(
  asset,
  {
    fetchImpl = fetch,
    timeoutMs = 10_000,
    createTimeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  } = {},
) {
  const network = STELLAR_NETWORKS[asset.network];
  if (!network) {
    throw new Error(
      `Asset ${asset.code}:${asset.issuer} claims unsupported network "${asset.network}"`,
    );
  }

  const url = `${network.horizon}/accounts/${asset.issuer}`;
  let response;
  try {
    response = await fetchImpl(url, { signal: createTimeoutSignal(timeoutMs) });
  } catch (error) {
    throw new Error(
      `Failed to load issuer ${asset.issuer} for ${asset.code} from Horizon ${asset.network}: ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Issuer ${asset.issuer} for ${asset.code} does not exist on ${asset.network} (Horizon HTTP ${response.status})`,
    );
  }

  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      `Invalid Horizon response for issuer ${asset.issuer} on ${asset.network}: ${errorMessage(error)}`,
    );
  }
}

export async function verifyNonNativeAsset(
  asset,
  {
    loadAccount = (entry) => loadHorizonAccount(entry),
    fetchToml = (domain) => fetchTomlText(domain),
  } = {},
) {
  if (!STELLAR_NETWORKS[asset.network]) {
    throw new Error(
      `Asset ${asset.code}:${asset.issuer} claims unsupported network "${asset.network}"`,
    );
  }
  if (!asset.issuer) {
    throw new Error(`Non-native asset ${asset.code} has no pinned issuer`);
  }

  const account = await loadAccount(asset);
  if (!account || account.account_id !== asset.issuer) {
    throw new Error(
      `Issuer identity mismatch for ${asset.code} on ${asset.network}: registry pins "${asset.issuer}", Horizon returned "${account?.account_id ?? 'no account_id'}"`,
    );
  }

  // Restored: #892 moved this declaration and the merge dropped it while
  // keeping both usages below, so every asset that got past the home_domain
  // check died on a ReferenceError rather than being verified.
  const derivedSacContractId = deriveSacContractId(asset);
  const homeDomain = account.home_domain;
  if (!homeDomain) {
    return {
      code: asset.code,
      issuer: asset.issuer,
      network: asset.network,
      homeDomain: null,
      tomlUrl: null,
      derivedSacContractId,
      note: 'issuer has no home_domain; stellar.toml corroboration is unavailable',
    };
  }

  if (asset.homeDomain && homeDomain !== asset.homeDomain) {
    throw new Error(
      `Issuer ${asset.issuer} for ${asset.code} home_domain mismatch: Horizon returned "${homeDomain}", registry expected "${asset.homeDomain}"`,
    );
  }

  const tomlData = await fetchToml(homeDomain);
  if (!tomlData || typeof tomlData.text !== 'string') {
    throw new Error(
      `Failed to fetch stellar.toml from declared home_domain "${homeDomain}" for ${asset.code}:${asset.issuer}`,
    );
  }

  const currencies = parseTomlCurrencies(tomlData.text);
  if (!hasExactTomlCurrency(currencies, asset)) {
    throw new Error(
      `stellar.toml at ${tomlData.url ?? homeDomain} does not contain exact currency pair ${asset.code}:${asset.issuer}`,
    );
  }

  return {
    code: asset.code,
    issuer: asset.issuer,
    network: asset.network,
    homeDomain,
    tomlUrl: tomlData.url ?? `https://${homeDomain}/.well-known/stellar.toml`,
    derivedSacContractId,
    note: `stellar.toml corroborates exact pair ${asset.code}:${asset.issuer}`,
  };
}

export async function verifyAssetResult(asset, dependencies = {}) {
  try {
    return { ok: true, value: await verifyNonNativeAsset(asset, dependencies) };
  } catch (error) {
    return { ok: false, error };
  }
}

export async function main() {
  console.log('--- Verifying Asset Registry by Exact Issuer Identity ---');

  try {
    const walletAssets = parseAssetRegistry(walletAssetsPath);
    const mobileAssets = parseAssetRegistry(mobileAssetsPath);
    assertRegistryParity(walletAssets, mobileAssets);
    console.log(
      `Registry parity verified for wallet and mobile: ${walletAssets.map((asset) => asset.code).join(', ')}`,
    );

    let errors = 0;
    for (const asset of walletAssets.filter((entry) => entry.kind !== 'native')) {
      const result = await verifyAssetResult(asset);
      if (!result.ok) {
        console.error(`  ✕ ${asset.code}:${asset.issuer} — ${errorMessage(result.error)}`);
        errors += 1;
        continue;
      }

      console.log(
        `  ✓ ${asset.code}:${asset.issuer} verified on ${asset.network} — ${result.value.note}`,
      );
    }

    if (errors > 0) {
      console.error(`FAILED: ${errors} asset registry verification error(s) found.`);
      return 1;
    }

    console.log('SUCCESS: All non-native registry entries verified by exact issuer identity.');
    return 0;
  } catch (error) {
    console.error(`FATAL ERROR: ${errorMessage(error)}`);
    return 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  process.exitCode = await main();
}

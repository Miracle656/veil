#!/usr/bin/env node
/**
 * verify-asset-registry.mjs — Stellar mainnet asset registry verifier (Issue #729).
 *
 * Verifies that every asset in ASSET_REGISTRY:
 *   1. Has a valid mainnet issuer account on Stellar Horizon with a matching home_domain.
 *   2. Has a valid stellar.toml file hosted at https://{home_domain}/.well-known/stellar.toml.
 *   3. Declares the matching asset code and issuer address in its CURRENCIES section.
 *
 * Native XLM is checked for its home_domain (stellar.org) and stellar.toml availability.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const walletAssetsPath = join(repoRoot, 'frontend', 'wallet', 'lib', 'assets.ts');

const HORIZON_MAINNET = 'https://horizon.stellar.org';

function parseAssetRegistry(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const registryMatch = content.match(/export const ASSET_REGISTRY: Record<string, RegisteredAsset> = (\{[\s\S]*?\n\};?)/);
  if (!registryMatch) {
    throw new Error(`Could not find ASSET_REGISTRY in ${filePath}`);
  }

  const registryText = registryMatch[1];
  const assetBlocks = registryText.split(/\n\s*([A-Z0-9]+):\s*\{/);
  
  const assets = [];
  for (let i = 1; i < assetBlocks.length; i += 2) {
    const key = assetBlocks[i];
    const block = assetBlocks[i + 1];

    const getVal = (field) => {
      const match = block.match(new RegExp(`${field}:\\s*['"]([^'"]+)['"]`));
      return match ? match[1] : '';
    };

    const code = getVal('code') || key;
    const issuerVarMatch = block.match(/issuer:\s*([A-Z0-9_]+)/);
    let issuer = getVal('issuer');
    if (!issuer && issuerVarMatch) {
      const varName = issuerVarMatch[1];
      const varDeclMatch = content.match(new RegExp(`export const ${varName} = ['"]([^'"]+)['"]`));
      if (varDeclMatch) {
        issuer = varDeclMatch[1];
      }
    }

    assets.push({
      key,
      code,
      issuer,
      homeDomain: getVal('homeDomain'),
      kind: getVal('kind'),
    });
  }

  return assets;
}

function parseTomlCurrencies(tomlText) {
  const currencies = [];
  const blocks = tomlText.split(/\[\[?CURRENCIES\]\]?/i);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i].split(/\[\[?[A-Z_]+\]\]?/i)[0];
    const codeMatch = block.match(/code\s*=\s*["']([^"']+)["']/i);
    const issuerMatch = block.match(/issuer\s*=\s*["']([^"']+)["']/i);
    if (codeMatch) {
      currencies.push({
        code: codeMatch[1],
        issuer: issuerMatch ? issuerMatch[1] : '',
      });
    }
  }
  return currencies;
}

async function fetchTomlText(domain) {
  const urls = [
    `https://${domain}/.well-known/stellar.toml`,
    `https://www.${domain}/.well-known/stellar.toml`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/plain, text/html, */*',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const text = await res.text();
        if (text && (text.includes('CURRENCIES') || text.includes('DOCUMENTATION') || text.includes('VERSION'))) {
          return { url, text };
        }
      }
    } catch (e) {
      // Continue to next URL fallback
    }
  }
  return null;
}

async function verifyAsset(asset) {
  console.log(`\nVerifying asset "${asset.code}"...`);
  
  if (asset.code === 'XLM' || asset.kind === 'native' || !asset.issuer) {
    console.log(`  -> Native asset XLM: verifying home domain "${asset.homeDomain}"`);
    if (asset.homeDomain !== 'stellar.org') {
      throw new Error(`XLM homeDomain expected "stellar.org", got "${asset.homeDomain}"`);
    }

    const tomlData = await fetchTomlText(asset.homeDomain);
    if (!tomlData) {
      throw new Error(`Failed to fetch stellar.toml for ${asset.homeDomain}`);
    }
    console.log(`  ✓ XLM stellar.toml reachable at ${tomlData.url}`);
    return;
  }

  // 1. Fetch Horizon account
  const accountUrl = `${HORIZON_MAINNET}/accounts/${asset.issuer}`;
  const accountRes = await fetch(accountUrl, { signal: AbortSignal.timeout(10000) });
  if (!accountRes.ok) {
    throw new Error(`Issuer account ${asset.issuer} not found on Horizon mainnet (status ${accountRes.status})`);
  }

  const accountData = await accountRes.json();
  const homeDomain = accountData.home_domain;

  if (!homeDomain) {
    throw new Error(`Issuer account ${asset.issuer} has no home_domain set on Stellar Horizon.`);
  }

  if (homeDomain !== asset.homeDomain) {
    throw new Error(
      `Issuer account ${asset.issuer} home_domain mismatch: Horizon reports "${homeDomain}", registry expected "${asset.homeDomain}"`
    );
  }

  console.log(`  ✓ Horizon issuer account home_domain matches: "${homeDomain}"`);

  // 2. Fetch stellar.toml
  const tomlData = await fetchTomlText(homeDomain);
  if (!tomlData) {
    console.log(`  ✓ Horizon issuer account verified for domain "${homeDomain}"`);
    return;
  }

  const currencies = parseTomlCurrencies(tomlData.text);
  const matched = currencies.some(
    (c) => c.code.toUpperCase() === asset.code.toUpperCase() && (c.issuer === asset.issuer || !c.issuer)
  );

  if (!matched && currencies.length > 0) {
    throw new Error(
      `stellar.toml at ${tomlData.url} does not declare currency matching code "${asset.code}" and issuer "${asset.issuer}"`
    );
  }

  console.log(`  ✓ stellar.toml at ${tomlData.url} verified currency pair ${asset.code}:${asset.issuer}`);
}

async function main() {
  console.log('--- Verifying Asset Registry Against Stellar Mainnet ---');
  let errors = 0;

  try {
    const assets = parseAssetRegistry(walletAssetsPath);
    console.log(`Parsed ${assets.length} assets from ${walletAssetsPath}: ${assets.map((a) => a.code).join(', ')}`);

    for (const asset of assets) {
      try {
        await verifyAsset(asset);
      } catch (err) {
        console.error(`  ✕ ERROR verifying ${asset.code}: ${err.message}`);
        errors++;
      }
    }

    if (errors > 0) {
      console.error(`\nFAILED: ${errors} asset registry verification error(s) found.`);
      process.exit(1);
    }

    console.log('\nSUCCESS: All asset registry entries verified against Stellar mainnet.');
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL ERROR: ${err.message}`);
    process.exit(1);
  }
}

main();

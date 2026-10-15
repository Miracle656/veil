import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Asset, Keypair, Networks } from '@stellar/stellar-sdk';

import { parseAssetRegistry } from '../verify-asset-registry.mjs';
import { verifyOfflineRegistries } from '../verify-assets-offline.mjs';
import { checkAssetOnline } from '../verify-assets-online.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const walletPath = resolve(root, 'frontend/wallet/lib/assets.ts');
const mobilePath = resolve(root, 'frontend/mobile/lib/assets.ts');

const USDT0_ISSUER = 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q';
const USDT0_SAC = new Asset('USDT0', USDT0_ISSUER).contractId(Networks.PUBLIC);

function usdt0(overrides = {}) {
  return {
    key: 'USDT0',
    code: 'USDT0',
    issuer: USDT0_ISSUER,
    network: 'mainnet',
    homeDomain: undefined,
    kind: 'credit',
    sacContractId: USDT0_SAC,
    ...overrides,
  };
}

describe('offline asset registry verification', () => {
  test('passes on the real, in-sync wallet and mobile registries', () => {
    const wallet = parseAssetRegistry(walletPath);
    const mobile = parseAssetRegistry(mobilePath);

    assert(wallet.some((a) => a.key === 'USDT0'), 'wallet registry should contain USDT0');
    assert.deepEqual(verifyOfflineRegistries(wallet, mobile), []);
  });

  test('detects registry divergence when mobile is missing an asset', () => {
    const errors = verifyOfflineRegistries([usdt0()], []);
    assert(errors.some((e) => e.includes('missing in mobile registry')));
  });

  test('detects a field that differs between wallet and mobile', () => {
    const other = Keypair.random().publicKey();
    const errors = verifyOfflineRegistries([usdt0()], [usdt0({ issuer: other })]);
    assert(errors.some((e) => e.includes('"USDT0.issuer"')));
  });

  test('detects an invalid StrKey issuer address', () => {
    const bad = usdt0({ issuer: 'NOT_A_VALID_STRKEY_ADDRESS', sacContractId: undefined });
    const errors = verifyOfflineRegistries([bad], [bad]);
    assert(errors.some((e) => e.includes('invalid Ed25519 public key StrKey')));
  });

  test('detects a SAC contract id that does not derive from code + issuer', () => {
    const wrong = usdt0({ sacContractId: new Asset('USDT0', Keypair.random().publicKey()).contractId(Networks.PUBLIC) });
    const errors = verifyOfflineRegistries([wrong], [wrong]);
    assert(errors.some((e) => e.includes('SAC mismatch')));
  });

  test('does not require an issuer for the native asset', () => {
    const xlm = { key: 'XLM', code: 'XLM', issuer: '', network: 'mainnet', kind: 'native' };
    assert.deepEqual(verifyOfflineRegistries([xlm], [xlm]), []);
  });
});

/** A fetch stub that answers Horizon account lookups and stellar.toml requests. */
function stubFetch({ account, toml, horizonStatus = 200, tomlStatus = 200, reject = false }) {
  return async (url) => {
    if (reject) throw new Error('Connection refused');
    const target = String(url);
    if (target.includes('/accounts/')) {
      return new Response(JSON.stringify(account ?? {}), { status: horizonStatus });
    }
    if (target.endsWith('/.well-known/stellar.toml')) {
      return new Response(toml ?? '', { status: tomlStatus });
    }
    throw new Error(`Unexpected request: ${target}`);
  };
}

describe('online asset verification', () => {
  const issuer = USDT0_ISSUER;
  const impostor = Keypair.random().publicKey();

  test('passes the real USDT0 shape: issuer pinned, no home_domain', async () => {
    const result = await checkAssetOnline(usdt0(), {
      fetchImpl: stubFetch({ account: { account_id: issuer } }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.networkError, false);
  });

  test('passes when stellar.toml lists the exact code and issuer pair', async () => {
    const toml = `[[CURRENCIES]]\ncode = "USDT0"\nissuer = "${issuer}"\n`;
    const result = await checkAssetOnline(usdt0(), {
      fetchImpl: stubFetch({ account: { account_id: issuer, home_domain: 'example.org' }, toml }),
    });
    assert.equal(result.ok, true);
  });

  test('fails when stellar.toml names the code but a different issuer', async () => {
    const toml = `[[CURRENCIES]]\ncode = "USDT0"\nissuer = "${impostor}"\n`;
    const result = await checkAssetOnline(usdt0(), {
      fetchImpl: stubFetch({ account: { account_id: issuer, home_domain: 'example.org' }, toml }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.networkError, false);
    assert(result.issues[0].includes('exact currency pair'));
  });

  test('fails when code and issuer come from two different [[CURRENCIES]] blocks', async () => {
    const toml = [
      '[[CURRENCIES]]',
      'code = "USDT0"',
      `issuer = "${impostor}"`,
      '',
      '[[CURRENCIES]]',
      'code = "OTHER"',
      `issuer = "${issuer}"`,
      '',
    ].join('\n');
    const result = await checkAssetOnline(usdt0(), {
      fetchImpl: stubFetch({ account: { account_id: issuer, home_domain: 'example.org' }, toml }),
    });
    assert.equal(result.ok, false);
  });

  test('fails when the issuer only appears in a comment', async () => {
    const toml = `# USDT0 ${issuer}\n[[CURRENCIES]]\ncode = "USDT0"\nissuer = "${impostor}"\n`;
    const result = await checkAssetOnline(usdt0(), {
      fetchImpl: stubFetch({ account: { account_id: issuer, home_domain: 'example.org' }, toml }),
    });
    assert.equal(result.ok, false);
  });

  test('fails when Horizon returns a different account than the pinned issuer', async () => {
    const result = await checkAssetOnline(usdt0(), {
      fetchImpl: stubFetch({ account: { account_id: impostor } }),
    });
    assert.equal(result.ok, false);
    assert(result.issues[0].includes('Issuer identity mismatch'));
  });

  test('treats a Horizon 404 as a verification failure, not a network error', async () => {
    const result = await checkAssetOnline(usdt0(), {
      fetchImpl: stubFetch({ horizonStatus: 404 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.networkError, false);
    assert(result.issues[0].includes('does not exist'));
  });

  test('flags an unreachable network as a network error', async () => {
    const result = await checkAssetOnline(usdt0(), { fetchImpl: stubFetch({ reject: true }) });
    assert.equal(result.ok, false);
    assert.equal(result.networkError, true);
  });

  test('flags a third-party 5xx as a network error', async () => {
    const result = await checkAssetOnline(usdt0(), {
      fetchImpl: stubFetch({ horizonStatus: 503 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.networkError, true);
  });
});

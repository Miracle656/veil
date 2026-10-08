import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { StrKey } from '@stellar/stellar-sdk';
import { fileURLToPath } from 'node:url';

import {
  assertRegistryParity,
  deriveSacContractId,
  fetchTomlText,
  loadHorizonAccount,
  parseAssetRegistry,
  parseTomlCurrencies,
  verifyAssetResult,
} from '../verify-asset-registry.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const walletAssetsPath = join(repoRoot, 'frontend', 'wallet', 'lib', 'assets.ts');
const mobileAssetsPath = join(repoRoot, 'frontend', 'mobile', 'lib', 'assets.ts');

const GENUINE_USDT0_ISSUER =
  'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q';
const USDT0_SAC = 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF';
const USDT0_IMPOSTORS = [
  'GC35JBERU4SFTDVOF32A2SIJN5FHSLSZFZSGP6VVFWCZNDVGJFLQBANK',
  'GADUBOKGYG4E2BZUVXAZBBILGPIYIPOXAXWIIG6DJ4JDXWOQR67HUSDT',
  'GBL35PWBKAHURS7SMATHXTS5X57BHC23P2B6MOJTDXTDKD7K25QHUSDT',
  'GAKSY7RQI4YG3H5J5WRYHB4FDEJ2PAQJ6IN3P47HNG6KGUJJ2YOD7ZP3',
  'GA7GNGYVJHF7LTI6OO4FAD2JEQBIQWRBIZOLEZSJJHMNAY6UUZERU526',
  'GAVRQZHG726XIHZKP3MODI3DOUP7IIQ6CC6OJX4JJD7PXRV4FJ3WE77O',
  'GDBDGR2U3KVHUGJ5SVALIAPT7FBPSYWD25XTF4JPHTPBKFH2SHOOHZFF',
];

const usdt0 = {
  key: 'USDT0',
  code: 'USDT0',
  issuer: GENUINE_USDT0_ISSUER,
  network: 'mainnet',
  homeDomain: undefined,
  kind: 'stablecoin',
  sacContractId: USDT0_SAC,
};

const exactToml = (code, issuer) => `
VERSION = "2.0.0"

[[CURRENCIES]]
code = "${code}"
issuer = "${issuer}"
`;

const declaredDomainAccount = {
  account_id: GENUINE_USDT0_ISSUER,
  home_domain: 'issuer.example',
};

test('current wallet and mobile registries match and pin the derived USDT0 SAC', () => {
  const wallet = parseAssetRegistry(walletAssetsPath);
  const mobile = parseAssetRegistry(mobileAssetsPath);
  assert.doesNotThrow(() => assertRegistryParity(wallet, mobile));

  const walletUsdt0 = wallet.find((asset) => asset.code === 'USDT0');
  assert.deepEqual(walletUsdt0, usdt0);
  assert.equal(deriveSacContractId(walletUsdt0), USDT0_SAC);
});

test('registry parity rejects a security-relevant issuer difference', () => {
  const wallet = parseAssetRegistry(walletAssetsPath);
  const mobile = parseAssetRegistry(mobileAssetsPath);
  const divergent = mobile.map((asset) =>
    asset.code === 'USDT0' ? { ...asset, issuer: USDT0_IMPOSTORS[0] } : asset,
  );

  assert.throws(() => assertRegistryParity(wallet, divergent), /registries differ/);
});

test('genuine USDT0 passes exact issuer verification without home_domain', async () => {
  let tomlFetches = 0;
  const result = await verifyAssetResult(usdt0, {
    loadAccount: async () => ({ account_id: GENUINE_USDT0_ISSUER }),
    fetchToml: async () => {
      tomlFetches += 1;
      throw new Error('must not fetch');
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.homeDomain, null);
  assert.equal(result.value.derivedSacContractId, USDT0_SAC);
  assert.match(result.value.note, /no home_domain/);
  assert.equal(tomlFetches, 0);
});

test('all eight USDT0 candidates accept exactly one genuine issuer', async () => {
  const candidates = [GENUINE_USDT0_ISSUER, ...USDT0_IMPOSTORS];
  assert.equal(new Set(candidates).size, 8);
  const accepted = [];
  let impostorTomlFetches = 0;

  for (const candidate of candidates) {
    const result = await verifyAssetResult(usdt0, {
      loadAccount: async () => ({
        account_id: candidate,
        home_domain: candidate === GENUINE_USDT0_ISSUER ? undefined : `${candidate}.example`,
      }),
      fetchToml: async () => {
        impostorTomlFetches += 1;
        return {
          url: 'https://fixture.example/.well-known/stellar.toml',
          text: exactToml('USDT0', candidate),
        };
      },
    });
    if (result.ok) accepted.push(candidate);
  }

  assert.equal(accepted.length, 1);
  assert.equal(accepted[0], GENUINE_USDT0_ISSUER);
  assert.equal(impostorTomlFetches, 0, 'identity mismatches must fail before TOML is consulted');
  console.log(`USDT0 accepted issuers (${accepted.length}/8): ${accepted.join(', ')}`);
});

test('stellar.toml is requested only from the literal declared home_domain', async () => {
  const requestedUrls = [];
  const result = await fetchTomlText('issuer.example', {
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => exactToml('USDT0', GENUINE_USDT0_ISSUER),
      };
    },
    createTimeoutSignal: () => undefined,
  });

  assert.equal(result.url, 'https://issuer.example/.well-known/stellar.toml');
  assert.deepEqual(requestedUrls, ['https://issuer.example/.well-known/stellar.toml']);
});

test('a declared domain whose fetch rejects fails closed', async () => {
  const result = await verifyAssetResult(usdt0, {
    loadAccount: async () => declaredDomainAccount,
    fetchToml: async () => {
      throw new Error('network unavailable');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /network unavailable/);
});

test('a declared domain whose request times out fails closed', async () => {
  const timeout = new Error('request timed out');
  timeout.name = 'TimeoutError';
  const result = await verifyAssetResult(usdt0, {
    loadAccount: async () => declaredDomainAccount,
    fetchToml: async () => {
      throw timeout;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.name, 'TimeoutError');
});

test('an unsuccessful stellar.toml HTTP response fails closed', async () => {
  await assert.rejects(
    fetchTomlText('issuer.example', {
      fetchImpl: async () => ({ ok: false, status: 503 }),
      createTimeoutSignal: () => undefined,
    }),
    /HTTP 503/,
  );
});

test('an unreadable stellar.toml response body fails closed', async () => {
  await assert.rejects(
    fetchTomlText('issuer.example', {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error('socket closed');
        },
      }),
      createTimeoutSignal: () => undefined,
    }),
    /socket closed/,
  );
});

test('malformed TOML fails parsing', () => {
  assert.throws(
    () => parseTomlCurrencies('[[CURRENCIES]\ncode = "USDT0"'),
    /could not be parsed/,
  );
});

test('missing and empty CURRENCIES fail', () => {
  assert.throws(() => parseTomlCurrencies('VERSION = "2.0.0"'), /no CURRENCIES entries/);
  assert.throws(() => parseTomlCurrencies('CURRENCIES = []'), /no CURRENCIES entries/);
});

test('same code with another issuer is not corroboration', async () => {
  const result = await verifyAssetResult(usdt0, {
    loadAccount: async () => declaredDomainAccount,
    fetchToml: async () => ({
      url: 'https://issuer.example/.well-known/stellar.toml',
      text: exactToml('USDT0', USDT0_IMPOSTORS[0]),
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /does not contain exact currency pair/);
});

test('same code with no issuer is not corroboration', async () => {
  const result = await verifyAssetResult(usdt0, {
    loadAccount: async () => declaredDomainAccount,
    fetchToml: async () => ({
      url: 'https://issuer.example/.well-known/stellar.toml',
      text: '[[CURRENCIES]]\ncode = "USDT0"',
    }),
  });

  assert.equal(result.ok, false);
});

test('different code with the exact issuer is not corroboration', async () => {
  const result = await verifyAssetResult(usdt0, {
    loadAccount: async () => declaredDomainAccount,
    fetchToml: async () => ({
      url: 'https://issuer.example/.well-known/stellar.toml',
      text: exactToml('USDT', GENUINE_USDT0_ISSUER),
    }),
  });

  assert.equal(result.ok, false);
});

test('exact code and exact issuer corroborate successfully', async () => {
  const result = await verifyAssetResult(usdt0, {
    loadAccount: async () => declaredDomainAccount,
    fetchToml: async (domain) => ({
      url: `https://${domain}/.well-known/stellar.toml`,
      text: exactToml('USDT0', GENUINE_USDT0_ISSUER),
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.homeDomain, 'issuer.example');
  assert.match(result.value.note, /corroborates exact pair/);
});

test('a nonexistent Horizon issuer fails', async () => {
  const result = await verifyAssetResult(usdt0, {
    loadAccount: async () => {
      throw new Error('Horizon HTTP 404');
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error.message, /404/);
});

test('an issuer looked up on the wrong network fails', async () => {
  let requestedUrl = '';
  const testnetAsset = { ...usdt0, network: 'testnet', sacContractId: undefined };
  const result = await verifyAssetResult(testnetAsset, {
    loadAccount: (asset) =>
      loadHorizonAccount(asset, {
        fetchImpl: async (url) => {
          requestedUrl = url;
          return { ok: false, status: 404 };
        },
        createTimeoutSignal: () => undefined,
      }),
  });

  assert.equal(result.ok, false);
  assert.match(requestedUrl, /^https:\/\/horizon-testnet\.stellar\.org\/accounts\//);
  assert.match(result.error.message, /does not exist on testnet/);
});

test('representative error paths produce failure results, never success', async () => {
  const failureDependencies = [
    { loadAccount: async () => null },
    { loadAccount: async () => ({ account_id: USDT0_IMPOSTORS[0] }) },
    {
      loadAccount: async () => declaredDomainAccount,
      fetchToml: async () => ({ url: 'fixture', text: 'CURRENCIES = []' }),
    },
    {
      loadAccount: async () => declaredDomainAccount,
      fetchToml: async () => ({
        url: 'fixture',
        text: exactToml('USDT0', USDT0_IMPOSTORS[0]),
      }),
    },
  ];

  const results = await Promise.all(
    failureDependencies.map((dependencies) => verifyAssetResult(usdt0, dependencies)),
  );
  assert.deepEqual(results.map((result) => result.ok), [false, false, false, false]);
});

test('USDT0 SAC mismatch fails instead of trusting the stored literal', () => {
  assert.throws(
    () => deriveSacContractId({ ...usdt0, sacContractId: `C${'A'.repeat(55)}` }),
    /SAC mismatch/,
  );
});

// ── Exhaustive checksum validation ───────────────────────────────────────────
//
// An invalid Stellar address has reached a PR four times. Each time the guards
// that existed let it through, for two reasons worth stating plainly:
//
//   1. `assertRegistryParity` compares the wallet and mobile registries to each
//      other. An address that is wrong *identically* in both is agreed upon,
//      not caught — and a contributor editing one copy usually copies it into
//      the other, so identical-wrong is the normal shape of the bug.
//   2. The checks that do validate an address name specific constants, so they
//      only ever cover the assets someone remembered to add them for. A newly
//      registered asset arrives with no check at all.
//
// The failure is quiet and inverted, which is what makes it dangerous: an
// issuer that cannot be parsed makes the *genuine* asset fail verification and
// be labelled an impersonator, which reads exactly like the feature working.
//
// `StrKey` verifies the CRC16-XModem checksum. A regex over length and the
// base32 alphabet does not, and every bad address so far satisfied one — most
// recently a 55-character BENJI issuer that differed from the real one by a
// single dropped character.
for (const [label, path] of [
  ['wallet', walletAssetsPath],
  ['mobile', mobileAssetsPath],
]) {
  test(`every ${label} non-native registry issuer is checksum-valid`, () => {
    const assets = parseAssetRegistry(path).filter((asset) => asset.kind !== 'native');
    assert.ok(assets.length > 0, `${label} registry parsed as empty — the assertions below would pass vacuously`);
    for (const asset of assets) {
      assert.ok(
        StrKey.isValidEd25519PublicKey(asset.issuer),
        `${label} registry: ${asset.key} (${asset.code}) issuer is not a valid Stellar account id: ${asset.issuer}`,
      );
    }
  });

  test(`every ${label} registry SAC contract id is checksum-valid`, () => {
    for (const asset of parseAssetRegistry(path).filter((a) => a.sacContractId)) {
      assert.ok(
        StrKey.isValidContract(asset.sacContractId),
        `${label} registry: ${asset.key} (${asset.code}) sacContractId is not a valid contract id: ${asset.sacContractId}`,
      );
    }
  });

  // Checksum validity is necessary and nowhere near sufficient. A SAC is
  // derived deterministically from (code, issuer, network passphrase), so the
  // only question worth asking is whether the pinned id is the contract this
  // asset actually has — and a *different real* contract passes every shape
  // and checksum test there is.
  //
  // This is not hypothetical. A PR this week pinned
  // `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` as the testnet
  // USDC SAC. It is a perfectly valid contract id — it is the testnet SAC for
  // native XLM, pinned correctly as exactly that in `lib/privacy/config.ts`,
  // which is almost certainly where it was copied from. Had it landed, an XLM
  // balance would have been labelled USDC and multiplied by the USDC price,
  // while real testnet USDC fell through as unrecognised.
  test(`every ${label} registry SAC derives from its own issuer`, () => {
    for (const asset of parseAssetRegistry(path).filter((a) => a.sacContractId)) {
      // Throws with both the derived and the registered id on mismatch.
      assert.doesNotThrow(
        () => deriveSacContractId(asset),
        `${label} registry: ${asset.key} (${asset.code}) pins a SAC that does not derive from its issuer`,
      );
    }
  });
}

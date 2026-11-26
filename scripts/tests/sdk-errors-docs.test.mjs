// Drift test for the WalletError table in frontend/docs/pages/sdk-errors.mdx
// (issue #1404).
//
// The table once stopped at code 20 while the enum had 31, so a developer who
// saw `Error(Contract, #25)` looked it up and found nothing. This test reads
// `pub enum WalletError` from the wallet's lib.rs and fails if any code or
// name is missing from the table, or if a row has no cause or remedy.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const walletLib = join(repoRoot, 'contracts', 'invisible_wallet', 'src', 'lib.rs');
const errorsPage = join(repoRoot, 'frontend', 'docs', 'pages', 'sdk-errors.mdx');

const MAINNET_VALUES = new Set(['Yes', 'Partly', 'Source only', 'Mainnet only', 'Not returned']);

/** `{ name, code }` for every variant of `pub enum WalletError`. */
export function walletErrorVariants(rustSource) {
  // Drop comments first: the enum's doc comments mention other variants.
  const src = rustSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const m = /pub\s+enum\s+WalletError\s*\{([^}]*)\}/.exec(src);
  if (!m) throw new Error('pub enum WalletError not found');
  return [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/g)].map((v) => ({
    name: v[1],
    code: Number(v[2]),
  }));
}

/** Rows of the table under "## Contract error codes", keyed by code. */
export function tableRows(markdown) {
  const text = markdown.replace(/\r\n/g, '\n');
  const start = text.indexOf('## Contract error codes (`WalletError`)');
  if (start === -1) return new Map();
  const rest = text.slice(start);
  const next = rest.indexOf('\n## ', 1);
  const section = next === -1 ? rest : rest.slice(0, next);
  const rows = new Map();
  for (const line of section.split('\n')) {
    if (!/^\|\s*\d+\s*\|/.test(line)) continue;
    // Split on pipes that are not escaped (`\|` appears inside code spans).
    const cells = line
      .split(/(?<!\\)\|/)
      .slice(1, -1)
      .map((c) => c.trim());
    rows.set(Number(cells[0]), cells);
  }
  return rows;
}

/** Problems with the table, as strings. Empty means OK. */
export function checkTable(markdown, variants) {
  const rows = tableRows(markdown);
  const problems = [];
  for (const { name, code } of variants) {
    const cells = rows.get(code);
    if (!cells) {
      problems.push(`code ${code} (${name}) has no row`);
      continue;
    }
    const [, rowName, mainnet, cause, remedy] = cells;
    if (rowName !== `\`${name}\``) {
      problems.push(`code ${code}: row names ${rowName}, enum says \`${name}\``);
    }
    if (!MAINNET_VALUES.has(mainnet)) {
      problems.push(`code ${code} (${name}): Mainnet column is "${mainnet ?? ''}"`);
    }
    if (!cause) problems.push(`code ${code} (${name}) has no cause`);
    if (!remedy) problems.push(`code ${code} (${name}) has no remedy`);
  }
  const known = new Set(variants.map((v) => v.code));
  for (const code of rows.keys()) {
    if (!known.has(code)) problems.push(`row for code ${code}, which is not in the enum`);
  }
  return problems;
}

const variants = walletErrorVariants(readFileSync(walletLib, 'utf8'));
const page = readFileSync(errorsPage, 'utf8');

test('reads the WalletError enum', () => {
  // A floor, not an exact count: a new variant must fail the table check
  // below, not this one.
  assert.ok(variants.length >= 31, `found ${variants.length} variants`);
  assert.deepEqual(variants.find((v) => v.code === 25), {
    name: 'UserVerificationRequired',
    code: 25,
  });
  assert.equal(new Set(variants.map((v) => v.code)).size, variants.length, 'duplicate codes');
});

test('every WalletError code and name has a row with a cause and a remedy', () => {
  assert.deepEqual(checkTable(page, variants), []);
});

test('the check fails when a row is removed', () => {
  const broken = page.replace(/^\| 25 \|[^\n]*\n/m, '');
  assert.notEqual(broken, page, 'fixture: row 25 not found');
  assert.deepEqual(checkTable(broken, variants), ['code 25 (UserVerificationRequired) has no row']);
});

test('the check fails when a row has the wrong name', () => {
  const broken = page.replace('| 30 | `SpendLimitTokenNotAllowed` |', '| 30 | `SpendLimitExceeded` |');
  assert.notEqual(broken, page, 'fixture: row 30 not found');
  assert.deepEqual(checkTable(broken, variants), [
    'code 30: row names `SpendLimitExceeded`, enum says `SpendLimitTokenNotAllowed`',
  ]);
});

test('the page does not advertise a helper that does not exist', () => {
  assert.doesNotMatch(page, /parseContractError/);
  assert.match(page, /Error\(Contract, #N\)/);
});

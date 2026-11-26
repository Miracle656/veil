// Drift test for frontend/docs/pages/contract-api.mdx (issue #1402).
//
// The Contract API page claims to document every public function of the
// wallet and the factory. It drifted badly once, so this test reads every
// `pub fn` from the `#[contractimpl]` block of each lib.rs and fails if the
// page has no heading for it, or if the heading has no Status line saying
// whether the function is live on mainnet. It also checks that the one
// WalletError table, on /sdk-errors, lists every variant.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const walletLib = join(repoRoot, 'contracts', 'invisible_wallet', 'src', 'lib.rs');
const factoryLib = join(repoRoot, 'contracts', 'factory', 'src', 'lib.rs');
const apiPage = join(repoRoot, 'frontend', 'docs', 'pages', 'contract-api.mdx');
const errorsPage = join(repoRoot, 'frontend', 'docs', 'pages', 'sdk-errors.mdx');

const FACTORY_SECTION = '## Factory contract';

/** Blank out comments and string/char literals so braces in them don't count. */
function stripRust(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\])*"/g, (m) => '"' + ' '.repeat(m.length - 2) + '"')
    .replace(/'(?:\\.|[^'\\])'/g, "' '");
}

/** Names of every `pub fn` inside the `#[contractimpl]` impl blocks. */
export function contractFunctions(rustSource) {
  const src = stripRust(rustSource);
  const names = [];
  let from = 0;
  for (;;) {
    const attr = src.indexOf('#[contractimpl]', from);
    if (attr === -1) break;
    const open = src.indexOf('{', attr);
    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === '{') depth++;
      else if (src[close] === '}' && --depth === 0) break;
    }
    const body = src.slice(open + 1, close);
    // Only functions at the top level of the impl block, not nested items.
    let level = 0;
    const re = /[{}]|\bpub\s+fn\s+([A-Za-z_][A-Za-z0-9_]*)/g;
    for (let m; (m = re.exec(body)); ) {
      if (m[0] === '{') level++;
      else if (m[0] === '}') level--;
      else if (level === 0) names.push(m[1]);
    }
    from = close;
  }
  return names;
}

/** Split the page into its `### `name`` sections, keyed by function name. */
export function functionSections(markdown) {
  const sections = new Map();
  const parts = markdown.split(/^### /m).slice(1);
  for (const part of parts) {
    const m = /^`([A-Za-z_][A-Za-z0-9_]*)`[ \t]*\r?\n/.exec(part);
    if (!m) continue;
    // A section ends at the next heading of level 2 or 3.
    const body = part.slice(m[0].length).split(/^#{1,2} /m)[0];
    sections.set(m[1], body);
  }
  return sections;
}

/** Problems with the page, as human-readable strings. Empty means OK. */
export function checkPage(page, { wallet, factory }) {
  const problems = [];
  const at = page.indexOf(`\n${FACTORY_SECTION}\n`);
  if (at === -1) {
    problems.push(`missing "${FACTORY_SECTION}" heading`);
    return problems;
  }
  const parts = [
    ['wallet', wallet, functionSections(page.slice(0, at))],
    ['factory', factory, functionSections(page.slice(at))],
  ];
  for (const [label, names, sections] of parts) {
    for (const name of names) {
      const body = sections.get(name);
      if (body === undefined) {
        problems.push(`${label} function \`${name}\` has no "### \`${name}\`" heading`);
      } else if (!/^\*\*Status:\*\* (Live on mainnet|Source only \(not deployed\))/m.test(body)) {
        problems.push(`${label} function \`${name}\` has no Status line`);
      }
    }
  }
  return problems;
}

/** Variant names of `pub enum WalletError`. */
export function walletErrorVariants(rustSource) {
  const src = stripRust(rustSource);
  const m = /pub\s+enum\s+WalletError\s*\{([^}]*)\}/.exec(src);
  assert.ok(m, 'pub enum WalletError not found');
  return [...m[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)/g)].map((v) => ({
    name: v[1],
    code: Number(v[2]),
  }));
}

const walletSource = readFileSync(walletLib, 'utf8');
const factorySource = readFileSync(factoryLib, 'utf8');
const page = readFileSync(apiPage, 'utf8');
const functions = {
  wallet: contractFunctions(walletSource),
  factory: contractFunctions(factorySource),
};

test('extracts the contract entrypoints, and nothing from test modules', () => {
  // Floors, not exact counts: adding a function must not need this test edited,
  // only the page. These are the counts at the time the page was rewritten.
  assert.ok(functions.wallet.length >= 29, `wallet: ${functions.wallet.length} functions`);
  assert.ok(functions.factory.length >= 4, `factory: ${functions.factory.length} functions`);
  for (const name of ['init', '__check_auth', 'revoke_allowance', 'cancel_recovery_request']) {
    assert.ok(functions.wallet.includes(name), `wallet should export ${name}`);
  }
  for (const name of ['__constructor', 'init', 'set_wasm_hash', 'deploy']) {
    assert.ok(functions.factory.includes(name), `factory should export ${name}`);
  }
  assert.equal(new Set(functions.wallet).size, functions.wallet.length, 'duplicate wallet names');
});

test('every wallet and factory pub fn has a heading and a Status line', () => {
  assert.deepEqual(checkPage(page, functions), []);
});

test('the check fails when a function heading is removed', () => {
  for (const [label, name] of [
    ['wallet', 'rotate_signer'],
    ['factory', 'set_wasm_hash'],
  ]) {
    const broken = page.replace(`### \`${name}\`\n`, '').replace(`### \`${name}\`\r\n`, '');
    assert.notEqual(broken, page, `fixture: heading for ${name} not found`);
    assert.deepEqual(checkPage(broken, functions), [
      `${label} function \`${name}\` has no "### \`${name}\`" heading`,
    ]);
  }
});

test('the check fails when a Status line is removed', () => {
  const broken = page.replace(
    /(### `get_nonce`\r?\n\r?\n)\*\*Status:\*\*[^\n]*\n/,
    '$1',
  );
  assert.notEqual(broken, page, 'fixture: get_nonce Status line not found');
  assert.deepEqual(checkPage(broken, functions), [
    'wallet function `get_nonce` has no Status line',
  ]);
});

test('the WalletError table on /sdk-errors lists every variant with its code', () => {
  const table = readFileSync(errorsPage, 'utf8');
  const missing = walletErrorVariants(walletSource).filter(
    ({ name, code }) => !new RegExp(`^\\| ${code} \\| \`${name}\` \\|`, 'm').test(table),
  );
  assert.deepEqual(missing, []);
});

test('the Contract API page keeps no copy of the WalletError table', () => {
  assert.doesNotMatch(page, /^\|[^\n]*\|\s*`AlreadyInitialized`\s*\|/m);
  assert.doesNotMatch(page, /pub enum WalletError/);
  assert.match(page, /\(\/sdk-errors#contract-error-codes-walleterror\)/);
});

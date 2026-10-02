/**
 * No voice or launcher path can sign.
 *
 * The rule: the assistant carries intent, the device authorises. Anything that
 * runs because of a shortcut, an App Intent or an AppFunction may read, but
 * must not be able to sign, reach key material or write to the network. Signing
 * happens only inside the app, behind a passkey ceremony the user completes.
 *
 * This is checked structurally rather than by testing each action:
 *
 *   1. Every module under `lib/voice/` is an entry point, found by listing the
 *      directory. A new file there is covered the moment it exists, with no edit
 *      to this test.
 *   2. From each entry point the test walks the real import graph (static
 *      imports, re-exports, `require` and dynamic `import()`, resolved the way
 *      TypeScript resolves them, `@/` alias included) and fails if it can reach
 *      the signer, a secret accessor or a network write.
 *   3. Every action's destination must be on an explicit allow-list of
 *      read-only screens.
 *
 * If this fails, the fix is almost never to edit this file. Move the signing
 * or secret-touching code out of the voice path, or read what you need through
 * something that holds no secrets.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

import type { ReadOnlyAction } from '../voice/actions';

const APP_ROOT = resolve(__dirname, '../..');
const VOICE_DIR = join(APP_ROOT, 'lib', 'voice');

const RULE =
  'Voice and launcher actions carry intent; the device authorises. Nothing under ' +
  'lib/voice/ may reach signing, key material or a network write (see #844).';

/** Modules that sign, or run the passkey ceremony that produces a signature. */
const SIGNING_MODULES: Record<string, string> = {
  'lib/walletConnect.ts': 'signXdrPayload() and registerAuthEntrySigner() live here',
  'lib/passkey.ts': 'runs passkey signing ceremonies',
  'lib/contractSpend.ts': 'builds, signs and submits wallet transactions',
};

/**
 * Modules that hold key material next to harmless data. They are checked by
 * the names imported from them, against an explicit allow-list, rather than
 * followed: reaching them is fine, asking them for a secret is not.
 */
const GUARDED_MODULES: Record<string, { allowed: string[]; why: string }> = {
  'lib/walletStore.ts': {
    allowed: ['getWalletAddress', 'hasUsableWallet'],
    why: 'the wallet store also holds the fee payer secret (getSignerSecret)',
  },
  'lib/storage.ts': {
    allowed: [],
    why: 'raw secure storage, where the secrets are',
  },
};

/** Packages a voice path must never import directly. */
const FORBIDDEN_PACKAGES: Record<string, string> = {
  'expo-secure-store': 'raw access to the keychain / keystore',
  'react-native-passkeys': 'passkey ceremonies',
};

/** Source patterns that write to the network. */
const NETWORK_WRITES: [RegExp, string][] = [
  [/\.sendTransaction\s*\(/, 'submits a transaction (sendTransaction)'],
  [/\.submitTransaction\s*\(/, 'submits a transaction (submitTransaction)'],
  [/method:\s*['"`](POST|PUT|PATCH|DELETE)['"`]/i, 'makes a write request'],
];

// ── Import graph ─────────────────────────────────────────────────────────────

const compilerOptions = ts.getParsedCommandLineOfConfigFile(
  join(APP_ROOT, 'tsconfig.json'),
  {},
  { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
)!.options;

type Edge = { specifier: string; names: string[] | 'all' };

/** Every module a file depends on, and which names it takes from each. */
function edgesOf(file: string): Edge[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const edges: Edge[] = [];

  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const typeOnly = ts.isImportDeclaration(node)
        ? node.importClause?.isTypeOnly
        : node.isTypeOnly;
      if (!typeOnly) edges.push({ specifier: node.moduleSpecifier.text, names: importedNames(node) });
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      ((ts.isIdentifier(node.expression) && node.expression.text === 'require') ||
        node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      edges.push({ specifier: node.arguments[0].text, names: 'all' });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

function importedNames(node: ts.ImportDeclaration | ts.ExportDeclaration): string[] | 'all' {
  if (ts.isExportDeclaration(node)) {
    if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return 'all';
    return node.exportClause.elements.map((e) => (e.propertyName ?? e.name).text);
  }
  const clause = node.importClause;
  if (!clause) return []; // side-effect import: runs the module, takes nothing
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return 'all';
  const names: string[] = [];
  if (clause.name) names.push('default');
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      if (!element.isTypeOnly) names.push((element.propertyName ?? element.name).text);
    }
  }
  return names;
}

type Resolved = { kind: 'project'; file: string } | { kind: 'package'; name: string } | null;

function resolveEdge(specifier: string, from: string): Resolved {
  const result = ts.resolveModuleName(specifier, from, compilerOptions, ts.sys).resolvedModule;
  if (!result) {
    // Unresolvable to TypeScript (e.g. an untyped package): treat as a package.
    return specifier.startsWith('.') ? null : { kind: 'package', name: packageName(specifier) };
  }
  if (result.isExternalLibraryImport) return { kind: 'package', name: packageName(specifier) };
  if (result.resolvedFileName.endsWith('.d.ts')) return null;
  return { kind: 'project', file: result.resolvedFileName };
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const rel = (file: string) => relative(APP_ROOT, file).split('\\').join('/');

/**
 * Walk from `entry` and return every rule it breaks, each with the import chain
 * that gets there.
 */
function violationsFrom(entry: string): string[] {
  const violations: string[] = [];
  const parent = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];

  const chainTo = (file: string): string => {
    const chain: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) chain.unshift(rel(at));
    return chain.join(' → ');
  };

  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = readFileSync(file, 'utf8');

    for (const [pattern, what] of NETWORK_WRITES) {
      if (pattern.test(source)) violations.push(`${chainTo(file)}\n    ${rel(file)} ${what}`);
    }

    for (const edge of edgesOf(file)) {
      const target = resolveEdge(edge.specifier, file);
      if (!target) continue;

      if (target.kind === 'package') {
        const why = FORBIDDEN_PACKAGES[target.name];
        if (why) violations.push(`${chainTo(file)}\n    imports ${target.name}: ${why}`);
        continue;
      }

      const name = rel(target.file);
      const signing = SIGNING_MODULES[name];
      if (signing) {
        violations.push(`${chainTo(file)} → ${name}\n    ${name} ${signing}`);
        continue;
      }

      const guard = GUARDED_MODULES[name];
      if (guard) {
        const taken = edge.names === 'all' ? ['* (everything)'] : edge.names;
        const refused = taken.filter((n) => !guard.allowed.includes(n));
        if (refused.length > 0) {
          violations.push(
            `${chainTo(file)} → ${name}\n    takes ${refused.join(', ')} from ${name}: ${guard.why}`,
          );
        }
        continue; // never follow into a guarded module
      }

      if (!parent.has(target.file)) {
        parent.set(target.file, file);
        queue.push(target.file);
      }
    }
  }
  return violations;
}

function voiceEntryPoints(dir = VOICE_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : voiceEntryPoints(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}

// ── The rule ─────────────────────────────────────────────────────────────────

const entryPoints = voiceEntryPoints();

describe('no voice path can sign', () => {
  it('finds the voice entry points', () => {
    // Guards against the whole suite passing because it looked in the wrong place.
    expect(entryPoints.map(rel)).toContain('lib/voice/actions.ts');
  });

  it.each(entryPoints.map((file) => [rel(file), file] as const))(
    '%s cannot reach signing, key material or a network write',
    (_name, file) => {
      const violations = violationsFrom(file);
      if (violations.length > 0) {
        throw new Error(`${RULE}\n\n${violations.join('\n\n')}`);
      }
    },
  );
});

describe('every action opens a read-only screen', () => {
  // An explicit allow-list, not a deny-list: a new destination has to be added
  // here on purpose, by someone who has checked that the screen cannot move
  // funds without a passkey ceremony the user completes.
  const READ_ONLY_SCREENS = ['/dashboard', '/token/XLM'];

  it('opens only allow-listed screens', () => {
    // Loaded here rather than imported at the top: if an action module ever
    // pulls in the signer, importing it can fail outright, and that must not
    // stop the import-graph test above from running and naming the chain.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { READ_ONLY_ACTIONS } = require('../voice/actions') as {
      READ_ONLY_ACTIONS: readonly ReadOnlyAction[];
    };
    const offending = READ_ONLY_ACTIONS.filter((action) => !READ_ONLY_SCREENS.includes(action.path));
    if (offending.length > 0) {
      const lines = offending.map((action) => `  "${action.id}" opens ${action.path}`);
      throw new Error(
        `${RULE}\n\nThese actions open screens that are not on the read-only allow-list ` +
          `(${READ_ONLY_SCREENS.join(', ')}):\n${lines.join('\n')}`,
      );
    }
  });
});

describe('the walker itself', () => {
  // A structural test that finds nothing proves nothing unless it can find
  // something. These run it on modules known to cross the line.

  it('sees a secret read through a chain of imports', () => {
    const found = violationsFrom(join(APP_ROOT, 'lib', 'holdings.ts')).join('\n');
    expect(found).toContain('lib/holdings.ts → lib/activity.ts → lib/walletStore.ts');
    expect(found).toContain('takes getSignerSecret');
  });

  it('sees the signer', () => {
    const found = violationsFrom(join(APP_ROOT, 'lib', 'contractSpend.ts')).join('\n');
    expect(found).toContain('lib/walletConnect.ts');
  });

  it('sees a network write', () => {
    const found = violationsFrom(join(APP_ROOT, 'lib', 'enableUsdc.ts')).join('\n');
    expect(found).toContain('submits a transaction');
  });

  it('allows reading the wallet address', () => {
    expect(GUARDED_MODULES['lib/walletStore.ts'].allowed).toContain('getWalletAddress');
    expect(violationsFrom(join(APP_ROOT, 'lib', 'voice', 'actions.ts'))).toEqual([]);
  });
});

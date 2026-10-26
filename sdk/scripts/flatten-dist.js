// Post-build for both outputs: dist/ (CommonJS) and dist/esm/ (ESM).
//
// 1. Flatten. tsconfig compiles src/ and react/ together so react's
//    cross-imports into src/ type-check, which makes tsc nest src output under
//    <out>/src/. package.json's main/exports expect it at <out>/ directly, so
//    move it up.
// 2. Re-point react/. Its files import '../../src/...'; after step 1 that
//    directory no longer exists, so `invisible-wallet-sdk/react` resolved and
//    then threw "Cannot find module '../../src/useInvisibleWallet'" on load.
// 3. ESM only: Node's ESM loader does not guess extensions or index files the
//    way require() and bundlers do, so every relative specifier is written out
//    in full ('./utils' -> './utils.js', './vue' -> './vue/index.js'), and
//    <out>/package.json marks the directory as ESM. Declaration files get the
//    same treatment, so TypeScript under node16/nodenext resolves them too.
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');

/** Every relative module specifier in JS or a declaration file. */
const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]*)\2/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|d\.ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function rewrite(file, fn) {
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(SPECIFIER, (match, lead, quote, spec) => {
    const next = fn(spec);
    return next === spec ? match : `${lead}${quote}${next}${quote}`;
  });
  if (after !== before) fs.writeFileSync(file, after);
}

function flatten(outDir) {
  const nestedSrcDir = path.join(outDir, 'src');
  if (!fs.existsSync(nestedSrcDir)) return;
  for (const entry of fs.readdirSync(nestedSrcDir)) {
    const source = path.join(nestedSrcDir, entry);
    const dest = path.join(outDir, entry);
    // Re-running tsc leaves a stale adapter dir at the destination, and
    // renameSync cannot replace an existing directory — clear it first so
    // repeated builds stay idempotent.
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.renameSync(source, dest);
  }
  fs.rmdirSync(nestedSrcDir);

  // Step 2: anything left outside the moved tree that pointed into <out>/src/
  // now points at <out>/ instead.
  const reactDir = path.join(outDir, 'react');
  if (!fs.existsSync(reactDir)) return;
  for (const file of walk(reactDir)) {
    rewrite(file, (spec) => {
      const target = path.resolve(path.dirname(file), spec);
      const rel = path.relative(nestedSrcDir, target);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return spec;
      let next = path.relative(path.dirname(file), path.join(outDir, rel)).split(path.sep).join('/');
      if (!next.startsWith('.')) next = `./${next}`;
      return next;
    });
  }
}

function addExtensions(outDir) {
  for (const file of walk(outDir)) {
    const isDeclaration = file.endsWith('.d.ts');
    rewrite(file, (spec) => {
      if (/\.(m|c)?js$/.test(spec)) return spec;
      const base = path.resolve(path.dirname(file), spec);
      const ext = isDeclaration ? '.d.ts' : '.js';
      // File before directory: the same order TypeScript resolved them in.
      if (fs.existsSync(base + ext)) return `${spec}.js`;
      if (fs.existsSync(path.join(base, `index${ext}`))) return `${spec.replace(/\/$/, '')}/index.js`;
      throw new Error(`flatten-dist: cannot resolve ${spec} from ${path.relative(distDir, file)}`);
    });
  }
  fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`);
}

const esmDir = path.join(distDir, 'esm');

// The CommonJS build owns dist/; flatten it without touching dist/esm/.
flatten(distDir);
if (fs.existsSync(esmDir)) {
  flatten(esmDir);
  addExtensions(esmDir);
}

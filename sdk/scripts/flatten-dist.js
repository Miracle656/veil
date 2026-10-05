// tsconfig.json compiles src/ and react/ together so react's cross-imports
// into src/ type-check, which makes tsc nest src output under dist/src/.
// package.json's main/exports expect it at dist/ directly, so move it up.
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');
const nestedSrcDir = path.join(distDir, 'src');

if (fs.existsSync(nestedSrcDir)) {
  for (const entry of fs.readdirSync(nestedSrcDir)) {
    const source = path.join(nestedSrcDir, entry);
    const dest = path.join(distDir, entry);
    // Re-running tsc leaves a stale adapter dir at the destination, and
    // renameSync cannot replace an existing directory — clear it first so
    // repeated builds stay idempotent.
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.renameSync(source, dest);
  }
  fs.rmdirSync(nestedSrcDir);
}

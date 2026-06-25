// tsconfig.json compiles src/ and react/ together so react's cross-imports
// into src/ type-check, which makes tsc nest src output under dist/src/.
// package.json's main/exports expect it at dist/ directly, so move it up.
const fs = require('node:fs');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');
const nestedSrcDir = path.join(distDir, 'src');

if (fs.existsSync(nestedSrcDir)) {
  for (const entry of fs.readdirSync(nestedSrcDir)) {
    fs.renameSync(path.join(nestedSrcDir, entry), path.join(distDir, entry));
  }
  fs.rmdirSync(nestedSrcDir);
}

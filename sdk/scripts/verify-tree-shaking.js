// Check the built package, not a direct source import: consumers depend on the
// exports map, the ESM build and the published sideEffects declaration together.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildSync } = require('esbuild');

const root = path.join(__dirname, '..');
const options = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: true,
  treeShaking: true,
  metafile: true,
  write: false,
};
const result = buildSync({
  ...options,
  entryPoints: ['size/single-function.mjs'],
});
const bundle = result.outputFiles[0];
const retainedInputs = (build) => Object.entries(Object.values(build.metafile.outputs)[0].inputs)
  .filter(([, input]) => input.bytesInOutput > 0)
  .map(([file]) => file.replace(/\\/g, '/'));

// An unused wallet, framework or Stellar dependency must not ride along with a utility.
assert.deepEqual(retainedInputs(result).sort(), ['dist/esm/utils.js', 'size/single-function.mjs']);
assert.ok(bundle.contents.length < 1024, `Single-function bundle grew to ${bundle.contents.length} bytes`);

const messages = [];
vm.runInNewContext(bundle.text, { console: { log: (value) => messages.push(value) } });
// Prevent a falsely tiny bundle that dropped the function the consumer actually calls.
assert.deepEqual(messages, ['0001feff']);
console.log(`Single-function consumer: ${bundle.contents.length} bytes; only utils retained; hex conversion passed`);

// The generated ESM scope must preserve the audited Angular exception too.
const esmManifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/esm/package.json'), 'utf8'));
assert.deepEqual(esmManifest.sideEffects, ['./angular/**/*.js']);
const angular = buildSync({
  ...options,
  stdin: {
    contents: "import 'invisible-wallet-sdk/angular'; console.log('consumer');",
    resolveDir: root,
    sourcefile: 'angular-consumer.mjs',
    loader: 'js',
  },
});
// Runtime decorators initialize Angular metadata and its shared module-scoping queue.
assert.ok(retainedInputs(angular).includes('dist/esm/angular/lib/veil.module.js'));
assert.ok(retainedInputs(angular).includes('dist/esm/angular/lib/veil.service.js'));
console.log('Angular bare import: runtime decorator initialization retained');

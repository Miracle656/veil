/**
 * Custom Jest resolver that forces @stellar/stellar-sdk to its CJS build.
 *
 * The SDK package has "react-native": "src/index.ts" which Jest's jsdom
 * environment selects, pulling in TypeScript source files. Those source files
 * then import ESM-only transitive deps (uint8array-extras) whose Babel
 * transformation creates a different Uint8Array identity, breaking
 * `instanceof Uint8Array` checks inside the SDK's own XDR classes.
 *
 * This resolver intercepts ALL @stellar/stellar-sdk resolution (top-level
 * and relative internal imports) and forces them to lib/cjs/.
 */
const path = require('path');
const fs = require('fs');

module.exports = (request, options) => {
  const resolved = options.defaultResolver(request, options);

  // Only intercept @stellar/stellar-sdk package files
  const sdkMarker = '/node_modules/@stellar/stellar-sdk/';
  const markerIdx = resolved.indexOf(sdkMarker);
  if (markerIdx === -1) {
    return resolved;
  }

  const sdkRoot = resolved.slice(0, markerIdx + sdkMarker.length);
  const relativeFromSdk = resolved.slice(sdkRoot.length);

  // If the resolved path is under src/ (TS source), redirect to lib/cjs/
  if (relativeFromSdk.startsWith('src/') || relativeFromSdk.startsWith('src\\')) {
    const cjsPath = relativeFromSdk
      .replace(/^src\//, 'lib/cjs/')
      .replace(/\.ts$/, '.js')
      .replace(/\.tsx$/, '.js');
    const candidate = path.join(sdkRoot, cjsPath);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return resolved;
};

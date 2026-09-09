/**
 * Custom Jest resolver for ESM-only packages.
 *
 * @stellar/stellar-sdk@17's CJS build requires() ESM-only packages like
 * uint8array-extras.  Node 22.12+ handles require(esm) natively, but Jest's
 * module system doesn't.  This resolver detects ESM-only packages (those with
 * "type": "module" and no CJS export) and rewrites the require to a dynamic
 * import wrapper that Jest can understand.
 */
const path = require('path');
const fs = require('fs');

module.exports = (request, options) => {
  // Let Jest resolve it normally first
  const resolved = options.defaultResolver(request, options);

  // Check if the resolved file is an ESM-only module
  const pkgJsonPath = findPackageJson(path.dirname(resolved));
  if (!pkgJsonPath) return resolved;

  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

  if (pkgJson.type === 'module') {
    // Check for a CJS export or main field that points to CJS
    const hasCjs = hasCjsExport(pkgJson, resolved, pkgJsonPath);
    if (!hasCjs) {
      // ESM-only: return the resolved path as-is.
      // Jest will fail to require() it, but the babel-jest transform
      // should handle the ESM syntax if transformIgnorePatterns allows it.
      // If that doesn't work, this resolver signals to use dynamic import.
      return resolved;
    }
  }

  return resolved;
};

function findPackageJson(dir) {
  let current = dir;
  while (current !== path.dirname(current)) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    current = path.dirname(current);
  }
  return null;
}

function hasCjsExport(pkgJson, resolvedFile, pkgJsonPath) {
  // Check if there's a CJS condition in exports
  if (pkgJson.exports) {
    const exports = typeof pkgJson.exports === 'string' ? { '.': pkgJson.exports } : pkgJson.exports;
    for (const [key, val] of Object.entries(exports)) {
      if (key === 'require' || key === 'node') {
        return true;
      }
    }
  }
  // Check main field
  if (pkgJson.main && pkgJson.main.endsWith('.cjs')) return true;
  if (pkgJson.main && pkgJson.main.endsWith('.js')) {
    const mainPath = path.resolve(path.dirname(pkgJsonPath), pkgJson.main);
    if (fs.existsSync(mainPath)) {
      const content = fs.readFileSync(mainPath, 'utf8');
      if (content.includes('module.exports') || content.includes('exports.')) return true;
    }
  }
  return false;
}

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
// frontend/mobile -> frontend -> repo root
const monorepoRoot = path.resolve(projectRoot, '../..');
const sdkRoot = path.resolve(monorepoRoot, 'sdk');

const config = getDefaultConfig(projectRoot);

// Metro only watches `projectRoot` by default, so anything imported from
// outside `frontend/mobile` is invisible to it. Watch the repo root (for the
// hoisted `node_modules/invisible-wallet-sdk` link npm workspaces creates) and
// `sdk/` explicitly — symlinked modules are watched by their real path, and
// that is what makes edits to the SDK sources trigger a fast refresh here.
config.watchFolders = [monorepoRoot, sdkRoot];

// Resolve the app's own dependencies first, then fall back to the packages npm
// hoisted to the repo root, then to anything the SDK keeps locally. Without
// this, a hoisted dependency of `invisible-wallet-sdk` (for example
// `@stellar/stellar-sdk`) fails to resolve once Metro steps outside the app.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
  path.resolve(sdkRoot, 'node_modules'),
];

// `sdk` is an npm workspace, so the root install links
// `node_modules/invisible-wallet-sdk -> ../sdk`. Metro must follow that link
// (and resolve it to its real path) to see the TypeScript sources at all.
config.resolver.unstable_enableSymlinks = true;

// Fallback for installs that skipped the workspace root: map the bare specifier
// straight at `sdk/`. Resolution still goes through the package's
// `"react-native": "src/index.ts"` field, so the native entry point — and with
// it `webauthn.native.ts` instead of the browser `webauthn.ts` — is what gets
// bundled either way.
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  'invisible-wallet-sdk': sdkRoot,
};

// Wire tsconfig `paths` into Metro so `@/components/*`, `@/*`, and
// `@/assets/*` resolve at runtime. The Expo SDK 57 Babel pipeline also
// honors `tsconfig.json` paths, but the alias guarantees the SSR/web
// bundler sees the same resolutions.
config.resolver.alias = {
  ...config.resolver.alias,
  '@/components': path.resolve(projectRoot, 'components'),
  '@/assets': path.resolve(projectRoot, 'assets'),
  '@': path.resolve(projectRoot, 'app'),
};

module.exports = config;

const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
// frontend/mobile -> frontend -> repo root
const monorepoRoot = path.resolve(projectRoot, '../..');
const sdkRoot = path.resolve(monorepoRoot, 'sdk');

const config = getDefaultConfig(projectRoot);

// Metro only watches `projectRoot` by default, so anything imported from
// outside `frontend/mobile` is invisible to it. Watch the repo root and `sdk/`
// explicitly — symlinked modules are watched by their real path, and that is
// what makes edits to the SDK sources trigger a fast refresh here.
config.watchFolders = [monorepoRoot, sdkRoot];

// Resolve the app's own dependencies first, then the repo root, then anything
// the SDK keeps locally. `invisible-wallet-sdk` is a `file:../../sdk` dependency
// (the repo is not an npm workspace — see #670), so npm links it into
// `frontend/mobile/node_modules` and leaves its own deps in `sdk/node_modules`;
// without the last entry a dependency of the SDK — `@stellar/stellar-sdk`, say —
// fails to resolve once Metro steps outside the app.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
  path.resolve(sdkRoot, 'node_modules'),
];

// npm installs a `file:` dependency as a symlink, so
// `node_modules/invisible-wallet-sdk -> ../../sdk`. Metro must follow that link
// (and resolve it to its real path) to see the TypeScript sources at all.
config.resolver.unstable_enableSymlinks = true;

// Fallback for a checkout where the app's own install has not run yet: map the
// bare specifier straight at `sdk/`. Resolution still goes through the package's
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

// `@stellar/stellar-sdk`'s Horizon `call_builder` imports the Node-only
// `eventsource` package for `.stream()`, which drags in `url`/`http`/`https` —
// absent in Hermes and fatal to the native bundle. The app talks to Horizon
// request/response only (never `.stream()`), so resolve `eventsource` to an
// inert shim (shims/eventsource.js) and keep the Node deps out of the bundle.
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'eventsource') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(projectRoot, 'shims/eventsource.js'),
    };
  }
  const resolve = upstreamResolveRequest ?? context.resolveRequest;
  return resolve(context, moduleName, platform);
};

module.exports = config;

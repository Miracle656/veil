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
// `@/assets/*` resolve at runtime. The Babel pipeline also honors
// `tsconfig.json` paths, but the alias guarantees the SSR/web bundler sees the
// same resolutions.
//
// `@` maps to the project root, matching `tsconfig.json` since #586 widened
// `@/*` from `./app/*` to `./*`. The two must agree: if Metro resolved `@` to
// `app/` while TypeScript resolved it to the root, an `@/lib/foo` import would
// typecheck cleanly and then fail to resolve at runtime — a break that CI
// cannot see, because tsc is the only thing that looks at tsconfig.
config.resolver.alias = {
  ...config.resolver.alias,
  '@/components': path.resolve(projectRoot, 'components'),
  '@/assets': path.resolve(projectRoot, 'assets'),
  '@': projectRoot,
};

// Packages that must exist exactly once in the bundle.
//
// Since #670 each package installs independently, `sdk/node_modules` carries
// its own `react` (19.2.8) alongside the app's (19.1.0). Metro follows the
// `file:../../sdk` symlink to read the SDK's TypeScript sources, and Node
// resolution from a file inside `sdk/` finds `sdk/node_modules/react` first.
// The result is two React copies with two independent hook dispatchers, and
// the SDK's hooks call into the one the renderer is not using:
//
//   Invalid hook call. Hooks can only be called inside of the body of a
//   function component.
//     at exports.useRef (../../sdk/node_modules/react/cjs/react.development.js)
//     at useInvisibleWallet (../../sdk/src/useInvisibleWallet.ts)
//
// `resolver.alias` does not fix this — it is not consulted for a bare specifier
// that ordinary node resolution can already satisfy locally. Redirecting inside
// `resolveRequest` does, because Metro calls it for every request no matter
// which file asked.
//
// `@stellar/stellar-sdk` is here for a related but separate reason: the SDK
// declares ^15.1.0 (dependabot #143) while this app declares ^14.6.1, so both
// majors were being bundled — SDK code ran v15, app code ran v14. XDR types are
// classes, so an object built by one major and read by the other is not the
// same type, and `wallet.deploy()` produced an envelope the same bundle could
// not decode:
//
//   Deploy: this device produced a transaction it cannot read back.
//
// while every app-side flow, on v14 throughout, worked. Pin both to the app's
// copy so there is one XDR implementation in the bundle.
//
// The real fix is agreeing one version across the repo — PR #676 — after which
// this entry is belt and braces rather than load-bearing.
const SINGLETON_PACKAGES = new Set(['react', 'react-dom', '@stellar/stellar-sdk']);
const APP_NODE_MODULES = path.resolve(projectRoot, 'node_modules');

/** The package name for a specifier, handling scopes and subpaths. */
function packageNameOf(moduleName) {
  const parts = moduleName.split('/');
  return moduleName.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

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

  if (SINGLETON_PACKAGES.has(packageNameOf(moduleName))) {
    // Re-ask Metro for the same specifier, but as though an app file had asked.
    //
    // Deliberately not `require.resolve` here: that returns a package's Node
    // entry point, and `@stellar/stellar-sdk` ships a separate browser build
    // that is the one usable under Hermes — its Node entry reaches for `http`
    // and `url`, which do not exist here. Rewriting the origin keeps Metro's
    // own `browser` / `react-native` field handling and only changes which
    // copy it finds.
    try {
      return resolve(
        { ...context, originModulePath: path.join(APP_NODE_MODULES, '.metro-singleton.js') },
        moduleName,
        platform,
      );
    } catch {
      // Fall through to normal resolution rather than hard-failing the build.
    }
  }

  return resolve(context, moduleName, platform);
};

module.exports = config;

# SDK import-time audit and tree shaking (#1215)

## Scope and findings

Audited the production modules under `src/`, `react/`, the framework entrypoints,
the separate `elements/` package, both TypeScript outputs, and
`scripts/flatten-dist.js`. The audit distinguishes module-local initialization
from global mutation, registration, listeners, storage, timers, and network
activity; it also checks emitted decorators and top-level IIFEs.

| Area | Import-time finding | Policy |
| --- | --- | --- |
| Core, vanilla, outbox, events, recovery | Wallet/client construction, storage hydration, listeners, timers, fetches and popup activity are deferred to constructors, factories or methods. No first-party top-level registration/IIFE was found. | Unused modules may be dropped. |
| Crypto, signing, network, wallet storage | Local constants, Sets, Maps and encoded domain strings are created eagerly; there is no external registration. `TextEncoder` is required by some eagerly encoded constants. | Disposable initialization; not a promise that importing performs literally no work or cannot throw in an unsupported environment. |
| Stellar Wallets Kit | A module-local WeakMap caches popups only when requests run; native passkey loading is also deferred. | No registration exception needed. |
| React | Context creation is module-local. Wallet instances, QueryClient construction and subscriptions happen in invoked hooks/providers/effects. | No registration exception needed. |
| Vue, Svelte, Solid | Wallet construction and subscriptions start when the composable/factory/primitive is used, not when the adapter is imported. | No first-party registration exception needed. |
| Angular | Plain `tsc` emits runtime `Injectable`/`NgModule` decorator calls. They install metadata on exported classes; Angular's `NgModule` hook also appends to its shared delayed-scoping queue. The barrel reaches both decorated classes. | Preserve `src/angular/**/*.ts`, `dist/angular/**/*.js`, and `dist/esm/angular/**/*.js`, including their barrels. Do not annotate these decorators as pure. |
| Custom element | `elements/src/veil-button.ts` calls `customElements.define` on import and can upgrade existing elements. It also extends `HTMLElement`, so it needs a DOM. | Separate private package, not shipped by the root SDK's `files`/`exports`; leave its registration semantics unchanged and do not mark that package side-effect-free. |
| Dependencies | Stellar initializes global Axios/EventSource flags; framework runtimes can initialize globals/registries (Vue setters/HMR, Solid dev hooks, Angular dev-mode/i18n state). TanStack manager singletons defer listeners until subscription. | This declaration covers Veil's modules, not a claim that the transitive graph is globally inert. Used dependency imports retain their own semantics. |

The root manifest lists the Angular exceptions rather than declaring blanket
`false`. The generated `dist/esm/package.json` is the nearest package scope for
ESM modules, so `flatten-dist.js` writes the corresponding relative exception
`./angular/**/*.js` there too. A root-only change did not fix the measured ESM
bundle.

`utils.ts` previously imported Stellar for `computeWalletAddress`, so even a used
hex helper retained Stellar's browser bundle. Address derivation now lives in
`walletAddress.ts` and is re-exported through the same utility/root surface. Its
calculation, synchronous signature, default network and public export are
unchanged; no address, signing or key derivation logic was rewritten.

Do not rely on an otherwise-unused Veil import to initialize a dependency's
globals. CommonJS and native consumers keep their existing entrypoints; fine
grained tree shaking is measured for browser ESM, not promised for `require()`.

## Measurements

Measured on Windows with Node 22.16.0 and the locked esbuild 0.28.1, using
`npm run size` and the identical explicit ESM fixture on baseline `d6c94cb7` and
this change. Values are Size Limit's minified Brotli bytes (including its
empty-project adjustment), not raw JavaScript bytes.

| Consumer | Before | After |
| --- | ---: | ---: |
| One `bufferToHex` import | 213,482 B | 168 B |
| Full CommonJS root | 235,175 B | 235,297 B |
| Full CommonJS vanilla | 216,259 B | 216,234 B |

The single-function browser output is 286 raw bytes and includes only the called
utility plus the consumer. The full CommonJS root already exceeds its unchanged
235,000-byte budget on the baseline (175 B over); it remains over after this
change (297 B over). That existing check failure is reported, not hidden by
raising the limit. The new single-function 1,000-byte budget passes.

## Reproduce

From `sdk/` with Node 20+ and npm:

```bash
npm ci --legacy-peer-deps
npm test -- --runInBand
npm run test:surface -- --runInBand
npm run verify:exports
npm run test:tree-shaking
npm run size
```

`size/single-function.mjs` imports and calls `bufferToHex` through the package
name, not a direct internal path. The explicit `.mjs` extension makes it an ESM
consumer even inside this CommonJS package. Size Limit bundles for the browser
with dependencies included, minification and Brotli compression. Its report
subtracts the plugin's empty-project overhead; it is not an npm tarball size.

`test:tree-shaking` checks esbuild's retained-input metadata, a sub-1-KiB raw
budget, and execution of the actual output without React, Stellar or wallet
modules. It also checks that the ESM Angular exception and the runtime-decorated
classes survive a bare Angular import. Neither test suppresses dependency side
effects or marks Stellar external.

For a comparable baseline, use upstream revision `d6c94cb7` with the same
`size/single-function.mjs` fixture and its Size Limit entry added, but without
production changes. Use the same locked dependencies, Node and platform on both
revisions. Full CommonJS bundle entries intentionally keep their original
budgets; an existing failure is not fixed by raising a limit.

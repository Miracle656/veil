import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solidPlugin()],
  server: {
    port: 3000,
  },
  resolve: {
    // The SDK declares `solid-js` as an optional peer and also carries its own
    // copy for type-checking. Two Solid runtimes in one page break reactivity
    // silently — signals created against one are invisible to the other — so
    // pin everything to the app's single copy.
    dedupe: ['solid-js'],
  },
  optimizeDeps: {
    // `invisible-wallet-sdk` is linked from source (file:../../sdk) and built
    // as CommonJS. Vite skips pre-bundling for linked dependencies by default,
    // so ask for it explicitly — otherwise its named exports are undefined in
    // dev.
    include: ['invisible-wallet-sdk/solid', '@stellar/stellar-sdk'],
  },
  build: {
    target: 'esnext',
    commonjsOptions: {
      // Same problem at build time: the linked SDK resolves outside
      // node_modules, so widen the CommonJS transform to reach it. Installing
      // the SDK from npm instead of `file:` makes both of these unnecessary.
      include: [/node_modules/, /sdk[\/]dist[\/]/],
    },
  },
});

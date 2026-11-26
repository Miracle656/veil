import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  resolve: {
    // The SDK declares `svelte` as an optional peer and also carries its own
    // copy for type-checking. Two Svelte runtimes in one page break stores
    // silently, so pin everything to the app's single copy.
    dedupe: ['svelte'],
  },
  optimizeDeps: {
    // `invisible-wallet-sdk` is linked from source (file:../../sdk) and built
    // as CommonJS. Vite skips pre-bundling for linked dependencies by default,
    // so ask for it explicitly — otherwise its named exports are undefined in
    // dev.
    include: ['invisible-wallet-sdk/svelte', '@stellar/stellar-sdk'],
  },
  build: {
    commonjsOptions: {
      // Same problem at build time: the linked SDK resolves outside
      // node_modules, so widen the CommonJS transform to reach it. Installing
      // the SDK from npm instead of `file:` makes both of these unnecessary.
      include: [/node_modules/, /sdk[\/]dist[\/]/],
    },
  },
});

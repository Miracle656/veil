import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    // 5173 is taken by examples/vite-react, so the two starters can run side by side.
    port: 5174,
  },
  resolve: {
    // The SDK declares `vue` as a peer dependency and also carries its own copy
    // for type-checking. Two Vue runtimes in one page break composables, so make
    // sure everything resolves to the app's single copy.
    dedupe: ['vue'],
  },
  optimizeDeps: {
    // `invisible-wallet-sdk` is linked from source (file:../../sdk) and built as
    // CommonJS. Vite skips pre-bundling for linked dependencies by default, so
    // ask for it explicitly — otherwise its named exports are undefined in dev.
    include: ['invisible-wallet-sdk/vue', '@stellar/stellar-sdk'],
  },
  build: {
    commonjsOptions: {
      // Same problem at build time: the linked SDK resolves outside
      // node_modules, so widen the CommonJS transform to reach it. Installing
      // the SDK from npm instead of `file:` makes both of these unnecessary.
      include: [/node_modules/, /sdk[\\/]dist[\\/]/],
    },
  },
})

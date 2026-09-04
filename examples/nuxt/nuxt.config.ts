// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2024-11-01',
  ssr: true,
  devtools: { enabled: false },

  // Runtime configuration. Server-only keys live at the top level; anything the
  // browser needs goes under `public`. Override any of these with the matching
  // NUXT_* environment variable (see .env.example).
  runtimeConfig: {
    // Domain of the SEP-24 anchor used by the server routes (server-only).
    anchorDomain: process.env.ANCHOR_DOMAIN || 'testanchor.stellar.org',
    public: {
      network: process.env.NUXT_PUBLIC_NETWORK || 'testnet',
      sorobanRpcUrl:
        process.env.NUXT_PUBLIC_SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
      horizonUrl:
        process.env.NUXT_PUBLIC_HORIZON_URL || 'https://horizon-testnet.stellar.org',
      factoryContractId: process.env.NUXT_PUBLIC_FACTORY_CONTRACT_ID || '',
    },
  },

  app: {
    head: {
      title: 'Veil Wallet — Nuxt',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
    },
  },
})

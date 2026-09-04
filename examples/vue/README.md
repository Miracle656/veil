# Veil — Vite + Vue 3 starter

A minimal Vue 3 app built on `invisible-wallet-sdk/vue`, covering the three
flows the SDK is for: **register**, **login**, and **send**.

```
src/
├── lib/
│   ├── config.ts     # network settings from VITE_* env vars
│   ├── feePayer.ts   # throwaway fee-payer keypair, funded by Friendbot
│   └── wallet.ts     # useInvisibleWallet() called once, shared app-wide
└── views/
    ├── RegisterView.vue    # register() → deploy(), plus login()
    ├── DashboardView.vue   # login() + getBalance()
    └── SendView.vue        # sendPayment()
```

## Setup

Build the SDK first — the example links to it from source:

```bash
cd ../../sdk
npm install
npm run build
```

Then:

```bash
cd ../examples/vue
cp .env.example .env.local   # set VITE_FACTORY_ADDRESS
npm install
npm run dev                  # http://localhost:5174
```

WebAuthn requires a secure context, so use `localhost` (or HTTPS) — an IP
address like `127.0.0.1:5174` will not prompt for a passkey.

## How the composable is used

`useInvisibleWallet()` creates an independent wallet on every call, so
[`src/lib/wallet.ts`](src/lib/wallet.ts) calls it once at module scope and every
view imports that one instance:

```ts
// src/lib/wallet.ts
export const wallet = useInvisibleWallet({
  factoryAddress: appConfig.factoryAddress,
  rpcUrl: appConfig.rpcUrl,
  networkPassphrase: appConfig.networkPassphrase,
})
```

`address`, `isDeployed`, `isPending` and `error` come back as refs, so templates
react to them with no extra wiring:

```vue
<script setup lang="ts">
const { address, isPending, register } = wallet
</script>

<template>
  <p v-if="address">Wallet: {{ address }}</p>
  <button v-else :disabled="isPending" @click="register('alice')">Create wallet</button>
</template>
```

For an SSR app (Nuxt), call the composable inside `setup()` instead, so each
request gets its own wallet — see [`examples/nuxt/`](../nuxt/).

## The two accounts

Veil separates ownership from fee payment:

- the **wallet contract** (`C…`) holds the funds and is controlled by your passkey;
- the **fee payer** (`G…`) is an ordinary Stellar account that only pays network fees.

This starter generates a throwaway fee payer, funds it with Friendbot, and keeps
the secret in `localStorage`. That is fine for testnet and **not** how a
production app should do it — derive the key from the passkey (the SDK's PRF
helpers) or sponsor fees server-side instead.

## Notes

- `vite.config.ts` pre-bundles the linked SDK (`optimizeDeps.include`) because it
  is built as CommonJS, and dedupes `vue` so the app and the SDK share one runtime.
- Amounts are contract units: 1 XLM = 10,000,000 stroops. `SendView` converts.
- Port 5174 keeps this starter runnable alongside [`examples/vite-react/`](../vite-react/).

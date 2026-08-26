# `invisible-wallet-sdk/vue`

The Vue 3 adapter for Veil's passkey wallet — the same wallet the React hook
drives, exposed as a Composition API composable.

This directory is the published subpath entry point; the composable itself lives
in [`../src/vue/`](../src/vue/) and is compiled to `../dist/vue/`.

## Install

```bash
npm install invisible-wallet-sdk @stellar/stellar-sdk
```

`vue` is an optional peer dependency, so React apps installing the SDK never
pull it in — and neither does the Vue bundle pull in React.

## Usage

```vue
<script setup lang="ts">
import { useInvisibleWallet } from 'invisible-wallet-sdk/vue'

const { address, isDeployed, isPending, error, register, deploy, login, sendPayment } =
  useInvisibleWallet({
    factoryAddress: import.meta.env.VITE_FACTORY_ADDRESS,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  })

async function createWallet() {
  await register('alice')                  // passkey prompt
  await deploy(import.meta.env.VITE_FEE_PAYER_SECRET)
}
</script>

<template>
  <p v-if="error" role="alert">{{ error }}</p>
  <p v-if="address">Wallet: {{ address }} ({{ isDeployed ? 'live' : 'not deployed' }})</p>
  <button v-else :disabled="isPending" @click="createWallet">Create wallet</button>
</template>
```

## What you get back

| Returned | Type | Notes |
| --- | --- | --- |
| `state` | `Ref<WalletState>` | The whole status in one ref — `watch(state, …)` |
| `address` | `ComputedRef<string \| null>` | Wallet contract address (`C…`) |
| `isDeployed` | `ComputedRef<boolean>` | Contract confirmed on-chain |
| `isPending` | `ComputedRef<boolean>` | An operation is in flight |
| `error` | `ComputedRef<string \| null>` | Last failure message |
| actions | functions | `register`, `deploy`, `login`, `signAuthEntry`, `sendPayment`, `getBalance`, `addSigner`, `removeSigner`, `rotateSigner`, `getSigners`, `setGuardian`, `initiateRecovery`, `completeRecovery`, `approve`, `getAllowance`, `getNonce`, `getPortableSigner`, `deriveCounterfactualAddress`, `outbox`, `replayOutbox`, `encryptLocal`, `decryptLocal`, `encryptionMode` |

The action list is identical to the React hook's: both adapters wrap the same
framework-agnostic core (`src/core.ts`), so neither can drift ahead of the other.

## Lifecycle and SSR

Called from `setup()` / `<script setup>`, the wallet follows the component: it
restores a persisted session on `onMounted`, replays the offline outbox when
connectivity returns, and detaches on `onUnmounted`. Nothing touches
`localStorage` or `window` before mount, so server-side rendering is safe —
wrap markup that reads wallet state in `<ClientOnly>` (Nuxt) to keep hydration
clean.

Called outside a component (a Pinia store, a plugin, a plain module) it starts
immediately and lives as long as you hold on to it.

## Switching networks at runtime

Every action re-reads the config when it runs, so pass a `reactive()` object and
mutate it:

```ts
const config = reactive({ factoryAddress, rpcUrl, networkPassphrase })
const wallet = useInvisibleWallet(config)

config.rpcUrl = 'https://soroban-mainnet.stellar.org'  // next call uses it
```

The `storage` adapter is the one exception: it is read once, when the wallet is
created, because the offline outbox and the passkey-derived cipher belong to it.

## Example app

[`examples/vue/`](../../examples/vue/) is a Vite + Vue 3 starter covering
register, login and send.

# invisible-wallet-sdk

TypeScript SDK for Veil / Invisible Wallet (Soroban + WebAuthn passkeys). Supports Web (React, Vue 3, Angular, Solid.js, Svelte, vanilla JS/TS) and React Native / Expo.

---

## Installation

```bash
npm install invisible-wallet-sdk @stellar/stellar-sdk
```

All framework peer dependencies are optional — install only the peers required by the entry point you import:
- **`invisible-wallet-sdk`** (main entry): `npm install react`
- **`invisible-wallet-sdk/react`**: `npm install react react-dom @tanstack/react-query`
- **`invisible-wallet-sdk/vue`**: `npm install vue`
- **`invisible-wallet-sdk/svelte`**: `npm install svelte`
- **`invisible-wallet-sdk/solid`**: `npm install solid-js`
- **`invisible-wallet-sdk/angular`**: `npm install @angular/core`
- **`invisible-wallet-sdk/vanilla`**: no framework peer dependencies required
- **React Native / Expo**: `npm install react-native react-native-passkeys`

---

## Quick Start

### 1. React

Wrap your app or component tree with the `useInvisibleWallet` hook:

```tsx
// @check-readme-ignore - example showing hook usage pattern
import React, { useState } from 'react';
import { useInvisibleWallet, type TransactionSigner } from 'invisible-wallet-sdk';

const config = {
  factoryAddress: 'CA...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
};

// Signing signer - secret lives on backend, not in browser
const feePayer: TransactionSigner = {
  publicKey: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  signTransaction: async (xdr, { networkPassphrase }) => {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xdr, networkPassphrase }),
    });
    if (!res.ok) throw new Error('Signing failed');
    return (await res.json()).signedXdr;
  },
};

export function WalletConnect() {
  const [username, setUsername] = useState('');
  const { address, isDeployed, isPending, register, login, deploy, error } = useInvisibleWallet(config);

  if (isDeployed && address) {
    return <div>Connected wallet: {address}</div>;
  }

  return (
    <div>
      <input
        type="text"
        placeholder="Enter username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <button onClick={() => register(username)} disabled={isPending}>
        {isPending ? 'Creating...' : 'Create Passkey'}
      </button>
      <button onClick={() => login()} disabled={isPending}>
        Sign In with Passkey
      </button>
      <button onClick={() => deploy(feePayer)} disabled={isPending || !address}>
        {isPending ? 'Deploying...' : 'Deploy Wallet'}
      </button>
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}
```

---

### 2. Vue 3

Import the composable from the `/vue` subpath:

```vue
<!-- @check-readme-ignore - example showing Vue composable usage pattern -->
<script setup lang="ts">
import { ref } from 'vue';
import { useInvisibleWallet, type TransactionSigner } from 'invisible-wallet-sdk/vue';

const config = {
  factoryAddress: 'CA...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
};

// Signing signer - secret lives on backend, not in browser
const feePayer: TransactionSigner = {
  publicKey: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  signTransaction: async (xdr, { networkPassphrase }) => {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xdr, networkPassphrase }),
    });
    if (!res.ok) throw new Error('Signing failed');
    return (await res.json()).signedXdr;
  },
};

const username = ref('');
const { address, isDeployed, isPending, register, login, deploy, error } = useInvisibleWallet(config);
</script>

<template>
  <div v-if="isDeployed && address">
    <p>Connected: {{ address }}</p>
  </div>
  <div v-else>
    <input v-model="username" placeholder="Username" />
    <button :disabled="isPending" @click="register(username)">
      {{ isPending ? 'Creating...' : 'Create Passkey' }}
    </button>
    <button :disabled="isPending" @click="login()">Sign In</button>
    <button :disabled="isPending || !address" @click="deploy(feePayer)">
      {{ isPending ? 'Deploying...' : 'Deploy Wallet' }}
    </button>
    <p v-if="error" style="color: red">{{ error }}</p>
  </div>
</template>
```

---

### 3. Solid.js

Import the primitive from the `/solid` subpath. State arrives as accessors:

```tsx
// @check-readme-ignore - example component without exports
import { Show } from 'solid-js';
import { useInvisibleWallet } from 'invisible-wallet-sdk/solid';

function App() {
  const wallet = useInvisibleWallet({
    factoryAddress: 'CA...',
    networkPassphrase: 'Test SDF Network ; September 2015',
    rpcUrl: 'https://soroban-testnet.stellar.org',
  });

  return (
    <Show when={wallet.address()} fallback={
      <button disabled={wallet.isPending()} onClick={() => wallet.register('alice')}>
        Create wallet
      </button>
    }>
      <p>Connected: {wallet.address()}</p>
    </Show>
  );
}
```

`solid-js` is an optional peer dependency, so apps on other frameworks never
install it.

---

### 4. Angular

Import the service from the `/angular` subpath and configure it once at
bootstrap with `provideVeil` — standalone-component compatible:

```ts
// @check-readme-ignore - Angular bootstrap fragment
// main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideVeil } from 'invisible-wallet-sdk/angular';

bootstrapApplication(AppComponent, {
  providers: [
    provideVeil({
      factoryAddress: 'CA...',
      networkPassphrase: 'Test SDF Network ; September 2015',
      rpcUrl: 'https://soroban-testnet.stellar.org',
    }),
  ],
});
```

Components and services then inject the shared singleton:

```ts
// @check-readme-ignore - Angular component with template syntax
import { Component, inject } from '@angular/core';
import { VeilService } from 'invisible-wallet-sdk/angular';

@Component({
  standalone: true,
  template: `
    @if (wallet.address(); as address) {
      <p>Wallet: {{ address }}</p>
    } @else {
      <button (click)="wallet.register('alice')">Create wallet</button>
    }
  `,
})
export class WalletComponent {
  readonly wallet = inject(VeilService);
}
```

State arrives as signals — `wallet.address()`, `wallet.isDeployed()`,
`wallet.isPending()`, `wallet.error()`. NgModule-based apps use
`VeilModule.forRoot({...})` instead of `provideVeil`.

---

### 5. Vanilla / Framework-Agnostic

Use `createInvisibleWallet` for direct programmatic control without UI framework bindings:

```typescript
// @check-readme-ignore - example showing vanilla API usage pattern
import { createInvisibleWallet, type TransactionSigner } from 'invisible-wallet-sdk/vanilla';

const wallet = createInvisibleWallet({
  factoryAddress: 'CA...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

// Register a new passkey
const registerResult = await wallet.register('alice');
console.log('Wallet address (counterfactual):', registerResult.walletAddress);

// Deploy the smart wallet with a fee-paying signer
const feePayer: TransactionSigner = {
  publicKey: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  signTransaction: async (xdr, { networkPassphrase }) => {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xdr, networkPassphrase }),
    });
    if (!res.ok) throw new Error('Signing failed');
    return (await res.json()).signedXdr;
  },
};

const deployResult = await wallet.deploy(feePayer);
console.log('Deployed:', deployResult.address);
```

---

## Signing without shipping a secret

Every method that puts a signature on a transaction (`deploy`, `sendPayment`,
`addSigner`, `removeSigner`, `rotateSigner`, `setGuardian`, `initiateRecovery`,
`completeRecovery`, `approve`, the escrow helpers, and the `sponsorSigner`
config option) takes a **`TransactionSigner`**. The SDK builds the transaction,
hands the callback its XDR, and your application signs wherever the key lives,
typically a backend:

```ts
// @check-readme-ignore - fragment showing TransactionSigner pattern
import type { TransactionSigner } from 'invisible-wallet-sdk';

const feePayer: TransactionSigner = {
  publicKey: FEE_PAYER_PUBLIC_KEY, // a G... address is public
  signTransaction: async (xdr, { networkPassphrase }) => {
    const res = await fetch('/api/sign', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ xdr, networkPassphrase }),
    });
    if (!res.ok) throw new Error('Signing was refused');
    return (await res.json()).signedXdr;
  },
};

await wallet.deploy(feePayer);
await wallet.sendPayment(feePayer, to, amountInStroops);
```

The backend half is a runnable example in
[`examples/server-signer.ts`](./examples/server-signer.ts). A signer that throws
refuses the operation: the SDK call rejects with its error and nothing is
submitted. The SDK also rejects a signer that returns an envelope for a
different transaction, or one with no added signature.

### Migrating from a secret or Keypair

Passing a secret string or a `Keypair` still works but is **deprecated**: it
logs a one-time `console.warn` and will be removed in the next major version,
because it needs a live Stellar secret in your client bundle. `sponsorSecret`
in the wallet config is likewise deprecated in favour of `sponsorSigner`, and
the escrow helpers' `senderKeypair` / `claimantKeypair` options in favour of
`sender` / `claimant`.

## Subpath Exports

The package provides verified export subpaths:

| Subpath | Description |
|---|---|
| `invisible-wallet-sdk` | Default entry point (Core API + React `useInvisibleWallet`) |
| `invisible-wallet-sdk/react` | React provider and specialized hooks (`useBalance`, `useHistory`, `useSendTransaction`) |
| `invisible-wallet-sdk/vue` | Vue 3 composable (`useInvisibleWallet`) |
| `invisible-wallet-sdk/svelte` | Svelte store (`createWalletStore`) |
| `invisible-wallet-sdk/solid` | Solid.js primitive (`useInvisibleWallet`) |
| `invisible-wallet-sdk/angular` | Angular DI service (`VeilService` + `provideVeil`) |
| `invisible-wallet-sdk/vanilla` | Framework-agnostic client (`createInvisibleWallet`) |

---

## License

MIT

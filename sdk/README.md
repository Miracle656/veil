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
import React, { useState } from 'react';
import { useInvisibleWallet } from 'invisible-wallet-sdk';

const config = {
  factoryContractId: 'CA...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
};

export function WalletConnect() {
  const [username, setUsername] = useState('');
  const { address, isConnected, isDeploying, connect, deploy, error } = useInvisibleWallet(config);

  if (isConnected) {
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
      <button onClick={() => connect(username)}>Sign In with Passkey</button>
      <button onClick={() => deploy(username)} disabled={isDeploying}>
        {isDeploying ? 'Deploying...' : 'Register & Deploy'}
      </button>
      {error && <p style={{ color: 'red' }}>{error.message}</p>}
    </div>
  );
}
```

---

### 2. Vue 3

Import the composable from the `/vue` subpath:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useInvisibleWallet } from 'invisible-wallet-sdk/vue';

const config = {
  factoryContractId: 'CA...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
};

const username = ref('');
const { address, isConnected, isDeploying, connect, deploy, error } = useInvisibleWallet(config);
</script>

<template>
  <div v-if="isConnected">
    <p>Connected: {{ address }}</p>
  </div>
  <div v-else>
    <input v-model="username" placeholder="Username" />
    <button @click="connect(username)">Sign In</button>
    <button :disabled="isDeploying" @click="deploy(username)">
      {{ isDeploying ? 'Deploying...' : 'Register' }}
    </button>
    <p v-if="error" style="color: red">{{ error.message }}</p>
  </div>
</template>
```

---

### 3. Solid.js

Import the primitive from the `/solid` subpath. State arrives as accessors:

```tsx
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
import { createInvisibleWallet } from 'invisible-wallet-sdk/vanilla';

const wallet = createInvisibleWallet({
  factoryContractId: 'CA...',
  networkPassphrase: 'Test SDF Network ; September 2015',
  rpcUrl: 'https://soroban-testnet.stellar.org',
});

// Register a new passkey and deploy a smart wallet
const result = await wallet.deploy('alice');
console.log('Contract Address:', result.address);

// Sign a transaction
const tx = await wallet.signTransaction(preparedTransaction);
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

## Session keys

A session key is an ed25519 key the wallet owner registers with a passkey. Until its expiry it may call one function on one contract, and the third argument of each call (the amount, for a token `transfer`) counts against a cap that covers the key's whole life. It does not limit who receives a transfer.

These helpers follow the wallet code every Veil wallet on mainnet runs (WASM SHA-256 `b485f817469402ba4ccc24ea30077308f69589cbe0897db49087b15f58659ea5`, source `contracts/invisible_wallet/src/` at commit `ccebd01a9b71c9857e6cd1e05dbdf6d45ea38ba2`), not `main`.

```ts
import {
  buildRegisterSessionKeyCall,
  buildRevokeSessionKeyCall,
  readSessionKeyNetworkLimits,
  readSessionKey,
  signAuthEntryWithSessionKey,
  sessionKeyRetryableError,
} from 'invisible-wallet-sdk';

// Owner side: build the call, then sign it with the passkey ceremony
// (mobile: invokeAsWallet(call.contractId, call.method, call.args)).
const limits = await readSessionKeyNetworkLimits(server);
const call = buildRegisterSessionKeyCall(walletAddress, {
  pubkey, keyId, targetContract: tokenId, selector: 'transfer',
  amountCap: 10_000_000n, expiry: limits.ledgerTime + 86_400n,
}, limits);

// Session-key side: sign each wallet auth entry of a simulated call.
const { entry } = signAuthEntryWithSessionKey(simulatedEntry, {
  sessionKey, keyId, walletAddress, allowed: hostFunctionCalls(tx),
  walletNonce, validUntilLedger, networkPassphrase,
});

// Anyone: read the record. null means "cannot authorise anything now".
const record = await readSessionKey(server, walletAddress, keyId);
```

What the deployed contract does, and what the helpers assume:

- `amount_cap` is a lifetime total. `spent` only goes up. Registering the same `key_id` again overwrites the record and sets `spent` back to 0.
- The wallet nonce is shared with the passkey. If both sign against the same nonce, one is refused with `NonceMismatch`. The host reports every `__check_auth` refusal as `Error(Auth, InvalidAction)`, so `sessionKeyRetryableError(simulation, walletAddress)` reads the wallet's own error from the simulation's diagnostic events and returns a retryable `SessionKeyNonceMismatch` only for that case. Read the nonce again and resubmit.
- `readSessionKey` returns `null` for a revoked key, an expired key whose record was removed and a key that was never registered alike. It does not guess which.
- **Longest expiry.** The contract extends the record's storage lifetime to `(expiry - now) / 5 + 10` ledgers. Measured on testnet against the deployed WASM: a request for `maxEntryTtl - 1` ledgers is accepted, and a request for `maxEntryTtl` fails the whole registration with `Error(Storage, InvalidAction)`. With `maxEntryTtl` at 3,110,400 ledgers (mainnet and testnet), that is about 180 days. `buildRegisterSessionKeyCall` refuses any expiry past `maxSessionKeyExpiry(limits)`, which keeps one hour below that edge.
- The record also lives for at least the network's minimum temporary-entry lifetime (17,280 ledgers, about a day, on mainnet; 720 on testnet), so a key with a short expiry stays readable after it stops working. The contract refuses it from 60 seconds after `expiry`.

What a session key can and cannot do, with transaction hashes from testnet, is in [`docs/SESSION_KEYS.md`](../docs/SESSION_KEYS.md).

`npm run test:network` runs these against the deployed wallet code on testnet. It deploys a fresh wallet from the WASM read from mainnet by hash, checks that hash, and drives it with a software passkey.

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

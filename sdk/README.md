# invisible-wallet-sdk

TypeScript SDK for Veil / Invisible Wallet (Soroban + WebAuthn passkeys). Supports Web (React, Vue 3, vanilla JS/TS) and React Native / Expo.

---

## Installation

```bash
npm install invisible-wallet-sdk @stellar/stellar-sdk
```

Optional peer dependencies based on your framework:
- **React**: `npm install react react-dom @tanstack/react-query`
- **Vue 3**: `npm install vue`
- **React Native / Expo**: `npm install react-native react-native-passkey`

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

### 3. Vanilla / Framework-Agnostic

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

## Subpath Exports

The package provides verified export subpaths:

| Subpath | Description |
|---|---|
| `invisible-wallet-sdk` | Default entry point (Core API + React `useInvisibleWallet`) |
| `invisible-wallet-sdk/react` | React provider and specialized hooks (`useBalance`, `useHistory`, `useSendTransaction`) |
| `invisible-wallet-sdk/vue` | Vue 3 composable (`useInvisibleWallet`) |
| `invisible-wallet-sdk/vanilla` | Framework-agnostic client (`createInvisibleWallet`) |

---

## License

MIT

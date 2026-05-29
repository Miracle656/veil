# Vue 3 Example Application

This example demonstrates how to use the `@veil/invisible-wallet-vue` composable in a Vue 3 application.

## Setup

```bash
npm install vue @veil/invisible-wallet-vue invisible-wallet-sdk @stellar/stellar-sdk
```

## Basic Usage

### Registration

```vue
<script setup lang="ts">
import { useInvisibleWallet } from '@veil/invisible-wallet-vue';
import { Networks } from '@stellar/stellar-sdk';

const wallet = useInvisibleWallet({
  factoryAddress: 'CABC...', // Your factory contract address
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET_NETWORK_PASSPHRASE,
});

const handleRegister = async () => {
  try {
    const { walletAddress, publicKeyBytes } = await wallet.register('myusername');
    console.log('Wallet registered:', walletAddress);
  } catch (err) {
    console.error('Registration failed:', err);
  }
};
</script>

<template>
  <div>
    <button @click="handleRegister">Register Wallet</button>
    <p v-if="wallet.address">Wallet Address: {{ wallet.address }}</p>
    <p v-if="wallet.isPending">Loading...</p>
    <p v-if="wallet.error" class="error">{{ wallet.error }}</p>
  </div>
</template>
```

### Login

```vue
<script setup lang="ts">
const handleLogin = async () => {
  const result = await wallet.login();
  if (result) {
    console.log('Logged in:', result.walletAddress);
  }
};
</script>

<template>
  <button @click="handleLogin">Login</button>
</template>
```

### Deploy

```vue
<script setup lang="ts">
import { Keypair } from '@stellar/stellar-sdk';

const handleDeploy = async () => {
  const signerKeypair = Keypair.fromSecret('SBXXX...');
  const result = await wallet.deploy(signerKeypair);
  console.log('Deployed:', result.walletAddress, 'Already deployed:', result.alreadyDeployed);
};
</script>

<template>
  <button @click="handleDeploy">Deploy Wallet</button>
</template>
```

### Signing

```vue
<script setup lang="ts">
const handleSign = async () => {
  const payload = new Uint8Array(32);
  const signature = await wallet.signAuthEntry(payload);
  console.log('Signature:', signature);
};
</script>

<template>
  <button @click="handleSign">Sign Message</button>
</template>
```

## Reactive State

The composable provides reactive refs for:

- `address`: The wallet's contract address (or null if not registered)
- `isDeployed`: Whether the wallet contract exists on-chain
- `isPending`: Whether an operation is in progress
- `error`: The last error message (or null)

## Composable API

All methods are the same as the React hook:

- `register(username?: string)`: Create a new passkey and wallet
- `deploy(signerKeypair, publicKeyBytes?)`: Deploy wallet on-chain
- `login()`: Restore wallet from localStorage
- `signAuthEntry(payload)`: Sign a Soroban auth entry
- `getNonce()`: Get current wallet nonce
- `addSigner(signerKeypair, publicKeyBytes)`: Add a co-signer
- `getSigners()`: List all signers
- `removeSigner(signerKeypair, index)`: Remove a signer
- `setGuardian(signerKeypair, guardianAddress)`: Set recovery guardian
- `initiateRecovery(guardianKeypair, newPublicKeyBytes)`: Start key recovery
- `completeRecovery(payerKeypair)`: Finish key recovery
- `getAllowance(spender, token)`: Check spending limit
- `approve(signerKeypair, spender, token, amount, expiry?)`: Set spending limit

## Error Handling

The composable throws custom error classes for specific scenarios:

```vue
<script setup lang="ts">
import { RecoveryTimelockActive, NoGuardianSet } from '@veil/invisible-wallet-vue';

const handleCompleteRecovery = async () => {
  try {
    await wallet.completeRecovery(payerKeypair);
  } catch (err) {
    if (err instanceof RecoveryTimelockActive) {
      console.log('Recovery available at:', new Date(err.unlockTime * 1000));
    } else if (err instanceof NoGuardianSet) {
      console.log('Please set a guardian first');
    }
  }
};
</script>
```

## Full Example Component

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { useInvisibleWallet } from '@veil/invisible-wallet-vue';
import { Keypair, Networks } from '@stellar/stellar-sdk';

const username = ref('');
const signerSecret = ref('');

const wallet = useInvisibleWallet({
  factoryAddress: import.meta.env.VITE_FACTORY_ADDRESS || 'CABC...',
  rpcUrl: import.meta.env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET_NETWORK_PASSPHRASE,
});

const register = async () => {
  await wallet.register(username.value);
};

const deploy = async () => {
  if (!signerSecret.value) return;
  const keypair = Keypair.fromSecret(signerSecret.value);
  await wallet.deploy(keypair);
};

const login = async () => {
  await wallet.login();
};

const sign = async () => {
  const payload = new Uint8Array(32);
  await wallet.signAuthEntry(payload);
};
</script>

<template>
  <div class="container">
    <h1>Veil Invisible Wallet - Vue 3 Example</h1>
    
    <section>
      <h2>Wallet Status</h2>
      <p v-if="wallet.address">Address: {{ wallet.address }}</p>
      <p v-if="!wallet.address">Not registered</p>
      <p>Deployed: {{ wallet.isDeployed }}</p>
      <p v-if="wallet.isPending">Loading...</p>
      <p v-if="wallet.error" class="error">Error: {{ wallet.error }}</p>
    </section>

    <section>
      <h2>Register</h2>
      <input v-model="username" placeholder="Username" />
      <button @click="register">Register</button>
    </section>

    <section>
      <h2>Deploy</h2>
      <input v-model="signerSecret" placeholder="Signer Secret Key" type="password" />
      <button @click="deploy">Deploy</button>
    </section>

    <section>
      <h2>Login</h2>
      <button @click="login">Login</button>
    </section>

    <section>
      <h2>Sign</h2>
      <button @click="sign">Sign Message</button>
    </section>
  </div>
</template>

<style scoped>
.container {
  max-width: 800px;
  margin: 0 auto;
  padding: 20px;
}

section {
  margin: 20px 0;
  padding: 15px;
  border: 1px solid #ddd;
  border-radius: 8px;
}

input {
  margin-right: 10px;
  padding: 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
}

button {
  padding: 8px 16px;
  background: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

button:hover {
  background: #0056b3;
}

.error {
  color: red;
}
</style>
```

## Environment Variables

Create a `.env` file in your Vite app:

```
VITE_FACTORY_ADDRESS=CAxxxx...
VITE_RPC_URL=https://soroban-testnet.stellar.org
```

## Running with Vite

```bash
npm install
npm run dev
# Open http://localhost:5173
```

## Notes

- The composable stores state in `localStorage` (address, key ID, public key)
- WebAuthn requires HTTPS (except on localhost)
- All methods are reactive and update the `address`, `isDeployed`, `isPending`, and `error` refs
- The composable initializes on component mount and cleans up on unmount

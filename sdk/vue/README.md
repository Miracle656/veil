# @veil/invisible-wallet-vue

Vue 3 Composition API adapter for the Invisible Wallet SDK.

## Installation

```bash
npm install @veil/invisible-wallet-vue invisible-wallet-sdk vue @stellar/stellar-sdk
```

## Quick Start

```vue
<script setup lang="ts">
import { useInvisibleWallet } from '@veil/invisible-wallet-vue';
import { Networks } from '@stellar/stellar-sdk';

const wallet = useInvisibleWallet({
  factoryAddress: 'CABC...', // Your factory contract address
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: Networks.TESTNET_NETWORK_PASSPHRASE,
});

// Register a new wallet
const register = async () => {
  const { walletAddress, publicKeyBytes } = await wallet.register('myusername');
  console.log('Wallet created:', walletAddress);
};

// Deploy to chain
const deploy = async () => {
  const result = await wallet.deploy(signerKeypair);
  console.log('Deployed:', result.walletAddress);
};
</script>

<template>
  <div>
    <p v-if="wallet.address">Wallet: {{ wallet.address }}</p>
    <p v-if="wallet.isPending">Loading...</p>
    <button @click="register">Register</button>
    <button @click="deploy">Deploy</button>
  </div>
</template>
```

## API

### useInvisibleWallet(config)

Returns a composable with reactive state and methods.

#### Configuration

```typescript
interface WalletConfig {
  factoryAddress: string;      // Factory contract address
  rpcUrl: string;             // Soroban RPC URL
  networkPassphrase: string;  // Stellar network passphrase
  rpId?: string;              // WebAuthn RP ID (defaults to hostname)
  origin?: string;            // WebAuthn origin (defaults to window.origin)
}
```

#### Reactive State

```typescript
interface WalletState {
  address: Readonly<Ref<string | null>>;      // Wallet contract address
  isDeployed: Readonly<Ref<boolean>>;         // Deployment status
  isPending: Readonly<Ref<boolean>>;          // Operation in progress
  error: Readonly<Ref<string | null>>;        // Last error message
}
```

#### Methods

All methods are async and update the reactive state automatically:

- **register(username?: string)**: Create a new passkey and wallet
- **deploy(signerKeypair, publicKeyBytes?)**: Deploy wallet on-chain
- **login()**: Restore wallet from localStorage
- **signAuthEntry(payload)**: Sign a Soroban auth entry
- **getNonce()**: Get current wallet nonce
- **addSigner(signerKeypair, publicKeyBytes)**: Add a co-signer
- **getSigners()**: List all signers
- **removeSigner(signerKeypair, index)**: Remove a signer
- **setGuardian(signerKeypair, guardianAddress)**: Set recovery guardian
- **initiateRecovery(guardianKeypair, newPublicKeyBytes)**: Start key recovery
- **completeRecovery(payerKeypair)**: Finish key recovery
- **getAllowance(spender, token)**: Check spending limit
- **approve(signerKeypair, spender, token, amount, expiry?)**: Set spending limit

## Error Handling

Custom error classes for specific scenarios:

```typescript
import { 
  RecoveryTimelockActive, 
  NoGuardianSet, 
  RecoveryNotPending 
} from '@veil/invisible-wallet-vue';

try {
  await wallet.completeRecovery(payerKeypair);
} catch (err) {
  if (err instanceof RecoveryTimelockActive) {
    const date = new Date(err.unlockTime * 1000);
    console.log('Recovery available at:', date);
  }
}
```

## Examples

See [EXAMPLE.md](./EXAMPLE.md) for comprehensive usage examples including:

- Registration with WebAuthn
- Wallet deployment
- Login/restore
- Message signing
- Adding/removing signers
- Guardian-based recovery
- Spending limits

## Differences from React Hook

The Vue composable provides the same functionality as the React hook (`useInvisibleWallet`), but uses Vue's Composition API:

- React: `useState` → Vue: `ref`
- React: `useEffect` → Vue: `onMounted`/`onUnmounted`
- React: state objects → Vue: readonly refs

The underlying `InvisibleWalletCore` class is identical, ensuring feature parity.

## TypeScript Support

Full TypeScript support with types exported from the package:

```typescript
import type { 
  WalletConfig, 
  RegisterResult, 
  DeployResult,
  SignerInfo,
  InitiateRecoveryResult 
} from '@veil/invisible-wallet-vue';
```

## Browser Requirements

- **WebAuthn support** (all modern browsers support this)
- **localStorage** for persisting wallet state
- **HTTPS** required (except for localhost in development)

## License

MIT

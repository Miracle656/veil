# Resolved Merge Conflict — `README.md`

````md
## Usage

### React

The `@veil/invisible-wallet-sdk` package provides a React hook wrapper for the core wallet:

```tsx
import { useInvisibleWallet } from '@veil/invisible-wallet-sdk';
import { Networks } from '@stellar/stellar-sdk';

function App() {
  const wallet = useInvisibleWallet({
    factoryAddress: FACTORY_CONTRACT_ID,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: Networks.TESTNET,
  });

  async function setupWallet() {
    // Register a passkey and deploy a wallet contract
    await wallet.register('alice');
    const { walletAddress } = await wallet.deploy();

    // Sign a Soroban authorization entry
    const sig = await wallet.signAuthEntry(signaturePayload);
    // sig = { publicKey, authData, clientDataJSON, signature }
    // Encode sig as Vec<Val> and attach to the Soroban auth entry

    // Multi-signer management
    await wallet.addSigner(newPublicKey);
    await wallet.removeSigner(signerIndex);

    // Guardian recovery
    await wallet.setGuardian(guardianPublicKey);
    await wallet.initiateRecovery(newPublicKey);
    await wallet.completeRecovery(); // after 3-day timelock

    console.log(walletAddress);
  }

  return <button onClick={setupWallet}>Setup Wallet</button>;
}
````

### Svelte / SvelteKit

The `@veil/invisible-wallet-svelte` package provides a reactive Svelte store interface:

```svelte
<script lang="ts">
  import { createWallet } from '@veil/invisible-wallet-svelte';

  const wallet = createWallet({
    factoryAddress: FACTORY_CONTRACT_ID,
    rpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  });

  // Subscribe to the reactive store state
  $: ({ status, walletAddress, isDeployed, error } = $wallet);

  async function handleRegister() {
    await wallet.register('alice');
  }

  async function handleDeploy() {
    await wallet.deploy(feePayerKeypair);
  }

  async function handleSend() {
    // send() constructs, sims, signs with passkey, and submits transaction
    await wallet.send(recipient, amount, feePayerKeypair);
  }
</script>
```

### Without a framework

```js
import { createInvisibleWallet } from 'invisible-wallet-sdk/vanilla';

// Initialize wallet
const wallet = createInvisibleWallet({
  factoryAddress: FACTORY_CONTRACT_ID,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
});

async function main() {
  // Register a passkey and deploy a wallet contract
  await wallet.register('alice');
  await wallet.deploy(feePayerKeypair);

  // Sign a Soroban authorization entry
  const sig = await wallet.signAuthEntry(signaturePayload);

  console.log(sig);
}

main();
```

```

## What Was Fixed

- Removed Git merge conflict markers:
  - `<<<<<<< feat/sdk-svelte-adapter`
  - `=======`
  - `>>>>>>> main`
- Preserved BOTH implementations:
  - React SDK usage
  - Svelte/SvelteKit adapter usage
  - Vanilla JS usage
- Cleaned formatting and markdown nesting
- Added missing helper function wrappers to avoid invalid top-level `await`
- Added missing `Networks` import for React example

```

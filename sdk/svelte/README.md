# `@veil/invisible-wallet-svelte`

Svelte bindings for the Invisible Wallet SDK: a writable store plus
`register` / `login` / `deploy` / `sign` / `send` helpers, built on top of the
framework-agnostic `invisible-wallet-sdk/vanilla` core. No React dependency
enters the Svelte bundle.

## Install

```bash
cd sdk && npm install && npm run build   # build the SDK first
cd svelte && npm install
```

## Usage

```ts
import { createWalletStore } from '@veil/invisible-wallet-svelte';

const wallet = createWalletStore({
  factoryAddress: FACTORY_CONTRACT_ID,
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
});

// Subscribe reactively in a component:
// <p>{$wallet.status} — {$wallet.walletAddress}</p>

await wallet.register('alice');
await wallet.deploy(feePayerSecret);
const sig = await wallet.sign(signaturePayload);
await wallet.send(feePayerSecret, recipientAddress, amountInStroops);
```

A full SvelteKit example (register / dashboard / send routes) lives in
[`examples/sveltekit`](../../examples/sveltekit).

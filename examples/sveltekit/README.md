# Veil Wallet — SvelteKit Starter

A minimal [SvelteKit](https://kit.svelte.dev) example showing how to integrate
`invisible-wallet-sdk` via its `/svelte` subpath. It
covers passkey registration, wallet deployment, balance display, and sending a
payment authorized with a passkey.

## What's inside

| Route | Description |
|---|---|
| `/` | Register a new passkey wallet (and deploy it), or log in to an existing one |
| `/dashboard` | Live XLM balance for the wallet |
| `/send` | Send a native XLM payment, signed with the passkey via the wallet store |

## The Svelte adapter

`$lib/wallet.ts` creates a single `createWalletStore` instance (from
[`invisible-wallet-sdk/svelte`](../../sdk/src/svelte)) shared across routes:

```ts
import { wallet } from '$lib/wallet';

await wallet.register('alice');       // create passkey, compute wallet address
await wallet.deploy(feePayerSecret);  // deploy the contract via the factory
await wallet.send(feePayerSecret, to, amountInStroops);
```

`$wallet` (Svelte's store auto-subscription) reactively reflects
`{ status, walletAddress, error }` anywhere in the app.

## Prerequisites

- Node.js 18+
- A browser that supports WebAuthn (all modern browsers do)
- The SDK and Svelte adapter built locally:
  ```bash
  cd ../../sdk && npm install && npm run build
  cd svelte && npm install
  ```

## Quick start

```bash
# 1. Install dependencies
cd examples/sveltekit
npm install

# 2. Configure environment (testnet defaults work out of the box)
cp .env.example .env

# 3. Start the dev server
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Default |
|---|---|
| `PUBLIC_NETWORK` | `testnet` |
| `PUBLIC_SOROBAN_RPC_URL` | testnet Soroban RPC |
| `PUBLIC_HORIZON_URL` | testnet Horizon |
| `PUBLIC_FACTORY_CONTRACT_ID` | _(empty)_ |

# Veil Wallet — Next.js Starter

A minimal Next.js 14 + App Router example showing how to integrate
`invisible-wallet-sdk` into your own app. Covers passkey registration,
wallet deployment, balance display, and a send form — all on Stellar testnet.

## What's inside

| Route | Description |
|---|---|
| `/` | Register a new passkey wallet or log in to an existing one |
| `/dashboard` | Live XLM balance fetched from the Soroban RPC |
| `/send` | Send XLM to any Stellar address, confirmed with a passkey |

## Prerequisites

- Node.js 18+
- A browser that supports WebAuthn (Chrome, Safari, Firefox — all modern versions do)
- The SDK built locally (`cd ../../sdk && npm install && npm run build`)

## Quick start

```bash
# 1. Install dependencies
cd examples/nextjs
npm install

# 2. Configure environment
cp .env.example .env.local
# Testnet defaults work out of the box — no edits needed

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How it works

### Registration (`/`)

1. `useInvisibleWallet(walletConfig).register()` calls `navigator.credentials.create`
   and stores the passkey credential ID + P-256 public key in `localStorage`.
2. A random Stellar keypair is generated as the **fee-payer** and funded via
   Friendbot (testnet only). This keypair pays transaction fees; it does **not**
   control the wallet.
3. `wallet.deploy(feePayerSecret)` submits a `factory.deploy()` Soroban transaction
   and returns the deterministic wallet contract address (`C…`).

### Balance (`/dashboard`)

The wallet is a Soroban contract, so its XLM balance lives in the native SAC
(Stellar Asset Contract). The dashboard simulates a `balance()` call against the
SAC — no transaction is submitted, no fee is paid.

### Send (`/send`)

1. A WebAuthn assertion (`navigator.credentials.get`) proves the user controls
   the passkey — this is the "sign with passkey" step.
2. A Soroban `transfer()` call is built against the native SAC, simulated,
   assembled, signed by the fee-payer keypair, and submitted.
3. The app polls `getTransaction()` until the transaction is confirmed, then
   shows a link to stellar.expert.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `NEXT_PUBLIC_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `NEXT_PUBLIC_FACTORY_CONTRACT_ID` | testnet factory | Factory contract address |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | testnet RPC | Soroban RPC endpoint |
| `NEXT_PUBLIC_HORIZON_URL` | testnet Horizon | Horizon REST endpoint |

## Deploying your own factory

See [`contracts/factory/DEPLOY.md`](../../contracts/factory/DEPLOY.md) for
instructions on deploying the factory contract to testnet or mainnet.

## Going further

- Add guardian-based recovery with `wallet.setGuardian()` / `wallet.initiateRecovery()`
- Set spending limits with `wallet.approve()`
- Swap tokens via the Soroswap SDK (see `frontend/wallet/app/swap`)
- Connect to dApps via WalletConnect (see `frontend/wallet/components/ConnectDAppModal`)

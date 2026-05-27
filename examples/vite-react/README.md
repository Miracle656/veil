# Veil — Vite + React Example

This is a minimal Vite + React + TypeScript starter demonstrating the three core flows from the Next.js example: register, dashboard, and send.

Setup

1. From the repo root build the SDK so the example can consume the local package:

```bash
cd sdk
npm install
npm run build
```

2. Install and run the example:

```bash
cd examples/vite-react
npm install
npm run dev
```

3. Open http://localhost:5173

Environment

Place these in a `.env` file at `examples/vite-react/.env` or export them in your shell:

```
VITE_FACTORY_ADDRESS=YOUR_FACTORY_ADDRESS
VITE_RPC_URL=https://soroban-testnet.stellar.org
VITE_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
```

Notes

- This example intentionally mirrors the Next.js demo flows but keeps the UI minimal.
- The `invisible-wallet-sdk` dependency is consumed from the repository local `sdk/` package (file reference).

Closes #177
# Veil Vite Starter

This example is a small Vite + React + TypeScript starter for the Veil passkey wallet SDK.
It mirrors the Next.js starter flow with three routes:

- `/register` - create the passkey wallet and deploy it
- `/dashboard` - confirm the stored wallet and demo a signed auth entry
- `/send` - send XLM to `G...` or `C...` recipients

## Prerequisites

- Node.js 18+
- A deployed Veil factory contract address
- WebAuthn-capable browser

## Setup

From the repository root:

```bash
cd examples/vite-react
npm install
```

Create a local environment file with the network settings you want to use:

```env
VITE_FACTORY_ADDRESS=YOUR_FACTORY_CONTRACT_ADDRESS
VITE_RPC_URL=https://soroban-testnet.stellar.org
VITE_HORIZON_URL=https://horizon-testnet.stellar.org
VITE_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
VITE_FRIENDBOT_URL=https://friendbot.stellar.org
```

## Run locally

```bash
npm run dev
```

## Build

```bash
npm run build
```

## Notes

- The starter stores the wallet address, credential ID, and fee-payer key in browser storage to match the existing Veil example flow.
- The send route supports both classic `G...` payments and native SAC `C...` transfers.

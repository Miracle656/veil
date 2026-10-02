# Veil Wallet — Nuxt 3 Starter

A minimal [Nuxt 3](https://nuxt.com) example showing how to integrate
`invisible-wallet-sdk` into a Vue/SSR app. It covers passkey registration,
wallet deployment, balance display, and a **server route that handles the
SEP-24 interactive callback**.

Nuxt is Vue's SSR meta-framework, so this example also demonstrates two things
specific to that environment:

- A small **Vue adapter** (`composables/useInvisibleWallet.ts`) that wraps the
  SDK's framework-agnostic `vanilla` build in Vue reactivity (Vue adapter, #173).
- **SSR-safety**: the SDK relies on WebAuthn + `localStorage`, which only exist
  in the browser, so wallet UI is rendered inside `<ClientOnly>` and the wallet
  instance is created lazily on the client.

## What's inside

| Route | Type | Description |
|---|---|---|
| `/` | page | Register a new passkey wallet, or log in to an existing one |
| `/dashboard` | page | Live XLM balance + a SEP-24 deposit button |
| `POST /api/sep24/deposit` | server route | Starts an interactive deposit with the anchor |
| `GET/POST /api/sep24/callback` | server route | Handles the SEP-24 interactive callback |

## Prerequisites

- Node.js 18+
- A browser that supports WebAuthn (all modern browsers do)
- The SDK built locally:
  ```bash
  cd ../../sdk && npm install && npm run build
  ```

## Quick start

```bash
# 1. Install dependencies
cd examples/nuxt
npm install

# 2. Configure environment (testnet defaults work out of the box)
cp .env.example .env

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Production build:

```bash
npm run build && npm run preview
```

## The Vue adapter

`composables/useInvisibleWallet.ts` is the bridge between the SDK and Vue:

```ts
const { address, isDeployed, register, deploy, login, logout } = useInvisibleWallet()

await register('alice')        // create passkey, compute wallet address
await deploy(feePayerSecret)   // deploy the contract via the factory
```

It returns `readonly` refs for `address` / `isDeployed` / `ready` and async
methods that proxy to the vanilla `InvisibleWallet`, keeping the reactive state
in sync. Because the SDK is browser-only, every method throws a clear error if
called during SSR — so read wallet state inside `<ClientOnly>`.

> When the official Vue adapter (#173) lands in the SDK, this composable can be
> replaced by importing it directly; the surface is intentionally identical.

## The SEP-24 callback server route

[SEP-24](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md)
is the standard for interactive (hosted) deposits and withdrawals. The flow:

1. The dashboard calls **`POST /api/sep24/deposit`**. That Nitro route reads the
   anchor's `stellar.toml`, calls `…/transactions/deposit/interactive`, and
   passes a `callback` URL pointing at our callback route. It returns the
   anchor's interactive `url` + transaction `id`.
2. The browser opens `url` in a popup; the user completes KYC / payment on the
   anchor's hosted page.
3. The anchor notifies us via **`/api/sep24/callback`**, which handles both
   delivery modes:
   - **GET (redirect):** the anchor redirects the popup back with
     `transaction_id`. The route fetches the canonical status from the anchor's
     `/transaction` endpoint, then redirects the user to
     `/dashboard?deposit=<status>&id=<id>` so the result is shown.
   - **POST (server-to-server):** the anchor POSTs the transaction JSON on every
     status change. The route acks with `200`; a real app would persist the
     update and notify the user.

Files:

- `server/api/sep24/deposit.post.ts` — starts the interactive deposit
- `server/api/sep24/callback.ts` — handles the interactive callback
- `server/utils/sep24.ts` — server-side TOML discovery + anchor HTTP helpers

### Notes for production

- Production anchors require a **SEP-10 JWT**. Obtain it by signing the anchor's
  challenge with the wallet passkey on the client, then forward it to the deposit
  route as a `Bearer` token. The Stellar reference test anchor
  (`testanchor.stellar.org`) accepts unauthenticated interactive requests, which
  keeps this demo self-contained.
- Set `ANCHOR_DOMAIN` in `.env` to point at a different anchor. The default asset
  code is `SRT` (the test anchor's asset); change it in `pages/dashboard.vue`.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Scope | Default |
|---|---|---|
| `NUXT_PUBLIC_NETWORK` | client | `testnet` |
| `NUXT_PUBLIC_SOROBAN_RPC_URL` | client | testnet Soroban RPC |
| `NUXT_PUBLIC_HORIZON_URL` | client | testnet Horizon |
| `NUXT_PUBLIC_FACTORY_CONTRACT_ID` | client | _(empty)_ |
| `ANCHOR_DOMAIN` | server | `testanchor.stellar.org` |

# Veil Wallet — Remix Starter

A minimal [Remix](https://remix.run) (Vite) example showing how to integrate
`invisible-wallet-sdk`. It demonstrates passkey registration, a **`loader` that
reads the balance server-side**, and a **payment `action` that submits the
transaction server-side**.

Remix's SSR model is built around two server functions per route — `loader`
(reads data for a GET) and `action` (handles a mutation/POST). This example
exists to show exactly how the SDK fits into that model.

## What's inside

| Route | Server fn | Description |
|---|---|---|
| `app/routes/_index.tsx` | — | Register a passkey wallet / log in (client-only) |
| `app/routes/dashboard.tsx` | `loader` | Reads the wallet's XLM balance server-side |
| `app/routes/payment.tsx` | `action` | Submits a signed payment server-side |

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
cd examples/remix
npm install

# 2. Configure environment (testnet defaults work out of the box)
cp .env.example .env

# 3. Start the dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Production build & serve:

```bash
npm run build && npm run start
```

## The loader / action pattern

### `loader` — read data on the server (`dashboard.tsx`)

```ts
export async function loader({ request }: LoaderFunctionArgs) {
  const address = new URL(request.url).searchParams.get('address')
  // …read the SAC balance via a read-only Soroban RPC simulation…
  return { address, balance }
}
```

The loader runs on the server for every GET / revalidation. The component reads
its result with `useLoaderData()`, and `useRevalidator()` re-runs it on demand
(the "Refresh" button). The wallet address comes from the `?address=` search
param, which the component appends from `localStorage` on mount — so the
balance-reading code never ships to the browser.

### `action` — mutate on the server (`payment.tsx`)

Because the wallet's passkey lives in the browser, signing happens client-side;
**submission happens in the action**:

1. The component builds the SAC transfer, simulates + assembles it, and signs it
   with the fee-payer keypair — all in the browser.
2. It hands the signed XDR to the server via `useFetcher().submit({ xdr }, { method: 'post' })`.
3. The `action` broadcasts the transaction with the Soroban RPC server, polls for
   confirmation, and returns `{ hash }` (or `{ error }`):

```ts
export async function action({ request }: ActionFunctionArgs) {
  const xdr = String((await request.formData()).get('xdr'))
  const server = new SorobanRpc.Server(net.rpcUrl)
  const tx = TransactionBuilder.fromXDR(xdr, net.networkPassphrase)
  const sent = await server.sendTransaction(tx)
  // …poll getTransaction(sent.hash)…
  return { hash: sent.hash }
}
```

This keeps network submission (and any future server-held secrets/policies) on
the server, while the passkey signature stays on the device.

## SSR notes

- `invisible-wallet-sdk` relies on WebAuthn + `localStorage`, so it's pulled in
  via a **client-only dynamic import** (`await import('invisible-wallet-sdk/vanilla')`)
  inside event handlers — it never enters the server bundle.
- Public configuration is exposed to the browser via the root loader as
  `window.ENV` (see `app/root.tsx` and `app/lib/network.ts`); secrets stay on the
  server.

## Configuration

Environment variables (see `.env.example`):

| Variable | Default |
|---|---|
| `NETWORK` | `testnet` |
| `SOROBAN_RPC_URL` | testnet Soroban RPC |
| `HORIZON_URL` | testnet Horizon |
| `FACTORY_CONTRACT_ID` | _(empty)_ |

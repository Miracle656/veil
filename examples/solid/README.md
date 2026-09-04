# Veil — Vite + Solid starter

A Solid.js app built on `invisible-wallet-sdk/solid`, covering the three flows
the SDK is for: **register**, **login**, and **send**.

```
src/
├── lib.ts      # network config, session storage, fee-payer derivation
├── App.tsx     # RegisterPage → DashboardPage → SendPage, wired with @solidjs/router
└── index.tsx   # mounts the router
```

## Setup

Build the SDK first — the example links to it from source:

```bash
cd ../../sdk
npm install
npm run build
```

Then:

```bash
cd ../examples/solid
cp .env.example .env.local   # set VITE_FACTORY_ADDRESS
npm install
npm run dev                  # http://localhost:3000
```

Only `VITE_FACTORY_ADDRESS` is required; the rest default to testnet.

WebAuthn requires a secure context, so use `localhost` (or HTTPS) — an IP
address like `127.0.0.1:3000` will not prompt for a passkey.

## How the primitive is used

`useInvisibleWallet()` returns Solid accessors alongside the actions:

```tsx
const wallet = useInvisibleWallet({
  factoryAddress: appConfig.factoryAddress,
  rpcUrl: appConfig.rpcUrl,
  networkPassphrase: appConfig.networkPassphrase,
});

<Show when={wallet.address()} fallback={
  <button disabled={wallet.isPending()} onClick={() => wallet.register('alice')}>
    Create wallet
  </button>
}>
  <p>Wallet: {wallet.address()}</p>
</Show>
```

Each call creates an independent wallet, and this starter calls it once per
page. That works because the wallet address is persisted and restored on mount,
but state set on one page — a pending flag, a last error — does not carry to the
next. An app that wants one shared instance should call it once at module scope
and import that, the way [`examples/vue/src/lib/wallet.ts`](../vue/src/lib/wallet.ts)
does.

Called inside a component, the primitive hydrates in `onMount` and detaches in
`onCleanup`, so storage and `window` are never touched during a solid-start
server render.

## The two accounts

Veil separates ownership from fee payment:

- the **wallet contract** (`C…`) holds the funds and is controlled by your passkey;
- the **fee payer** (`G…`) is an ordinary Stellar account that only pays network fees.

This starter derives the fee payer from the passkey credential ID and keeps the
secret in `localStorage`. That is fine for testnet and **not** how a production
app should do it — use the SDK's PRF helpers, or sponsor fees server-side.

## Notes

- `vite.config.ts` dedupes `solid-js` and pre-bundles the linked SDK. Both
  matter: two Solid runtimes break reactivity with no error, and the linked SDK
  is CommonJS, which Vite does not pre-bundle by default.
- Amounts are contract units: 1 XLM = 10,000,000 stroops. `SendPage` converts.

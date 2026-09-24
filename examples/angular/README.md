# Veil · Angular example

A standalone Angular 18 starter for the `invisible-wallet-sdk/angular` adapter.
It demonstrates the whole integration surface: `provideVeil` at bootstrap,
`inject(VeilService)` in components, and the signal-based state.

## Run

```bash
# 1. Build the SDK once — the example links it locally via `file:../../sdk`.
cd ../../sdk
npm install --legacy-peer-deps
npm run build
cd -

# 2. Install and serve the starter.
npm install
npm start
```

Open http://localhost:4200.

> Note about the linked SDK: because the Angular CLI can't be configured the
> way Vite is for a linked CommonJS package, consuming the adapter through a
> local `npm install` of the SDK rather than a source import is what the
> example supports.

## Configuration

`src/app/environment.ts` holds the network settings. Paste your factory
contract id for `factoryAddress` (see `../vue/.env.example` for the same
settings) or point the fields at mainnet.

## What's inside

| Area | File | Shows |
| --- | --- | --- |
| Bootstrap | `src/app/app.config.ts` | `provideVeil(config)` as a standalone provider |
| Shell | `src/app/app.component.ts` | `inject(VeilService)`; `@if (wallet.address(); as address)` switching |
| Get wallet | `src/app/wallet-panel.component.ts` | `register` + `deploy` with a funded fee payer, `login` |
| Pay | `src/app/send-panel.component.ts` | `sendPayment`, `isPending()` gating the button |
| Fee payer | `src/app/fee-payer.service.ts` | A second root-provided injectable cooperating via DI |
| State | — | `wallet.address()`, `wallet.isDeployed()`, `wallet.isPending()`, `wallet.error()` |

Actions, signals and the config shape match the React, Vue, Svelte and Solid
adapters — they all bind the same `InvisibleWalletCore`.
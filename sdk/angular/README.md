# `invisible-wallet-sdk/angular`

The Angular adapter for Veil's passkey wallet — the same wallet the React hook
and the Vue composable drive, exposed as a Dependency-Injected service with
signals.

This directory is the published subpath entry point; the adapter itself lives in
[`../src/angular/`](../src/angular/) and is compiled to `../dist/angular/`.

## Install

```bash
npm install invisible-wallet-sdk @stellar/stellar-sdk @angular/core
```

`@angular/core` is an optional peer dependency, so React and Vue apps installing
the SDK never pull it in — and neither does the Angular bundle pull in React.

## Configure — standalone (recommended)

Add `provideVeil` to your bootstrap providers, exactly like `provideRouter` or
`provideHttpClient`:

```ts
// src/main.ts
import { bootstrapApplication } from '@angular/platform-browser';
import { provideVeil } from 'invisible-wallet-sdk/angular';

import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, {
  providers: [
    provideVeil({
      factoryAddress: 'CABC…',
      rpcUrl: 'https://soroban-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
    }),
  ],
});
```

Components and services then inject the singleton with `inject(VeilService)`:

```ts
import { Component, inject } from '@angular/core';
import { VeilService } from 'invisible-wallet-sdk/angular';

@Component({
  selector: 'app-wallet',
  standalone: true,
  template: `
    @if (wallet.address(); as address) {
      <p>Wallet: {{ address }}</p>
    } @else {
      <button (click)="wallet.register('alice')">Create wallet</button>
    }
  `,
})
export class WalletComponent {
  readonly wallet = inject(VeilService);
}
```

## Configure — NgModule

Classic (`NgModule`-bootstrapped) apps import `VeilModule.forRoot` instead:

```ts
import { NgModule } from '@angular/core';
import { VeilModule } from 'invisible-wallet-sdk/angular';

@NgModule({
  imports: [VeilModule.forRoot({ factoryAddress, rpcUrl, networkPassphrase })],
})
export class AppModule {}
```

Both paths provide the same `VEIL_WALLET_CONFIG` token and the same
`VeilService`, so the two apps behave identically.

## What you get back

| Injection | Type | Notes |
| --- | --- | --- |
| `state` | `WritableSignal<WalletState>` | The whole status in one signal — `wallet.state()` |
| `address` | `Signal<string \| null>` | Wallet contract address (`C…`) |
| `isDeployed` | `Signal<boolean>` | Contract confirmed on-chain |
| `isPending` | `Signal<boolean>` | An operation is in flight |
| `error` | `Signal<string \| null>` | Last failure message |
| actions | methods | `register`, `deploy`, `login`, `signAuthEntry`, `sendPayment`, `getBalance`, `addSigner`, `removeSigner`, `rotateSigner`, `getSigners`, `setGuardian`, `initiateRecovery`, `completeRecovery`, `approve`, `getAllowance`, `getNonce`, `getPortableSigner`, `deriveCounterfactualAddress`, `outbox`, `replayOutbox`, `encryptLocal`, `decryptLocal`, `encryptionMode` |

The action list is identical to the React hook's and the Vue composable's: all
adapters wrap the same framework-agnostic core (`src/core.ts`), so none can
drift ahead of the others.

## Example app

[`examples/angular/`](../../examples/angular/) is a standalone Angular starter
covering register, login and send — the full `provideVeil` → `inject(VeilService)`
pattern against a live testnet.
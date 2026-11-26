/**
 * Standalone delivery of the Invisible Wallet adapter.
 *
 * Standalone apps configure the wallet at bootstrap by adding `provideVeil` to
 * their environment providers, exactly like `provideRouter` or
 * `provideHttpClient`:
 *
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [provideVeil({ factoryAddress, rpcUrl, networkPassphrase })],
 * });
 * ```
 *
 * The returned providers are just an environment-provider bucket around the
 * config token and {@link VeilService} — no NgModule involved — so they merge
 * with any other bootstrap providers and keep the wallet tree-shakeable from
 * apps that never use it.
 */

import { makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';

import type { WalletConfig } from '../../core';

import { VeilService, VEIL_WALLET_CONFIG } from './veil.service';

/**
 * Configure a passkey wallet for a standalone Angular app.
 *
 * Call once from the bootstrap (`appConfig`) providers; the resulting
 * {@link VeilService} is then injectable anywhere. Every action reads the
 * config afresh when it runs, so the same service switches networks at runtime
 * if you pass a mutable object and update its fields.
 *
 * @param config Network and WebAuthn settings — see {@link WalletConfig}.
 */
export function provideVeil(config: WalletConfig): EnvironmentProviders {
    return makeEnvironmentProviders([
        { provide: VEIL_WALLET_CONFIG, useValue: config },
        VeilService,
    ]);
}
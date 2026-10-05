/**
 * NgModule delivery of the Invisible Wallet adapter.
 *
 * Preferred for classic (NgModule-bootstrapped) apps; standalone apps should
 * configure the wallet with {@link provideVeil} instead. Both paths provide the
 * same {@link VEIL_WALLET_CONFIG} value and the same {@link VeilService}, so a
 * classic app and a standalone app behave identically:
 *
 * ```ts
 * imports: [VeilModule.forRoot({ factoryAddress, rpcUrl, networkPassphrase })]
 * ```
 */

import { NgModule, type ModuleWithProviders } from '@angular/core';

import type { WalletConfig } from '../../core';

import { VeilService, VEIL_WALLET_CONFIG } from './veil.service';

@NgModule({
    providers: [VeilService],
})
export class VeilModule {
    /**
     * Register a wallet for the whole app.
     *
     * Import it once from the root module (or an eagerly-loaded feature module)
     * to configure the shared VeilService with the network's factory address,
     * RPC URL and passphrase.
     */
    static forRoot(config: WalletConfig): ModuleWithProviders<VeilModule> {
        return {
            ngModule: VeilModule,
            providers: [
                { provide: VEIL_WALLET_CONFIG, useValue: config },
            ],
        };
    }
}
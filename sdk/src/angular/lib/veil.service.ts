/**
 * Angular adapter for the Invisible Wallet SDK.
 *
 * All wallet behaviour lives in the framework-agnostic `InvisibleWalletCore`
 * (see `../core`); this file only binds that core to Angular's DI and signals.
 * The React hook, the Vue composable, the Svelte store and the Solid primitive
 * bind the very same core, so every adapter exposes an identical set of actions
 * and none of them can drift.
 *
 * The service reads its {@link WalletConfig} from the {@link VEIL_WALLET_CONFIG}
 * injection token, which is provided by `provideVeil()` (standalone apps) or
 * `VeilModule.forRoot()` (NgModule-based apps). Everything else — the passkey,
 * the Soroban requests, the offline outbox — comes from the shared core.
 *
 * Nothing here — or anywhere in its import graph — touches React, Vue, Svelte
 * or Solid.
 */

import {
    computed,
    inject,
    Injectable,
    InjectionToken,
    OnDestroy,
    signal,
    type Signal,
    type WritableSignal,
} from '@angular/core';

import { InvisibleWalletCore } from '../../core';
import type { WalletConfig, WalletState } from '../../core';

/**
 * Injection token that carries the wallet's network and WebAuthn settings.
 *
 * Provide it via {@link provideVeil()} or `VeilModule.forRoot()` — never by
 * hand, unless you are composing a custom provider set and have already
 * provided {@link VeilService} yourself.
 */
export const VEIL_WALLET_CONFIG = new InjectionToken<WalletConfig>(
    'invisible-wallet-sdk/wallet-config',
);

/**
 * Angular injectable for Veil's passkey wallet.
 *
 * Created once through Dependency Injection (standalone: `provideVeil`,
 * NgModule: `VeilModule.forRoot`) and shared app-wide, which makes it the
 * natural home for a wallet in an Angular app: any component or service can
 * request it with `inject(VeilService)` or a constructor and they all read and
 * write the same state.
 *
 * State arrives as signals — `state`, `address`, `isDeployed`, `isPending`,
 * `error` — each of which updates whenever the underlying wallet changes, so
 * templates react with `@if`/`@else` and no extra wiring. The wallet actions
 * are the same pre-bound methods every other adapter exposes:
 *
 * ```ts
 * import { Component, inject } from '@angular/core';
 * import { VeilService } from 'invisible-wallet-sdk/angular';
 *
 * @Component({
 *   standalone: true,
 *   template: `
 *     @if (wallet.address(); as address) {
 *       <p>Wallet: {{ address }}</p>
 *     } @else {
 *       <button (click)="wallet.register('alice')">Create wallet</button>
 *     }
 *   `,
 * })
 * class WalletComponent {
 *   readonly wallet = inject(VeilService);
 * }
 * ```
 *
 * Hydration and the window `online` listener are set up when the service is
 * first constructed. On the server the core's storage resolves to a no-op and
 * `watchConnectivity` returns a no-op, so the service is safe through an
 * Angular Universal render as long as the config token is provided there too.
 */
@Injectable()
export class VeilService implements OnDestroy {
    private readonly core = new InvisibleWalletCore(resolveConfig());

    /** The whole wallet state as a signal — `wallet.state().address`, `effect(...)` and so on. */
    readonly state: WritableSignal<WalletState> = signal(this.core.getState());

    /** Soroban contract address of the deployed wallet, or null if not yet registered. */
    readonly address: Signal<string | null> = computed(() => this.state().address);
    /** True once the wallet contract is confirmed to exist on-chain. */
    readonly isDeployed: Signal<boolean> = computed(() => this.state().isDeployed);
    /** True while any wallet operation is in flight. */
    readonly isPending: Signal<boolean> = computed(() => this.state().isPending);
    /** Message of the most recent failure, or null. */
    readonly error: Signal<string | null> = computed(() => this.state().error);

    readonly register = this.core.actions.register;
    readonly deploy = this.core.actions.deploy;
    readonly signAuthEntry = this.core.actions.signAuthEntry;
    readonly deriveCounterfactualAddress = this.core.actions.deriveCounterfactualAddress;
    readonly getPortableSigner = this.core.actions.getPortableSigner;
    readonly login = this.core.actions.login;
    readonly getNonce = this.core.actions.getNonce;
    readonly addSigner = this.core.actions.addSigner;
    readonly removeSigner = this.core.actions.removeSigner;
    readonly rotateSigner = this.core.actions.rotateSigner;
    readonly getSigners = this.core.actions.getSigners;
    readonly setGuardian = this.core.actions.setGuardian;
    readonly initiateRecovery = this.core.actions.initiateRecovery;
    readonly completeRecovery = this.core.actions.completeRecovery;
    readonly approve = this.core.actions.approve;
    readonly getAllowance = this.core.actions.getAllowance;
    readonly getBalance = this.core.actions.getBalance;
    readonly sendPayment = this.core.actions.sendPayment;
    readonly outbox = this.core.actions.outbox;
    readonly replayOutbox = this.core.actions.replayOutbox;
    readonly encryptLocal = this.core.actions.encryptLocal;
    readonly decryptLocal = this.core.actions.decryptLocal;
    readonly encryptionMode = this.core.actions.encryptionMode;

    /** Reflect every core change into the state signal, then restore and listen. */
    private readonly unsubscribe = this.core.subscribe((next) => this.state.set(next));
    private readonly stopWatchingConnectivity = this.core.watchConnectivity();

    constructor() {
        // Restore the address persisted by an earlier session. Safe on the
        // server: the core's default storage is a no-op without localStorage.
        this.core.hydrate();
    }

    ngOnDestroy(): void {
        this.stopWatchingConnectivity();
        this.unsubscribe();
    }
}

/**
 * Read the required config from DI, giving a diagnostic when a component or
 * service requested the wallet before the app configured it.
 */
function resolveConfig(): WalletConfig {
    const config = inject(VEIL_WALLET_CONFIG, { optional: true });
    if (!config) {
        throw new Error(
            'VeilService: no wallet configuration found. Provide one at bootstrap with ' +
            'provideVeil({...}) (standalone apps) or import VeilModule.forRoot({...}) ' +
            '(NgModule-based apps).',
        );
    }
    return config;
}
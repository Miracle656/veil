/**
 * Svelte adapter for the Invisible Wallet SDK.
 *
 * All wallet behaviour lives in the framework-agnostic `InvisibleWalletCore`;
 * this file only binds that core to Svelte's store contract. The React hook
 * and the Vue composable bind the very same core, so all three adapters expose
 * an identical set of actions and cannot drift apart.
 *
 * That sharing is the point rather than a tidiness preference. An adapter that
 * builds its own transactions ends up with its own `waitForTransaction`, its
 * own polling limits and its own idea of when a payment has settled — and the
 * next fix to the signing path lands in one adapter and not the other two.
 *
 * Nothing here — or anywhere in its import graph — touches React or Vue.
 */

import { readable, type Readable } from 'svelte/store';

import { InvisibleWalletCore } from '../core';
import type { InvisibleWalletActions, WalletConfig, WalletState } from '../core';

export type { WalletConfig, WalletState } from '../core';

/**
 * What {@link createWalletStore} returns: a Svelte store of the wallet's live
 * state, plus every action the React and Vue adapters expose.
 */
export type VeilWalletStore = InvisibleWalletActions & {
    /**
     * The whole wallet state as a readable store. Use it with `$` in a
     * component (`$wallet.address`) or `.subscribe()` outside one.
     */
    subscribe: Readable<WalletState>['subscribe'];
    /** Detach from the core. Call from `onDestroy` when you created the store yourself. */
    destroy: () => void;
};

/**
 * Create a passkey wallet bound to a Svelte store.
 *
 * ```svelte
 * <script lang="ts">
 *   import { onDestroy } from 'svelte';
 *   import { createWalletStore } from '@veil/invisible-wallet-svelte';
 *
 *   const wallet = createWalletStore({
 *     factoryAddress: 'CABC…',
 *     rpcUrl: 'https://soroban-testnet.stellar.org',
 *     networkPassphrase: 'Test SDF Network ; September 2015',
 *   });
 *
 *   onDestroy(wallet.destroy);
 * </script>
 *
 * {#if $wallet.address}
 *   <p>Wallet: {$wallet.address}</p>
 * {:else}
 *   <button disabled={$wallet.isPending} on:click={() => wallet.register('alice')}>
 *     Create wallet
 *   </button>
 * {/if}
 * ```
 *
 * Storage and `window` are only touched once the store gains its first
 * subscriber, so this is safe to call during SvelteKit's server render — the
 * server produces the initial state and the browser hydrates from there.
 *
 * @param config Network and WebAuthn settings.
 */
export function createWalletStore(config: WalletConfig): VeilWalletStore {
    const core = new InvisibleWalletCore(config);
    let stopWatchingConnectivity: (() => void) | undefined;

    // `readable`'s start function runs on the first subscriber and its return
    // value runs when the last one leaves, which is exactly the window in
    // which touching localStorage and `window` is safe. Hydrating in the
    // constructor instead would run during SSR, where neither exists.
    const store = readable<WalletState>(core.getState(), (set) => {
        const unsubscribe = core.subscribe(set);
        core.hydrate();
        stopWatchingConnectivity = core.watchConnectivity();

        return () => {
            stopWatchingConnectivity?.();
            stopWatchingConnectivity = undefined;
            unsubscribe();
        };
    });

    return {
        subscribe: store.subscribe,
        destroy: () => {
            stopWatchingConnectivity?.();
            stopWatchingConnectivity = undefined;
        },
        ...core.actions,
    };
}

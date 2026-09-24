/**
 * Vue 3 adapter for the Invisible Wallet SDK.
 *
 * All wallet behaviour lives in the framework-agnostic `InvisibleWalletCore`;
 * this file only binds that core to Vue's reactivity system. The React hook
 * (`invisible-wallet-sdk`) binds the very same core, so the two adapters expose
 * an identical set of actions and can never drift apart.
 *
 * Nothing here — or anywhere in its import graph — touches React.
 */

import {
    computed,
    getCurrentInstance,
    onMounted,
    onUnmounted,
    shallowRef,
    type ComputedRef,
    type Ref,
} from 'vue';

import { InvisibleWalletCore } from '../core';
import type { InvisibleWalletActions, WalletConfig, WalletState } from '../core';

/**
 * What {@link useInvisibleWallet} returns: the wallet's live state as refs,
 * plus every action the React hook exposes.
 */
export type VueInvisibleWallet = InvisibleWalletActions & {
    /**
     * The whole wallet state in a single ref — handy for `watch(state, …)` or
     * for passing the wallet's status around as one value.
     */
    state: Readonly<Ref<WalletState>>;
    /** Soroban contract address of the deployed wallet, or null if not yet registered. */
    address: ComputedRef<string | null>;
    /** True once the wallet contract is confirmed to exist on-chain. */
    isDeployed: ComputedRef<boolean>;
    /** True while any wallet operation is in flight. */
    isPending: ComputedRef<boolean>;
    /** Message of the most recent failure, or null. */
    error: ComputedRef<string | null>;
};

/**
 * Create a passkey wallet bound to Vue reactivity.
 *
 * Call it from `setup()` / `<script setup>` and the wallet follows the
 * component's lifecycle: it restores any persisted session on mount, replays
 * the offline outbox when connectivity returns, and detaches on unmount.
 * Called outside a component (a Pinia store, a plugin, a plain module) it
 * starts immediately and lives as long as you hold on to it.
 *
 * Storage and `window` are only touched after mount, so the composable is safe
 * to call during server-side rendering — wrap any markup that reads wallet
 * state in `<ClientOnly>` (Nuxt) to avoid a hydration mismatch.
 *
 * @param config Network and WebAuthn settings. Pass a `reactive()` object if
 *               you need to switch networks at runtime — every action reads the
 *               config afresh when it runs.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { useInvisibleWallet } from 'invisible-wallet-sdk/vue'
 *
 * const { address, isPending, error, register, login, sendPayment } =
 *   useInvisibleWallet({
 *     factoryAddress: 'CABC…',
 *     rpcUrl: 'https://soroban-testnet.stellar.org',
 *     networkPassphrase: 'Test SDF Network ; September 2015',
 *   })
 * </script>
 *
 * <template>
 *   <p v-if="address">Wallet: {{ address }}</p>
 *   <button v-else :disabled="isPending" @click="register('alice')">
 *     Create wallet
 *   </button>
 * </template>
 * ```
 */
export function useInvisibleWallet(config: WalletConfig): VueInvisibleWallet {
    const core = new InvisibleWalletCore(config);

    // The core replaces its state object wholesale on every change, so there is
    // nothing inside it worth deep-tracking.
    const state = shallowRef<WalletState>(core.getState());
    const unsubscribe = core.subscribe((next) => { state.value = next; });

    const instance = getCurrentInstance();

    if (instance) {
        let stopWatchingConnectivity: (() => void) | undefined;

        onMounted(() => {
            core.hydrate();
            stopWatchingConnectivity = core.watchConnectivity();
        });

        onUnmounted(() => {
            stopWatchingConnectivity?.();
            unsubscribe();
        });
    } else {
        // No lifecycle to hook into. Both calls are no-ops without localStorage
        // and `window`, so this stays safe on the server; the subscription dies
        // with the core once the caller drops this wallet.
        core.hydrate();
        core.watchConnectivity();
    }

    return {
        state,
        address:    computed(() => state.value.address),
        isDeployed: computed(() => state.value.isDeployed),
        isPending:  computed(() => state.value.isPending),
        error:      computed(() => state.value.error),
        ...core.actions,
    };
}

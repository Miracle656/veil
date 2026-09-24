/**
 * Solid.js adapter for the Invisible Wallet SDK.
 *
 * All wallet behaviour lives in the framework-agnostic `InvisibleWalletCore`;
 * this file only binds that core to Solid's reactivity. The React hook, the
 * Vue composable and the Svelte store bind the very same core, so every
 * adapter exposes an identical set of actions and none of them can drift.
 *
 * That sharing is the point rather than a tidiness preference. An adapter that
 * builds its own transactions ends up with its own polling limits and its own
 * idea of when a payment has settled, and the next fix to the signing path
 * lands in one adapter and silently not the others.
 *
 * Nothing here — or anywhere in its import graph — touches React, Vue or
 * Svelte.
 */

import { createSignal, onCleanup, onMount, type Accessor } from 'solid-js';

import { InvisibleWalletCore } from '../core';
import type { InvisibleWalletActions, WalletConfig, WalletState } from '../core';

export type { WalletConfig, WalletState } from '../core';

/**
 * What {@link useInvisibleWallet} returns: the wallet's live state as Solid
 * accessors, plus every action the other adapters expose.
 */
export type SolidInvisibleWallet = InvisibleWalletActions & {
    /** The whole wallet state as one accessor, for `createEffect` on any change. */
    state: Accessor<WalletState>;
    /** Soroban contract address of the deployed wallet, or null if not yet registered. */
    address: Accessor<string | null>;
    /** True once the wallet contract is confirmed to exist on-chain. */
    isDeployed: Accessor<boolean>;
    /** True while any wallet operation is in flight. */
    isPending: Accessor<boolean>;
    /** Message of the most recent failure, or null. */
    error: Accessor<string | null>;
};

/**
 * Create a passkey wallet bound to Solid's reactivity.
 *
 * ```tsx
 * import { useInvisibleWallet } from 'invisible-wallet-sdk/solid';
 *
 * function App() {
 *   const wallet = useInvisibleWallet({
 *     factoryAddress: 'CABC…',
 *     rpcUrl: 'https://soroban-testnet.stellar.org',
 *     networkPassphrase: 'Test SDF Network ; September 2015',
 *   });
 *
 *   return (
 *     <Show when={wallet.address()} fallback={
 *       <button disabled={wallet.isPending()} onClick={() => wallet.register('alice')}>
 *         Create wallet
 *       </button>
 *     }>
 *       <p>Wallet: {wallet.address()}</p>
 *     </Show>
 *   );
 * }
 * ```
 *
 * Called inside a component it follows the component's lifetime: it restores a
 * persisted session on mount, replays the offline outbox when connectivity
 * returns, and detaches on cleanup. Storage and `window` are only touched from
 * `onMount`, which never runs during SSR — so this is safe to call while
 * server-rendering with solid-start.
 *
 * @param config Network and WebAuthn settings.
 */
export function useInvisibleWallet(config: WalletConfig): SolidInvisibleWallet {
    const core = new InvisibleWalletCore(config);

    // The core builds a fresh state object for every real change and stays
    // silent on no-op writes, so Solid's default reference equality is already
    // the right filter here.
    const [state, setState] = createSignal<WalletState>(core.getState());

    const unsubscribe = core.subscribe(setState);
    let stopWatchingConnectivity: (() => void) | undefined;

    onMount(() => {
        core.hydrate();
        stopWatchingConnectivity = core.watchConnectivity();
    });

    onCleanup(() => {
        stopWatchingConnectivity?.();
        unsubscribe();
    });

    return {
        state,
        address:    () => state().address,
        isDeployed: () => state().isDeployed,
        isPending:  () => state().isPending,
        error:      () => state().error,
        ...core.actions,
    };
}

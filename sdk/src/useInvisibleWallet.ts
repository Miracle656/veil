/**
 * React adapter for the Invisible Wallet SDK.
 *
 * All wallet behaviour lives in the framework-agnostic {@link InvisibleWalletCore}
 * (see `./core`); this file only binds that core to React's rendering model.
 * The Vue composable in `invisible-wallet-sdk/vue` binds the very same core, so
 * both adapters expose an identical surface.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { InvisibleWalletCore } from './core';
import type { InvisibleWallet, StorageAdapter, WalletConfig } from './core';

// The public type surface is owned by ./core and re-exported here so that
// `invisible-wallet-sdk` keeps exporting it from the same module as before.
export {
    RecoveryTimelockActive,
    NoGuardianSet,
    RecoveryNotPending,
} from './core';

export type {
    StorageAdapter,
    WalletConfig,
    WebAuthnSignature,
    AuthenticatorAttachment,
    RegisterOptions,
    LoginOptions,
    PortableSigner,
    RegisterResult,
    DeployResult,
    AddSignerResult,
    RotateSignerResult,
    SignerInfo,
    InitiateRecoveryResult,
    WalletState,
    WalletStateListener,
    InvisibleWalletActions,
    InvisibleWallet,
} from './core';

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Mount a passkey wallet in a React component.
 *
 * @param config Network and WebAuthn settings — see {@link WalletConfig}.
 * @returns The wallet's live state plus every wallet action.
 */
export function useInvisibleWallet(config: WalletConfig): InvisibleWallet {
    // One core per storage adapter: the outbox and the PRF cipher belong to the
    // store the wallet was created with, so a different adapter is a different
    // wallet. Every other config field is pushed into the live core below.
    const coreRef    = useRef<InvisibleWalletCore | null>(null);
    const storageRef = useRef<StorageAdapter | undefined>(config.storage);

    if (coreRef.current === null || storageRef.current !== config.storage) {
        coreRef.current    = new InvisibleWalletCore(config);
        storageRef.current = config.storage;
    }
    const core = coreRef.current;

    const state = useSyncExternalStore(core.subscribe, core.getState, core.getState);

    // Keep the core on the latest config. Declared first so the effects below
    // read the config this render was produced with.
    useEffect(() => { core.setConfig(config); });

    // Storage is a client-only concern — restore the persisted address after
    // mount so server-rendered markup and the first client render agree.
    useEffect(() => { core.hydrate(); }, [core]);

    useEffect(() => core.watchConnectivity(), [core, config.autoReplayOnReconnect]);

    return useMemo(() => ({ ...state, ...core.actions }), [state, core]);
}

/**
 * The public type surface of the SDK, in one place.
 *
 * Every alias an integrator is likely to need is re-exported here from its
 * defining module, so `import type { WalletState, RegisterOptions } from
 * 'invisible-wallet-sdk'` resolves against a single, greppable list instead of
 * having to be pulled out of a framework adapter's entry point.
 *
 * `./core` owns the declarations; this file only publishes them. The React
 * hook (`./useInvisibleWallet`) and the subpath adapters (`./vue`, `./angular`,
 * …) re-export from here so none of them can drift from the published shape.
 */

export type {
    /** Storage adapter the wallet persists address/credential/outbox state into. */
    StorageAdapter,
    /** Network and WebAuthn settings every wallet is constructed from. */
    WalletConfig,
    /** Raw WebAuthn assertion signature components (all P-256, all bytes). */
    WebAuthnSignature,
    /** `'platform'` (device-bound passkey) or `'cross-platform'` (roaming FIDO2 key). */
    AuthenticatorAttachment,
    /** Optional knobs for `register()`. */
    RegisterOptions,
    /** Credential ID / known address used by `login()` on a fresh device. */
    LoginOptions,
    /** Persisted roaming (cross-platform) credential usable as a portable signer. */
    PortableSigner,
    /** Result of a successful `register()`. */
    RegisterResult,
    /** Result of a successful `deploy()`. */
    DeployResult,
    /** Result of a successful `addSigner()`. */
    AddSignerResult,
    /** Result of a successful `rotateSigner()`. */
    RotateSignerResult,
    /** One entry from `getSigners()`. */
    SignerInfo,
    /** Result of a successful `initiateRecovery()`. */
    InitiateRecoveryResult,
    /** The observable half of a wallet: the state every adapter mirrors. */
    WalletState,
    /** Callback invoked whenever any `WalletState` field changes. */
    WalletStateListener,
    /** The callable half of a wallet: every action adapters expose. */
    InvisibleWalletActions,
    /** The full wallet surface returned by the React hook and Vue composable. */
    InvisibleWallet,
} from './core';
